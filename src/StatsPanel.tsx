import { useEffect, useRef, useState } from 'react';
import type { VideoClient } from './video';
import { formatBitrate, formatBytes, formatDuration, rates, sparkPoints, type StatsRates, type VideoStats } from './stats';

const HISTORY = 60; // one minute at 1 Hz
type Series = { bitrate: number[]; fps: number[]; rtt: number[] };

function Spark({ values, label, value, tone, ceiling }: { values: number[]; label: string; value: string; tone: 'cyan' | 'violet' | 'lime'; ceiling?: number }) {
  return <div className={`spark spark-${tone}`}>
    <div className="spark-head"><span>{label}</span><strong>{value}</strong></div>
    <svg viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={sparkPoints(values, 120, 28, ceiling)} />
    </svg>
  </div>;
}

/** YouTube-style "Stats for nerds": samples the client once a second while mounted. */
export function StatsPanel({ client, quality, onClose }: { client: VideoClient | null; quality: string; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<VideoStats>();
  const [rate, setRate] = useState<StatsRates>();
  const [series, setSeries] = useState<Series>({ bitrate: [], fps: [], rtt: [] });
  const previous = useRef<VideoStats | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    previous.current = undefined;
    setSeries({ bitrate: [], fps: [], rtt: [] });
    if (!client) { setSnapshot(undefined); setRate(undefined); return; }
    const sample = () => {
      client.requestServerStats();
      const next = client.stats();
      const r = rates(previous.current, next);
      previous.current = next;
      setSnapshot(next);
      setRate(r);
      const push = (list: number[], value: number) => [...list, value].slice(-HISTORY);
      setSeries((s) => ({ bitrate: push(s.bitrate, r.bitrateKbps), fps: push(s.fps, r.fps), rtt: push(s.rtt, r.rttMs ?? 0) }));
    };
    sample();
    const timer = setInterval(sample, 1000);
    return () => clearInterval(timer);
  }, [client]);

  const s = snapshot;
  const rows: [string, string][] = s ? [
    ['Codec', s.codec ? `${s.codec === 'hevc' ? 'HEVC' : 'H.264'} · ${s.codecString ?? ''}` : '—'],
    ['Decoder', s.playback === 'mse' ? 'MediaSource (fMP4)' : 'WebCodecs (hardware preferred)'],
    ['Resolution', s.width ? `${s.width}×${s.height}` : '—'],
    ['Frame rate', `${(rate?.fps ?? 0).toFixed(1)} / ${s.declaredFps} fps`],
    ['Bitrate', formatBitrate(rate?.bitrateKbps ?? 0)],
    ['Round trip', s.rttMs === undefined ? '—' : `${Math.round(s.rttMs)} ms (min ${Math.round(s.rttMinMs ?? s.rttMs)})`],
    ['Frames', `${s.framesRendered.toLocaleString()} shown · ${s.framesDropped.toLocaleString()} dropped`],
    ['Keyframes', `${s.keyframes} · last ${formatBytes(s.lastKeyframeBytes)}`],
    [s.playback === 'mse' ? 'Buffer' : 'Decode queue', s.playback === 'mse' ? `${(s.bufferedSec * 1000).toFixed(0)} ms · ${formatBytes(s.queuedBytes)} queued${s.flowPaused ? ' · PAUSED' : ''}` : `${s.decodeQueue} frames · ${s.decoderResets} resets`],
    ['Received', `${formatBytes(s.bytes)} · ${s.packets.toLocaleString()} packets`],
    ['Input', `${s.inputsSent.toLocaleString()} events · uplink ${formatBytes(s.uplinkBuffered)}`],
    ['Session', formatDuration(s.connectedMs)],
    ['Preset', quality],
  ] : [];
  const server = s?.server;
  const serverRows: [string, string][] = server ? [
    ['Encoder out', `${(rate?.serverFps ?? 0).toFixed(1)} fps · ${server.framesIn.toLocaleString()} captured`],
    ['Gateway drop', `${server.framesDropped.toLocaleString()} frames (backpressure)`],
    ['Send backlog', formatBytes(server.buffered)],
    ['Gateway', `${server.rssMb} MB RSS${server.load !== undefined ? ` · load ${server.load}` : ''}`],
  ] : [];

  async function copy() {
    const text = [...rows, ...serverRows].map(([k, v]) => `${k}: ${v}`).join('\n');
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable on HTTP */ }
  }

  return <aside className="nerd-stats" aria-label="Stats for nerds">
    <header>
      <span className="nerd-title"><span className="blink" aria-hidden="true">▍</span>stats_for_nerds</span>
      <span className="nerd-actions">
        <button type="button" onClick={() => void copy()} title="Copy stats">{copied ? 'copied' : 'copy'}</button>
        <button type="button" onClick={onClose} aria-label="Close stats for nerds">×</button>
      </span>
    </header>
    {!s ? <p className="nerd-empty">// no active stream. connect to start sampling.</p> : <>
      <div className="sparks">
        <Spark tone="cyan" label="bitrate" value={formatBitrate(rate?.bitrateKbps ?? 0)} values={series.bitrate} />
        <Spark tone="lime" label="fps" value={(rate?.fps ?? 0).toFixed(0)} values={series.fps} ceiling={s.declaredFps} />
        <Spark tone="violet" label="rtt" value={s.rttMs === undefined ? '—' : `${Math.round(s.rttMs)}ms`} values={series.rtt} />
      </div>
      <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      {serverRows.length > 0 && <><p className="nerd-section">// host</p><dl>{serverRows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></>}
    </>}
  </aside>;
}
