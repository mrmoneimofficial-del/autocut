/** Formatting helpers shared by all studio components. */

export function fmtDuration(ms: number, opts: { compact?: boolean; ms?: boolean } = {}): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const totalSec = ms / 1000
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = Math.floor(totalSec % 60)
  const frac = Math.floor((ms % 1000) / 100)
  if (opts.compact) {
    if (h > 0) return `${h}h ${m}m ${s}s`
    if (m > 0) return `${m}m ${s}s`
    return `${s}.${frac}s`
  }
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const base = `${pad(h)}:${pad(m)}:${pad(s)}`
  return opts.ms ? `${base}.${frac}` : base
}

export function fmtTimecode(ms: number): string {
  return fmtDuration(ms, { ms: true })
}

export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

export function fmtSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '—'
  return `${fmtBytes(bytesPerSec)}/s`
}

export function fmtEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds > 86400 * 2) return '> 2 days'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v.toFixed(digits)}%`
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
