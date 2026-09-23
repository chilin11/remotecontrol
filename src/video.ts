type Quality = 'data' | 'balanced' | 'high';
type Codec = 'hevc' | 'h264';

export class VideoClient {
  private ws?: WebSocket;
  private decoder?: VideoDecoder;
  private sequence = 0;
  private fps = 30;
  private waitingForKey = true;
  private ready = false;
  private stopped = false;
  private codec?: Codec;
  private codecString?: string;

  get activeCodec(): Codec | undefined { return this.codec; }

  constructor(private canvas: HTMLCanvasElement, private onReady: (codec: Codec) => void, private onError: (message: string) => void, private onClose: () => void) {}

  async connect(quality: Quality, forcedCodec?: Codec): Promise<void> {
    if (typeof VideoDecoder === 'undefined') throw new Error('This browser does not support WebCodecs video decoding. Use VNC fallback.');
    const candidates: { codec: Codec; codecString: string }[] = [
      { codec: 'hevc', codecString: 'hvc1.1.6.L150.B0' },
      { codec: 'h264', codecString: 'avc1.42E032' },
    ];
    let choice: typeof candidates[number] | undefined;
    for (const candidate of candidates) {
      if (forcedCodec && candidate.codec !== forcedCodec) continue;
      try {
        const result = await VideoDecoder.isConfigSupported({ codec: candidate.codecString, codedWidth: 1920, codedHeight: 1080 });
        if (result.supported) { choice = candidate; break; }
      } catch { /* next codec */ }
    }
    if (!choice) throw new Error('No supported video decoder. Use VNC fallback.');
    if (this.stopped) return;
    this.codec = choice.codec;
    this.codecString = choice.codecString;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/stream`);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(JSON.stringify({ type: 'start', codec: choice.codec, quality }));
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data) as { type: string; codec?: Codec; codecString?: string; width?: number; height?: number; fps?: number; message?: string };
          if (message.type === 'error') { this.onError(message.message || 'Capture failed.'); return; }
          if (message.type === 'stream' && message.codecString && message.width && message.height) {
            this.canvas.width = message.width;
            this.canvas.height = message.height;
            this.fps = message.fps || 30;
            this.configureDecoder(message.codecString);
          }
        } catch { this.onError('Video decoder could not start.'); }
      } else if (event.data instanceof ArrayBuffer) this.decode(new Uint8Array(event.data));
    };
    ws.onerror = () => this.onError('Video connection failed.');
    ws.onclose = () => { if (!this.stopped) this.onClose(); };
  }

  private configureDecoder(codecString: string): void {
    this.decoder?.close();
    this.decoder = new VideoDecoder({
      output: (frame) => {
        const context = this.canvas.getContext('2d', { alpha: false });
        if (context) context.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
        frame.close();
        if (!this.ready && this.codec) { this.ready = true; this.onReady(this.codec); }
      },
      error: () => this.onError('Video decoding failed. Try VNC fallback.'),
    });
    this.codecString = codecString;
    this.decoder.configure({ codec: codecString, codedWidth: this.canvas.width, codedHeight: this.canvas.height, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true });
    this.waitingForKey = true;
  }

  private decode(packet: Uint8Array): void {
    if (!this.decoder || packet.length < 2) return;
    const key = packet[0] === 1;
    if (this.decoder.decodeQueueSize > 3) {
      this.decoder.reset();
      this.waitingForKey = true;
    }
    if (this.waitingForKey && !key) return;
    if (key) this.waitingForKey = false;
    const chunk = new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: Math.round((++this.sequence * 1_000_000) / this.fps), data: packet.subarray(1) });
    try { this.decoder.decode(chunk); } catch { this.onError('Video decoder rejected a frame. Try VNC fallback.'); }
  }

  sendInput(value: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(value));
  }

  close(): void {
    this.stopped = true;
    this.ws?.close();
    this.decoder?.close();
  }
}
