type Quality = 'data' | 'balanced24' | 'balanced' | 'high15' | 'high';
type Codec = 'hevc' | 'h264';
type Playback = 'canvas' | 'mse';
type StreamInfo = { codec: Codec; codecString: string; width: number; height: number; fps?: number; format?: string };

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
  private playback: Playback = 'canvas';
  private flowPaused = false;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private mediaErrorHandler?: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastPong = Date.now();
  private lastHeartbeatTick = Date.now();
  private resumeProbeAt = 0;
  private inputQueue: Array<{ kind: 'input'; value: Record<string, unknown> } | { kind: 'text'; value: string; done: () => void }> = [];
  private drainingInput = false;

  get activeCodec(): Codec | undefined { return this.codec; }
  get renderMode(): Playback { return this.playback; }

  constructor(
    private canvas: HTMLCanvasElement,
    private onReady: (codec: Codec) => void,
    private onError: (message: string) => void,
    private onClose: (code: number) => void,
    private video?: HTMLVideoElement,
  ) {}

  async connect(quality: Quality, forcedCodec?: Codec, hevcCodecString = 'hvc1.1.6.L150.B0', hevcMseVideo = false): Promise<void> {
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
      this.lastHeartbeatTick = this.lastPong;
      ws.send(JSON.stringify({ type: 'start', codec: choice!.codec, quality, ...(this.playback === 'mse' ? { format: 'mse' } : {}) }));
      this.startupTimer = setTimeout(() => {
        if (!this.ready && !this.stopped) this.onError(`${this.codec === 'hevc' ? 'HEVC' : 'H.264'} decoding failed to start.`);
      }, hevcMseVideo && choice!.codec === 'hevc' ? 20_000 : 12_000);
      this.heartbeat = setInterval(() => {
        if (this.stopped || ws.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        // A delayed background timer gets one fresh probe, not repeated grace without pong.
        if (now - this.lastHeartbeatTick > 30_000 && this.lastPong >= this.resumeProbeAt) this.resumeProbeAt = now;
        this.lastHeartbeatTick = now;
        if (now - Math.max(this.lastPong, this.resumeProbeAt) > 45_000) { this.close(); this.onClose(1006); return; }
        ws.send(JSON.stringify({ type: 'ping' }));
      }, 15_000);
    };
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data) as { type: string; message?: string } & Partial<StreamInfo>;
          if (message.type === 'pong') { this.lastPong = Date.now(); return; }
          if (message.type === 'error') { this.onError(message.message || 'Capture failed.'); return; }
          if (message.type === 'stream') this.configureStream(message as StreamInfo);
        } catch { this.onError('Video decoder could not start.'); }
      } else if (event.data instanceof ArrayBuffer) {
        if (this.playback === 'mse') this.appendMsePacket(new Uint8Array(event.data));
        else this.decode(new Uint8Array(event.data));
      }
    };
    ws.onerror = () => this.onError('Video connection failed.');
    ws.onclose = (event) => { if (this.heartbeat) clearInterval(this.heartbeat); if (!this.stopped) this.onClose(event.code); };
  }

  private configureStream(message: StreamInfo): void {
    if (message.codec !== this.codec) { this.onError('Video stream codec did not match requested codec.'); return; }
    const expected = this.codec === 'hevc' ? this.codecString : 'avc1.42E032';
    if (message.codecString !== expected || !Number.isInteger(message.width) || !Number.isInteger(message.height) || message.width <= 0 || message.height <= 0) {
      this.onError('Video stream configuration is invalid.');
      return;
    }
    this.fps = message.fps && Number.isFinite(message.fps) && message.fps > 0 ? message.fps : 30;
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
        const context = this.canvas.getContext('2d', { alpha: false });
        if (context) context.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
        frame.close();
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
    if (this.waitingForKey && !key) return;
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
    if (!this.video || source.updating || !source.buffered.length) return;
    const end = source.buffered.end(source.buffered.length - 1);
    if (end - this.video.currentTime > 0.75) this.video.currentTime = Math.max(0, end - 0.15);
    const removeBefore = this.video.currentTime - 2;
    if (removeBefore > 0 && source.buffered.start(0) < removeBefore) {
      try { source.remove(source.buffered.start(0), Math.min(removeBefore, end)); } catch { /* range was already evicted */ }
    }
  }

  private markReady(): void {
    if (!this.ready && this.codec) {
      this.ready = true;
      if (this.startupTimer) { clearTimeout(this.startupTimer); this.startupTimer = undefined; }
      this.onReady(this.codec);
    }
  }

  private decode(packet: Uint8Array): void {
    if (!this.decoder || packet.length < 2) return;
    const key = packet[0] === 1;
    if (this.decoder.decodeQueueSize > 3) {
      this.decoder.reset();
      this.decoder.configure({ codec: this.codecString!, codedWidth: this.canvas.width, codedHeight: this.canvas.height, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true });
      this.waitingForKey = true;
    }
    if (this.waitingForKey && !key) return;
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
      this.video.removeAttribute('src');
      this.video.load();
    }
    if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
  }
}
