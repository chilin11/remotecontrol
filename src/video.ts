import { parseServerStats, type ServerStats, type VideoStats } from './stats';

export type Quality = '720p30' | '1080p24' | '1080p30' | '1080p60' | '2160p24' | '2160p30' | '2160p60';

/** Same codec, profile, tier and constraints; only the level (5.0–5.2) may differ from what was negotiated. */
export function sameCodecFamily(expected: string | undefined, actual: unknown): actual is string {
  if (!expected || typeof actual !== 'string') return false;
  const avc = /^avc1\.42E0(32|33|34)$/i;
  if (avc.test(expected)) return avc.test(actual);
  const hevc = /^(hvc1\.1\.6)\.L(150|153|156)\.([0-9A-F]{2})$/i;
  const want = hevc.exec(expected), got = hevc.exec(actual);
  return !!want && !!got && want[1] === got[1] && want[3].toUpperCase() === got[3].toUpperCase();
}
type Codec = 'hevc' | 'h264';
type Playback = 'canvas' | 'mse';
// Canvas playout: the most delay added to absorb arrival jitter, and how long a jitter peak is held before the
// buffer shrinks again.
const MAX_PLAYOUT_MS = 250;
const PLAYOUT_HOLD_MS = 5000;
type StreamInfo = { codec: Codec; codecString: string; width: number; height: number; fps?: number; format?: string; encoder?: string };
/** Remote pointer shape: a PNG at `scale` device pixels per CSS pixel, hotspot in CSS pixels. */
export type RemoteCursor = { image: string; x: number; y: number; scale: number };

export function parseRemoteCursor(message: Record<string, unknown>): RemoteCursor | undefined {
  const { image, x, y, scale } = message;
  if (typeof image !== 'string' || image.length > 262_144 || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(image)) return;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof scale !== 'number') return;
  if (!(scale >= 1 && scale <= 4) || !(x >= 0 && x <= 256) || !(y >= 0 && y <= 256)) return;
  return { image, x, y, scale };
}

/** CSS `cursor` value for a remote shape, falling back to the plain arrow where image cursors are unsupported. */
export function cursorStyle(cursor: RemoteCursor | undefined, supports: (value: string) => boolean = (value) => CSS.supports('cursor', value)): string {
  if (!cursor) return 'default';
  const x = Math.round(cursor.x), y = Math.round(cursor.y);
  const url = `url("${cursor.image}")`;
  const candidates = [
    `image-set(${url} ${cursor.scale}x) ${x} ${y}, default`,
    `-webkit-image-set(${url} ${cursor.scale}x) ${x} ${y}, default`,
    // Older engines: unscaled image, hotspot in its pixels.
    `${url} ${Math.round(cursor.x * cursor.scale)} ${Math.round(cursor.y * cursor.scale)}, default`,
  ];
  return candidates.find((value) => { try { return supports(value); } catch { return false; } }) ?? 'default';
}

