// Stats for nerds: pure helpers shared by the video client and the overlay.
export type ServerStats = {
  framesIn: number; framesSent: number; framesDropped: number; bytesSent: number; keyframes: number;
  buffered: number; rssMb: number; load?: number; uptimeMs: number;
};

export type VideoStats = {
  at: number;
  codec?: 'hevc' | 'h264'; codecString?: string; playback: 'canvas' | 'mse';
  width: number; height: number; declaredFps: number; connectedMs: number;
  bytes: number; packets: number; keyframes: number; lastKeyframeBytes: number;
  framesRendered: number; framesDropped: number; decoderResets: number;
  decodeQueue: number; bufferedSec: number; queuedBytes: number;
  rttMs?: number; rttMinMs?: number; uplinkBuffered: number; inputsSent: number; flowPaused: boolean;
  server?: ServerStats;
};

export type StatsRates = { bitrateKbps: number; fps: number; dropPerSec: number; rttMs?: number; serverFps?: number };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Validates a gateway `stats` message; anything malformed is ignored rather than displayed. */
export function parseServerStats(value: Record<string, unknown>): ServerStats | undefined {
  const keys = ['framesIn', 'framesSent', 'framesDropped', 'bytesSent', 'keyframes', 'buffered', 'rssMb', 'uptimeMs'] as const;
  if (!keys.every((key) => finite(value[key]))) return undefined;
  const result = Object.fromEntries(keys.map((key) => [key, value[key] as number])) as ServerStats;
  if (finite(value.load)) result.load = value.load;
  return result;
}

/** Per-second rates between two cumulative snapshots of the same connection. */
export function rates(previous: VideoStats | undefined, next: VideoStats): StatsRates {
  const empty: StatsRates = { bitrateKbps: 0, fps: 0, dropPerSec: 0, rttMs: next.rttMs };
  if (!previous || next.at <= previous.at || next.bytes < previous.bytes || next.framesRendered < previous.framesRendered) return empty;
  const seconds = (next.at - previous.at) / 1000;
  const result: StatsRates = {
    bitrateKbps: ((next.bytes - previous.bytes) * 8) / 1000 / seconds,
    fps: (next.framesRendered - previous.framesRendered) / seconds,
    dropPerSec: Math.max(0, next.framesDropped - previous.framesDropped) / seconds,
    rttMs: next.rttMs,
  };
  const a = previous.server, b = next.server;
  if (a && b && b.uptimeMs > a.uptimeMs && b.framesSent >= a.framesSent) result.serverFps = (b.framesSent - a.framesSent) / ((b.uptimeMs - a.uptimeMs) / 1000);
  return result;
}

export function formatBitrate(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} Kbps`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

/** SVG polyline points scaled to the box; the peak is the top unless a fixed ceiling is given. */
export function sparkPoints(values: number[], width: number, height: number, ceiling?: number): string {
  if (!values.length) return '';
  const max = Math.max(ceiling ?? 0, ...values, 1e-9);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values.map((value, i) => `${(i * step).toFixed(1)},${(height - (Math.max(0, value) / max) * (height - 2) - 1).toFixed(1)}`).join(' ');
}
