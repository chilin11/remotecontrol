declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean });
    scaleViewport: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    qualityLevel: number;
    compressionLevel: number;
    background: string;
    sendCredentials(credentials: { username?: string; password?: string }): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    clipboardPasteFrom(text: string): void;
    disconnect(): void;
    focus(): void;
    blur(): void;
  }
}