export class VideoClient {
  private ws?: WebSocket;
  private decoder?: VideoDecoder;
  private mediaSource?: MediaSource;
  private sourceBuffer?: SourceBuffer;
  private mediaUrl?: string;
  private mseQueue: ArrayBuffer[] = [];
  private queuedBytes = 0;
  private sequence = 0;
  private fps = 30;
  private waitingForKey = true;
  private ready = false;
  private stopped = false;
  private codec?: Codec;
  private codecString?: string;
  private encoder?: string;
  private playback: Playback = 'canvas';
  private flowPaused = false;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private mediaErrorHandler?: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastPong = Date.now();
  private lastReceived = Date.now();
  private lastHeartbeatTick = Date.now();
  private resumeProbeAt = 0;
  private inputQueue: Array<{ kind: 'input'; value: Record<string, unknown> } | { kind: 'text'; value: string; done: () => void }> = [];
  private drainingInput = false;
  // Stats for nerds: cumulative counters, cheap enough to keep even when the overlay is hidden.
  private width = 0;
  private height = 0;
  private connectedAt = 0;
  private bytes = 0;
  private packets = 0;
  private keyframes = 0;
  private lastKeyframeBytes = 0;
  private framesRendered = 0;
  private framesDropped = 0;
  private decoderResets = 0;
  private lastDecodeKeyRequest = -Infinity;
  // Canvas playout buffer (see schedulePlayout): chunks waiting for their decode time, and the arrival-delay estimate.
  private playout: { chunk: EncodedVideoChunk; due: number }[] = [];
  private playoutTimer?: ReturnType<typeof setTimeout>;
  private playoutBase?: number;
  private playoutSpread = 0;
  private playoutPeakAt = 0;
  private lastArrival = 0;
  private playoutLate = 0;
  // Each decoding chunk's due time by timestamp, and hitch counters for the gateway's diagnostics log.
  private presentDue = new Map<number, number>();
  private framesLate = 0;
  // Per 5 s report: late frames within half a second after a keyframe, the most a frame was late, and the largest
  // arrival delay above the fastest one (uncapped), i.e. the buffer that would have absorbed every clump.
  private lastKeySequence = -Infinity;
  private lateNearKey = 0;
  private lateMaxMs = 0;
  private jitterPeakMs = 0;
  // Also per report: the longest decode (chunk handed to the decoder until its frame is out) and the longest stall of
  // this page's main thread (a 50 ms timer firing late), to tell a slow decoder or a busy page from a late network.
  private decodeAt = new Map<number, number>();
  private decodeMaxMs = 0;
  private mainBlockMs = 0;
  private lastTick = 0;
  private lastRenderAt = 0;
  private longestRenderGap = 0;
  private diagTimer?: ReturnType<typeof setInterval>;
  private blockTimer?: ReturnType<typeof setInterval>;
  private inputsSent = 0;
  private pingSentAt = 0;
  private rttMs?: number;
  private rttMinMs?: number;
  private serverStats?: ServerStats;

  /** Called when the host reports a new pointer shape (local-cursor streams only). */
  onCursor?: (cursor: RemoteCursor) => void;

  get activeCodec(): Codec | undefined { return this.codec; }
  get renderMode(): Playback { return this.playback; }

  /** Snapshot of cumulative counters; rates are derived by comparing two snapshots. */
  stats(): VideoStats {
    const quality = this.video?.getVideoPlaybackQuality?.();
    let bufferedSec = 0;
    const source = this.sourceBuffer;
    try {
      if (this.video && source?.buffered.length) bufferedSec = Math.max(0, source.buffered.end(source.buffered.length - 1) - this.video.currentTime);
    } catch { /* source buffer was removed */ }
    return {
      at: performance.now(), codec: this.codec, codecString: this.codecString, encoder: this.encoder, playback: this.playback,
      width: this.width, height: this.height, declaredFps: this.fps, connectedMs: this.connectedAt ? Date.now() - this.connectedAt : 0,
      bytes: this.bytes, packets: this.packets, keyframes: this.keyframes, lastKeyframeBytes: this.lastKeyframeBytes,
      framesRendered: this.playback === 'mse' ? quality?.totalVideoFrames ?? 0 : this.framesRendered,
      framesDropped: this.framesDropped + (this.playback === 'mse' ? quality?.droppedVideoFrames ?? 0 : 0),
      decoderResets: this.decoderResets, decodeQueue: this.decoder?.decodeQueueSize ?? 0,
      playoutMs: this.playoutBase === undefined ? 0 : Math.round(this.playoutSpread), framesLate: this.framesLate,
      bufferedSec, queuedBytes: this.queuedBytes,
      rttMs: this.rttMs, rttMinMs: this.rttMinMs, uplinkBuffered: this.ws?.bufferedAmount ?? 0, inputsSent: this.inputsSent, flowPaused: this.flowPaused,
      server: this.serverStats,
    };
  }

