using System.Buffers.Binary;
using System.Text.Json;

namespace RemoteControl.Windows;

internal sealed class PacketWriter
{
    private const int MaxPacketBytes = 16 * 1024 * 1024;
    private static readonly Stream Output = Console.OpenStandardOutput();
    private static readonly object Gate = new();

    public static void WriteError(string message) => new PacketWriter().WriteJson(3, new { type = "error", message });

    public void WriteJson<T>(byte type, T value)
    {
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(value);
        Write(type, payload);
    }

    public static void Write(byte type, ReadOnlySpan<byte> payload)
    {
        if (payload.Length > MaxPacketBytes)
            throw new InvalidDataException("Packet exceeds the 16 MiB protocol limit.");
        Span<byte> header = stackalloc byte[5];
        header[0] = type;
        BinaryPrimitives.WriteUInt32BigEndian(header[1..], checked((uint)payload.Length));
        lock (Gate)
        {
            Output.Write(header);
            Output.Write(payload);
            Output.Flush();
        }
    }
}
