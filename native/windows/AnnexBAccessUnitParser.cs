namespace RemoteControl.Windows;

/// <summary>
/// Splits continuous Annex-B H.264/HEVC output at AUD NALs. Parameter sets (H.264 SPS/PPS, HEVC VPS/SPS/PPS)
/// are cached and placed right after the AUD of every keyframe, because GPU encoders may emit them only once.
/// </summary>
internal sealed class AnnexBAccessUnitParser
{
    private const int MaxNalOrAccessUnitBytes = 16 * 1024 * 1024;
    private readonly string codec;
    private readonly bool isHevc;
    // Unconsumed FFmpeg bytes live in buffer[start..end); avoids per-byte List<byte> growth.
    private byte[] buffer = new byte[256 * 1024];
    private int start;
    private int end;
    // Offset (relative to start) to resume searching for the next start code; 0 = not yet aligned.
    private int resume;
    private readonly MemoryStream accessUnit = new();
    private bool accessUnitHasKeyframe;
    private bool accessUnitHasVcl;
    // H.264: [SPS, PPS]; HEVC: [VPS, SPS, PPS].
    private readonly byte[]?[] parameterSets;
    private readonly Action? onFirstFrame;

    public AnnexBAccessUnitParser(string codec, Action? onFirstFrame = null)
    {
        this.codec = codec;
        isHevc = codec == "hevc";
        parameterSets = new byte[]?[isHevc ? 3 : 2];
        this.onFirstFrame = onFirstFrame;
    }

    /// <summary>True once at least one access unit was written to the gateway.</summary>
    public bool EmittedFrames { get; private set; }

    public void Push(ReadOnlySpan<byte> chunk)
    {
        Append(chunk);
        ParseCompleteNals();
        if (end - start > MaxNalOrAccessUnitBytes)
            throw new InvalidDataException($"FFmpeg emitted an oversized or unframed {codec} NAL unit.");
    }

    public void Finish()
    {
        ParseCompleteNals();
        ReadOnlySpan<byte> data = buffer.AsSpan(start, end - start);
        int first = FindStartCode(data, 0, out _);
        if (first >= 0) ProcessNal(data[first..].ToArray());
        start = end = resume = 0;
        EmitAccessUnit();
    }

    private void Append(ReadOnlySpan<byte> chunk)
    {
        int length = end - start;
        if (end + chunk.Length > buffer.Length)
        {
            if (length + chunk.Length > buffer.Length)
            {
                var larger = new byte[Math.Max(buffer.Length * 2, length + chunk.Length)];
                buffer.AsSpan(start, length).CopyTo(larger);
                buffer = larger;
            }
            else buffer.AsSpan(start, length).CopyTo(buffer);
            start = 0;
            end = length;
        }
        chunk.CopyTo(buffer.AsSpan(end));
        end += chunk.Length;
    }

    private void ParseCompleteNals()
    {
        while (true)
        {
            ReadOnlySpan<byte> data = buffer.AsSpan(start, end - start);
            if (resume == 0)
            {
                int first = FindStartCode(data, 0, out int firstLength);
                if (first < 0)
                {
                    // Keep a possible partial start code at the tail.
                    start = end - Math.Min(3, data.Length);
                    return;
                }
                start += first;
                data = data[first..];
                resume = firstLength;
            }
            int next = FindStartCode(data, resume, out _);
            if (next < 0)
            {
                // Bytes before the last 3 were fully checked; a start code may still straddle the tail.
                resume = Math.Max(resume, data.Length - 3);
                return;
            }
            ProcessNal(data[..next].ToArray());
            start += next;
            resume = 0;
            if (start == end) { start = end = 0; return; }
        }
    }