  /**
   * Asks the gateway for its counters; only sent while the overlay is open. Also probes RTT every second, because
   * pong queues behind video: the 15 s heartbeat alone would hide the backlog that builds up during motion.
   */
  requestServerStats(): void {
    this.sendImmediate({ type: 'stats' });
    if (!this.pingSentAt) this.ping();
  }

  constructor(
    private canvas: HTMLCanvasElement,
    private onReady: (codec: Codec) => void,
    private onError: (message: string) => void,
    private onClose: (code: number) => void,
    private video?: HTMLVideoElement,
  ) {}

  async connect(quality: Quality, forcedCodec?: Codec, hevcCodecString = 'hvc1.1.6.L150.B0', hevcMseVideo = false, localCursor = false): Promise<void> {
    let choice: { codec: Codec; codecString: string } | undefined;
    if (typeof VideoDecoder !== 'undefined') {
      const candidates: { codec: Codec; codecString: string }[] = [
        { codec: 'hevc', codecString: hevcCodecString },
        { codec: 'h264', codecString: 'avc1.42E032' },
      ];
      for (const candidate of candidates) {
        if (forcedCodec && candidate.codec !== forcedCodec) continue;
        try {
          const result = await VideoDecoder.isConfigSupported({ codec: candidate.codecString });
          if (result.supported) { choice = candidate; break; }
        } catch { /* try next codec */ }
      }
      if (!choice) throw new Error('No supported video decoder.');
      this.playback = 'canvas';
    } else {
      if (typeof MediaSource === 'undefined' || !this.video) {
        throw new Error('This browser needs MediaSource playback on HTTP.');
      }
      const hevcMse = !forcedCodec && hevcMseVideo && hevcCodecString === 'hvc1.1.6.L150.90'
        && MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L150.90"');
      if (hevcMse) {
        choice = { codec: 'hevc', codecString: hevcCodecString };
      } else {
        if (forcedCodec === 'hevc' || !MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E032"')) {
          throw new Error('This browser needs H.264 MediaSource playback on HTTP. HEVC requires WebCodecs or supported Windows HEVC MSE.');
        }
        choice = { codec: 'h264', codecString: 'avc1.42E032' };
      }
      this.playback = 'mse';
    }
    if (this.stopped) return;
    this.codec = choice.codec;
    this.codecString = choice.codecString;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/stream`);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this.lastPong = Date.now();
      this.lastReceived = this.lastPong;
      this.lastHeartbeatTick = this.lastPong;
      this.connectedAt = this.lastPong;
      ws.send(JSON.stringify({ type: 'start', codec: choice!.codec, quality, ...(this.playback === 'mse' ? { format: 'mse' } : {}), ...(localCursor ? { cursor: 'local' } : {}) }));
      this.ping();
      // Playback counters for the host's log, so a stall can be traced to the link, the gateway or this decoder.
      this.diagTimer = setInterval(() => {
        const s = this.stats();
        this.sendImmediate({ type: 'diag', rendered: s.framesRendered, dropped: s.framesDropped, late: s.framesLate ?? 0, resets: s.decoderResets, smoothing: s.playoutMs ?? 0, gap: Math.round(this.longestRenderGap), queue: s.decodeQueue, rtt: Math.round(s.rttMs ?? 0), lateNearKey: this.lateNearKey, lateMax: Math.round(this.lateMaxMs), jitter: Math.round(this.jitterPeakMs), decodeMax: Math.round(this.decodeMaxMs), block: Math.round(this.mainBlockMs) });
        this.longestRenderGap = 0; this.lateNearKey = 0; this.lateMaxMs = 0; this.jitterPeakMs = 0; this.decodeMaxMs = 0; this.mainBlockMs = 0;
      }, 5000);
      this.lastTick = performance.now();
      this.blockTimer = setInterval(() => {
        const now = performance.now();
        this.mainBlockMs = Math.max(this.mainBlockMs, now - this.lastTick - 50);
        this.lastTick = now;
      }, 50);
      this.startupTimer = setTimeout(() => {
        if (!this.ready && !this.stopped) this.onError(`${this.codec === 'hevc' ? 'HEVC' : 'H.264'} decoding failed to start.`);
      }, hevcMseVideo && choice!.codec === 'hevc' ? 20_000 : 12_000);
      this.heartbeat = setInterval(() => {
        if (this.stopped || ws.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        // A delayed background timer gets one fresh probe, not repeated grace without pong.
        if (now - this.lastHeartbeatTick > 30_000 && this.lastPong >= this.resumeProbeAt) this.resumeProbeAt = now;
        this.lastHeartbeatTick = now;
        // Video traffic also proves liveness when pong is delayed behind queued frames.
        if (now - Math.max(this.lastReceived, this.resumeProbeAt) > 45_000) { this.close(); this.onClose(1006); return; }
        this.ping();
      }, 15_000);
    };
    ws.onmessage = (event) => {
      if (this.stopped) return;
      this.lastReceived = Date.now();
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data) as { type: string; message?: string } & Partial<StreamInfo> & Record<string, unknown>;
          if (message.type === 'pong') { this.recordPong(); return; }
          if (message.type === 'stats') { this.serverStats = parseServerStats(message) ?? this.serverStats; return; }
          if (message.type === 'error') { this.onError(message.message || 'Capture failed.'); return; }
          if (message.type === 'cursor') { const cursor = parseRemoteCursor(message); if (cursor) this.onCursor?.(cursor); return; }
          if (message.type === 'stream') this.configureStream(message as StreamInfo);
        } catch { this.onError('Video decoder could not start.'); }
      } else if (event.data instanceof ArrayBuffer) {
        this.bytes += event.data.byteLength;
        this.packets++;
        if (this.playback === 'mse') this.appendMsePacket(new Uint8Array(event.data));
        else this.decode(new Uint8Array(event.data));
      }
    };
    ws.onerror = () => this.onError('Video connection failed.');
    ws.onclose = (event) => { if (this.heartbeat) clearInterval(this.heartbeat); if (this.diagTimer) clearInterval(this.diagTimer); if (this.blockTimer) clearInterval(this.blockTimer); if (!this.stopped) this.onClose(event.code); };
  }

  private ping(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    this.pingSentAt = performance.now();
    ws.send(JSON.stringify({ type: 'ping' }));
  }

  private recordPong(): void {
    this.lastPong = Date.now();
    if (!this.pingSentAt) return;
    // Pong queues behind video frames, so this is application RTT: network plus send backlog.
    const rtt = performance.now() - this.pingSentAt;
    this.pingSentAt = 0;
    this.rttMs = this.rttMs === undefined ? rtt : this.rttMs * 0.6 + rtt * 0.4;
    this.rttMinMs = Math.min(this.rttMinMs ?? rtt, rtt);
  }

  private configureStream(message: StreamInfo): void {
    if (message.codec !== this.codec) { this.onError('Video stream codec did not match requested codec.'); return; }
    // The agent raises the level (5.0–5.2) for 4K60; profile/tier/constraints must still match what was negotiated.
    const expected = this.codec === 'hevc' ? this.codecString : 'avc1.42E032';
    if (!sameCodecFamily(expected, message.codecString) || !Number.isInteger(message.width) || !Number.isInteger(message.height) || message.width <= 0 || message.height <= 0) {
      this.onError('Video stream configuration is invalid.');
      return;
    }
    this.codecString = message.codecString;
    this.fps = message.fps && Number.isFinite(message.fps) && message.fps > 0 ? message.fps : 30;
    this.encoder = typeof message.encoder === 'string' && /^[a-z0-9]{1,16}$/.test(message.encoder) ? message.encoder : undefined;
    this.width = message.width;
    this.height = message.height;
    if (this.playback === 'mse') {
      if (message.format !== 'mse') { this.onError('The server did not provide an MSE stream.'); return; }
      this.setupMediaSource(message.width, message.height);
      return;
    }
    this.canvas.width = message.width;
    this.canvas.height = message.height;
    this.configureDecoder(message.codecString);
  }

  private configureDecoder(codecString: string): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = new VideoDecoder({
      output: (frame) => this.drawFrame(frame),
      error: () => this.onError('Video decoding failed.'),
    });
    this.codecString = codecString;
    this.resetPlayout();
    this.decoder.configure({ codec: codecString, codedWidth: this.canvas.width, codedHeight: this.canvas.height, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true });
    this.waitingForKey = true;
  }

  private setupMediaSource(width: number, height: number): void {
    if (!this.video || typeof MediaSource === 'undefined') { this.onError('MSE video playback is not available.'); return; }
    const mediaSource = new MediaSource();
    this.mediaSource = mediaSource;
    this.video.width = width;
    this.video.height = height;
    this.video.muted = true;
    this.video.playsInline = true;
    this.mediaUrl = URL.createObjectURL(mediaSource);
    this.video.src = this.mediaUrl;
    mediaSource.addEventListener('sourceopen', () => {
      if (this.stopped || !this.codecString || mediaSource.readyState !== 'open') return;
      try {
        const source = mediaSource.addSourceBuffer(`video/mp4; codecs="${this.codecString}"`);
        source.mode = 'segments';
        source.addEventListener('updateend', () => {
          this.trimMseBuffer(source);
          this.drainMseQueue();
        });
        source.addEventListener('error', () => this.onError(`${this.codec === 'hevc' ? 'HEVC' : 'H.264'} decoding failed in MediaSource.`));
        this.sourceBuffer = source;
        this.drainMseQueue();
        void this.video?.play().catch(() => undefined);
      } catch {
        this.onError(`${this.codec === 'hevc' ? 'HEVC' : 'H.264'} decoder rejected the MSE stream.`);
      }
    }, { once: true });
    this.mediaErrorHandler = () => {
      if (!this.stopped) this.onError(`${this.codec === 'hevc' ? 'HEVC' : 'H.264'} decoding failed in the video element.`);
    };
    this.video.addEventListener('error', this.mediaErrorHandler);
    this.video.addEventListener('playing', () => {
      if (this.video?.requestVideoFrameCallback) this.video.requestVideoFrameCallback(() => this.markReady());
      else if (this.video && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) this.markReady();
    }, { once: true });
  }

  private appendMsePacket(packet: Uint8Array): void {
    if (packet.length < 2 || !this.video) return;
    if (packet[0] === 0) {
      const init = packet.slice(1).buffer;
      this.mseQueue.unshift(init);
      this.queuedBytes += init.byteLength;
      this.drainMseQueue();
      return;
    }
    if (packet[0] !== 1 || packet.length < 3) return;
    const key = packet[1] === 1;
    if (key) { this.keyframes++; this.lastKeyframeBytes = packet.length - 2; }
    if (this.waitingForKey && !key) { this.framesDropped++; return; }
    if (key) this.waitingForKey = false;
    const segment = packet.slice(2).buffer;
    this.mseQueue.push(segment);
    this.queuedBytes += segment.byteLength;
    if (this.queuedBytes > 4 * 1024 * 1024 && !this.flowPaused) {
      this.flowPaused = true;
      this.sendImmediate({ type: 'flow', paused: true });
    }
    this.drainMseQueue();
  }

  private drainMseQueue(): void {
    const source = this.sourceBuffer;
    if (!source || source.updating || !this.mseQueue.length || this.stopped) return;
    const segment = this.mseQueue.shift()!;
    this.queuedBytes -= segment.byteLength;
    try {
      source.appendBuffer(segment);
    } catch {
      this.onError(`${this.codec === 'hevc' ? 'HEVC' : 'H.264'} decoding failed while appending MSE data.`);
      return;
    }
    if (this.flowPaused && this.queuedBytes < 512 * 1024) {
      this.flowPaused = false;
      this.waitingForKey = true;
      this.sendImmediate({ type: 'flow', paused: false });
    }
  }

  private trimMseBuffer(source: SourceBuffer): void {
    const video = this.video;
    if (!video || source.updating || !source.buffered.length) return;
    const end = source.buffered.end(source.buffered.length - 1);
    // MSE plays its own timeline, but frames arrive on the host's clock: a capture running a little under the declared
    // rate drains the buffer and playback stalls (fps drops to 0, then recovers), a little over builds input lag.
    // Steer the speed around a small cushion instead of only ever speeding up; seek only when far behind.
    const frame = 1 / this.fps;
    const target = Math.max(0.05, 3 * frame);
    const lag = end - video.currentTime;
    let rate = video.playbackRate;
    if (lag > Math.max(0.5, 15 * frame)) {
      video.currentTime = Math.max(0, end - target);
      rate = 1;
    } else {
      // 0.05 steps: playbackRate changes are not free, so do not touch it on every frame.
      rate = Math.round(Math.min(1.5, Math.max(0.85, 1 + 2 * (lag - target))) * 20) / 20;
    }
    if (video.playbackRate !== rate) video.playbackRate = rate;
    const removeBefore = video.currentTime - 2;
    if (removeBefore > 0 && source.buffered.start(0) < removeBefore) {
      try { source.remove(source.buffered.start(0), Math.min(removeBefore, end)); } catch { /* range was already evicted */ }
    }
  }

  private markReady(): void {
    if (!this.stopped && !this.ready && this.codec) {
      this.ready = true;
      if (this.startupTimer) { clearTimeout(this.startupTimer); this.startupTimer = undefined; }
      this.onReady(this.codec);
    }
  }

  private decode(packet: Uint8Array): void {
    if (!this.decoder || packet.length < 2) return;
    const key = packet[0] === 1;
    if (key) { this.keyframes++; this.lastKeyframeBytes = packet.length - 1; }
    const queued = this.decoder.decodeQueueSize;
    const softLimit = Math.max(4, Math.round(this.fps * 0.15));
    const hardLimit = Math.max(12, Math.round(this.fps * 0.4));
    // A short delivery burst (frames held up in a tunnel arriving together) drains normally and needs no keyframe:
    // the host sends keyframes only on request, and one is hundreds of KB on a link that is already backed up.
    // If it is still behind when a keyframe arrives, restart on that very packet (no frozen wait for another one).
    // Only severe overload discards deltas before a recovery point is available.
    if (queued > hardLimit || (key && queued > softLimit)) {
      this.framesDropped += this.decoder.decodeQueueSize + this.playout.length;
      this.decoderResets++;
      this.decoder.reset();
      this.decoder.configure({ codec: this.codecString!, codedWidth: this.canvas.width, codedHeight: this.canvas.height, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true });
      this.resetPlayout();
      this.waitingForKey = true;
      if (!key) this.requestDecodeKeyframe();
    }
    if (this.waitingForKey && !key) { this.framesDropped++; return; }
    if (key) { this.waitingForKey = false; this.lastKeySequence = this.sequence + 1; }
    const chunk = new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: Math.round((++this.sequence * 1_000_000) / this.fps), data: packet.subarray(1) });
    this.schedulePlayout(chunk, performance.now());
  }

  /**
   * Playout buffer. The host sends exactly one frame per interval, so a chunk's timestamp is the host's clock; but
   * a tunnel (cloudflared, HTTP/2, QUIC) or a large keyframe delivers frames in clumps. Decoding on arrival then draws
   * several frames in one display refresh and holds the last one: the frame rate looks fine yet motion stutters.
   * Each frame is due at its timestamp plus an offset covering the recent arrival spread, so clumps are spread back
   * out. On a steady link the spread, and the added delay, stays near zero.
   */
  private schedulePlayout(chunk: EncodedVideoChunk, now: number): void {
    const media = chunk.timestamp / 1000;
    const delay = now - media;
    const elapsed = now - this.lastArrival;
    this.lastArrival = now;
    const over = this.playoutBase === undefined ? 0 : delay - this.playoutBase;
    this.jitterPeakMs = Math.max(this.jitterPeakMs, over);
    // Frames dropped upstream shift the host clock: every later frame is late beyond the cap and would go unpaced.
    this.playoutLate = over > MAX_PLAYOUT_MS ? this.playoutLate + 1 : 0;
    if (this.playoutBase === undefined || over > 1000 || this.playoutLate > this.fps / 2) {
      // First frame, a long gap, or half a second of persistently late frames: restart the estimate at this frame.
      this.playoutLate = 0;
      this.playoutBase = delay;
      this.playoutSpread = 0;
      this.playoutPeakAt = now;
    } else {
      // The fastest arrival, slowly forgotten (2 ms/s) so a lasting latency rise is absorbed without a step. A new
      // fastest arrival keeps the absolute offset: the frames that defined the spread were still that late.
      const base = this.playoutBase + elapsed * 0.002;
      if (delay < base) this.playoutSpread = Math.max(0, Math.min(MAX_PLAYOUT_MS, this.playoutSpread + this.playoutBase - delay));
      this.playoutBase = Math.min(delay, base);
      // The spread jumps up to cover a late frame and holds that peak for a while: tunnel stalls and keyframes recur
      // every few seconds, and a buffer that had already shrunk again would stutter on each one. Then it eases down
      // at 10 ms/s, an invisible 1 % speed-up.
      const sample = delay - this.playoutBase;
      if (sample >= this.playoutSpread) { this.playoutSpread = Math.min(MAX_PLAYOUT_MS, sample); this.playoutPeakAt = now; }
      else if (now - this.playoutPeakAt > PLAYOUT_HOLD_MS) this.playoutSpread = Math.max(sample, this.playoutSpread - elapsed * 0.01);
    }
    this.playout.push({ chunk, due: media + this.playoutBase + this.playoutSpread });
    if (!this.playoutTimer) this.pumpPlayout();
  }

  private pumpPlayout(): void {
    this.playoutTimer = undefined;
    const now = performance.now();
    // A background tab throttles timers to about 1 Hz: never hold more than a second of video.
    while (this.playout.length && (this.playout[0].due <= now + 1 || this.playout.length > this.fps)) {
      const { chunk, due } = this.playout.shift()!;
      if (this.presentDue.size > 64) this.presentDue.clear();
      this.presentDue.set(chunk.timestamp, due);
      if (this.decodeAt.size > 64) this.decodeAt.clear();
      this.decodeAt.set(chunk.timestamp, now);
      try { this.decoder?.decode(chunk); } catch { this.onError('Video decoder rejected a frame.'); return; }
    }
    if (this.playout.length) this.playoutTimer = setTimeout(() => this.pumpPlayout(), this.playout[0].due - now);
  }

  /** Draws a decoded frame at once: holding decoder output frames can starve the hardware decoder's small pool. */
  private drawFrame(frame: VideoFrame): void {
    const now = performance.now();
    const due = this.presentDue.get(frame.timestamp) ?? now;
    this.presentDue.delete(frame.timestamp);
    const decodedFrom = this.decodeAt.get(frame.timestamp);
    if (decodedFrom !== undefined) { this.decodeMaxMs = Math.max(this.decodeMaxMs, now - decodedFrom); this.decodeAt.delete(frame.timestamp); }
    // A frame shown more than an interval after it was due is a visible hitch the playout buffer did not absorb.
    if (now - due > 1000 / this.fps) {
      this.framesLate++;
      this.lateMaxMs = Math.max(this.lateMaxMs, now - due);
      if (Math.round(frame.timestamp * this.fps / 1_000_000) - this.lastKeySequence <= this.fps / 2) this.lateNearKey++;
    }
    if (this.framesRendered) this.longestRenderGap = Math.max(this.longestRenderGap, now - this.lastRenderAt);
    this.lastRenderAt = now;
    // desynchronized: draw straight to the screen instead of waiting for the next compositor frame.
    const context = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (context) context.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    frame.close();
    this.framesRendered++;
    this.markReady();
  }

  private resetPlayout(): void {
    if (this.playoutTimer) { clearTimeout(this.playoutTimer); this.playoutTimer = undefined; }
    this.presentDue.clear();
    this.decodeAt.clear();
    this.playout = [];
    this.playoutBase = undefined;
    this.playoutSpread = 0;
    this.playoutLate = 0;
  }

  private requestDecodeKeyframe(): void {
    const now = Date.now();
    if (now - this.lastDecodeKeyRequest < 1000) return;
    this.lastDecodeKeyRequest = now;
    this.sendImmediate({ type: 'keyframe' });
  }

  sendInput(value: Record<string, unknown>): void {
    if (this.drainingInput || this.inputQueue.length) {
      const last = this.inputQueue.at(-1);
      if (value.type === 'move' && last?.kind === 'input' && last.value.type === 'move') this.inputQueue.pop();
      if (this.inputQueue.length >= 128) { this.ws?.close(); return; }
      this.inputQueue.push({ kind: 'input', value });
      void this.drainInputQueue();
      return;
    }
    this.sendImmediate(value);
  }

  private sendImmediate(value: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 64 * 1024) {
      if (value.type === 'move' || value.type === 'wheel' || value.type === 'keyframe' || value.type === 'diag') return;
      ws.close();
      return;
    }
    ws.send(JSON.stringify(value));
    if (value.type !== 'ping' && value.type !== 'stats' && value.type !== 'flow' && value.type !== 'keyframe' && value.type !== 'diag') this.inputsSent++;
  }

  sendText(text: string): Promise<void> {
    if (this.stopped || text.length > 16_384 || this.inputQueue.length >= 128) {
      this.onError('Text is too long or the input queue is full.');
      return Promise.resolve();
    }
    return new Promise<void>((done) => {
      this.inputQueue.push({ kind: 'text', value: text, done });
      void this.drainInputQueue();
    });
  }

  private async drainInputQueue(): Promise<void> {
    if (this.drainingInput) return;
    this.drainingInput = true;
    try {
      while (this.inputQueue.length && !this.stopped) {
        const item = this.inputQueue.shift()!;
        if (item.kind === 'input') { this.sendImmediate(item.value); continue; }
        try {
          const chars = Array.from(item.value);
          for (let i = 0; i < chars.length; i += 16) {
            const ws = this.ws;
            if (!ws || ws.readyState !== WebSocket.OPEN || this.stopped) break;
            let attempts = 0;
            while (ws.bufferedAmount > 32 * 1024 && !this.stopped && ws.readyState === WebSocket.OPEN) {
              if (++attempts > 250) { ws.close(); break; }
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            if (this.stopped || ws.readyState !== WebSocket.OPEN) break;
            this.sendImmediate({ type: 'text', text: chars.slice(i, i + 16).join('') });
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        } finally { item.done(); }
      }
    } finally {
      this.drainingInput = false;
      if (this.stopped) for (const item of this.inputQueue.splice(0)) if (item.kind === 'text') item.done();
    }
  }
  close(): void {
    if (this.stopped) return;
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
    if (this.diagTimer) { clearInterval(this.diagTimer); this.diagTimer = undefined; }
    if (this.blockTimer) { clearInterval(this.blockTimer); this.blockTimer = undefined; }
    if (this.startupTimer) { clearTimeout(this.startupTimer); this.startupTimer = undefined; }
    this.stopped = true;
    this.resetPlayout();
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) this.ws.close();
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.mseQueue = [];
    for (const item of this.inputQueue.splice(0)) if (item.kind === 'text') item.done();
    this.queuedBytes = 0;
    if (this.mediaSource?.readyState === 'open') {
      try { this.mediaSource.endOfStream(); } catch { /* source may be updating */ }
    }
    if (this.video) {
      if (this.mediaErrorHandler) { this.video.removeEventListener('error', this.mediaErrorHandler); this.mediaErrorHandler = undefined; }
      this.video.pause();
      this.video.playbackRate = 1;
      this.video.removeAttribute('src');
      this.video.load();
    }
    if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
  }
}
