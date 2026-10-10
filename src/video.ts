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
    ws.onclose = (event) => { if (this.heartbeat) clearInterval(this.heartbeat); if (!this.stopped) this.onClose(event.code); };
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
      output: (frame) => {
        // desynchronized: draw straight to the screen instead of waiting for the next compositor frame.
        const context = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
        if (context) context.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
        frame.close();
        this.framesRendered++;
        this.markReady();
      },
      error: () => this.onError('Video decoding failed.'),
    });
    this.codecString = codecString;
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
    // MSE plays at 1x, so any burst (Wi-Fi hiccup, large keyframe) would otherwise stay as permanent
    // input lag. But a play head held right at the newest frame runs dry on every bit of network jitter, and each
    // underflow is a visible hitch; seeks and rate changes hitch too. Keep a small cushion, catch up gently,
    // and jump only when clearly behind.
    const frame = 1 / this.fps;
    const lag = end - video.currentTime;
    let rate = video.playbackRate;
    if (lag > Math.max(0.4, 12 * frame)) {
      video.currentTime = Math.max(0, end - 2 * frame);
      rate = 1;
    } else if (lag > Math.max(0.12, 4 * frame)) rate = Math.min(1.5, 1 + lag);
    else if (lag < Math.max(0.06, 2 * frame)) rate = 1;
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
    // Decoder is behind: drop the backlog and resume at the next keyframe. That freezes the picture until the
    // next keyframe (up to 1 s), so tolerate ~150 ms of queue (9 frames at 60 fps) before giving up on it.
    if (this.decoder.decodeQueueSize > Math.max(4, Math.round(this.fps * 0.15))) {
      this.framesDropped += this.decoder.decodeQueueSize;
      this.decoderResets++;
      this.decoder.reset();
      this.decoder.configure({ codec: this.codecString!, codedWidth: this.canvas.width, codedHeight: this.canvas.height, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true });
      this.waitingForKey = true;
    }
    if (this.waitingForKey && !key) { this.framesDropped++; return; }
    if (key) this.waitingForKey = false;
    const chunk = new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: Math.round((++this.sequence * 1_000_000) / this.fps), data: packet.subarray(1) });
    try { this.decoder.decode(chunk); } catch { this.onError('Video decoder rejected a frame.'); }
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
      if (value.type === 'move' || value.type === 'wheel') return;
      ws.close();
      return;
    }
    ws.send(JSON.stringify(value));
    if (value.type !== 'ping' && value.type !== 'stats' && value.type !== 'flow') this.inputsSent++;
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
    if (this.startupTimer) { clearTimeout(this.startupTimer); this.startupTimer = undefined; }
    this.stopped = true;
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