    private void ProcessNal(byte[] nal)
    {
        _ = FindStartCode(nal, 0, out int prefixLength);
        if (prefixLength == 0 || nal.Length <= prefixLength) return;
        byte nalType = isHevc
            ? (byte)((nal[prefixLength] >> 1) & 0x3f)
            : (byte)(nal[prefixLength] & 0x1f);
        int parameterSet = isHevc
            ? (nalType is >= 32 and <= 34 ? nalType - 32 : -1)
            : (nalType == 7 ? 0 : nalType == 8 ? 1 : -1);
        if (parameterSet >= 0)
        {
            // Keep parameter sets out of a preceding frame if the encoder emits them before AUD.
            parameterSets[parameterSet] = nal;
            return;
        }
        bool isAud = isHevc ? nalType == 35 : nalType == 9;
        bool isVcl = isHevc ? nalType <= 31 : nalType == 1 || nalType == 5;
        bool isKeyframe = isHevc ? nalType is >= 16 and <= 23 : nalType == 5;
        if (isAud && accessUnitHasVcl) EmitAccessUnit();
        accessUnit.Write(nal);
        if (isVcl) accessUnitHasVcl = true;
        if (isKeyframe) accessUnitHasKeyframe = true;
        if (accessUnit.Length > MaxNalOrAccessUnitBytes)
            throw new InvalidDataException($"FFmpeg emitted an oversized {codec} access unit.");
    }

    private void EmitAccessUnit()
    {
        if (accessUnit.Length == 0) return;
        // An AUD/SEI-only unit (e.g. an encoder that exits before its first picture) is not a frame:
        // drop it so stream metadata is not announced and the agent can still fall back.
        if (!accessUnitHasVcl)
        {
            accessUnit.SetLength(0);
            accessUnitHasKeyframe = false;
            return;
        }
        if (accessUnitHasKeyframe && parameterSets.Any(set => set is null))
            throw new InvalidDataException($"{codec} encoder key access unit is missing {(isHevc ? "VPS/SPS/PPS" : "SPS/PPS")} parameter sets.");
        long parameterBytes = accessUnitHasKeyframe ? parameterSets.Sum(set => (long)set!.Length) : 0;
        long totalNalBytes = accessUnit.Length + parameterBytes;
        if (totalNalBytes + 1 > MaxNalOrAccessUnitBytes)
            throw new InvalidDataException($"{codec} access unit exceeds the packet size limit.");
        byte[] payload = new byte[checked((int)totalNalBytes + 1)];
        payload[0] = accessUnitHasKeyframe ? (byte)1 : (byte)0;
        byte[] accessUnitBytes = accessUnit.ToArray();
        int parameterSetInsertOffset = 0;
        if (accessUnitHasKeyframe)
        {
            int firstNalStart = FindStartCode(accessUnitBytes, 0, out int firstPrefixLength);
            if (firstNalStart == 0 && accessUnitBytes.Length > firstPrefixLength && IsAud(accessUnitBytes[firstPrefixLength]))
            {
                int afterAud = FindStartCode(accessUnitBytes, firstPrefixLength, out _);
                parameterSetInsertOffset = afterAud < 0 ? accessUnitBytes.Length : afterAud;
            }
        }
        int destinationOffset = 1;
        Buffer.BlockCopy(accessUnitBytes, 0, payload, destinationOffset, parameterSetInsertOffset);
        destinationOffset += parameterSetInsertOffset;
        if (accessUnitHasKeyframe)
        {
            foreach (byte[]? set in parameterSets)
            {
                Buffer.BlockCopy(set!, 0, payload, destinationOffset, set!.Length);
                destinationOffset += set.Length;
            }
        }
        Buffer.BlockCopy(accessUnitBytes, parameterSetInsertOffset, payload, destinationOffset,
            accessUnitBytes.Length - parameterSetInsertOffset);
        if (!EmittedFrames)
        {
            onFirstFrame?.Invoke();
            EmittedFrames = true;
        }
        PacketWriter.Write(2, payload);
        accessUnit.SetLength(0);
        accessUnitHasKeyframe = false;
        accessUnitHasVcl = false;
    }

    private bool IsAud(byte header) => isHevc ? ((header >> 1) & 0x3f) == 35 : (header & 0x1f) == 9;

    private static int FindStartCode(ReadOnlySpan<byte> bytes, int from, out int length)
    {
        int i = Math.Max(0, from);
        while (i + 2 < bytes.Length)
        {
            int zero = bytes[i..].IndexOf((byte)0);
            if (zero < 0) break;
            i += zero;
            if (i + 2 >= bytes.Length) break;
            if (bytes[i + 1] != 0) { i += 2; continue; }
            if (i + 3 < bytes.Length && bytes[i + 2] == 0 && bytes[i + 3] == 1)
            {
                length = 4;
                return i;
            }
            if (bytes[i + 2] == 1)
            {
                length = 3;
                return i;
            }
            i++;
        }
        length = 0;
        return -1;
    }
}
