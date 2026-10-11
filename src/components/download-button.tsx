'use client'

import { useCallback, useRef, useState } from 'react'
import { Download, X, CheckCircle2, Gauge, Link2 } from 'lucide-react'

/**
 * قصّاص — زر التحميل السريع
 * Downloads through a multi-lane Range manager (like a download accelerator):
 *   • small files → single streamed fetch with progress
 *   • big files → N parallel Range lanes (the preview gateway is
 *     latency-bound — 6-8 lanes genuinely multiply throughput)
 * Live speed (sliding window), ETA, cancel, and a plain-link fallback.
 */

export type DownloadState = {
  phase: 'idle' | 'running' | 'done' | 'error'
  got: number
  total: number
  speed: number // bytes/s
  lanes: number
  err?: string
}

const fmtMB = (b: number) => `${(b / 1024 / 1024).toFixed(1)} م.ب`
const fmtSpeed = (bps: number) => (bps > 1024 * 1024 ? `${(bps / 1024 / 1024).toFixed(1)} م.ب/ث` : `${Math.max(1, Math.round(bps / 1024))} ك.ب/ث`)
const fmtEta = (sec: number) => (sec < 90 ? `${Math.max(1, Math.round(sec))} ثانية` : `${Math.round(sec / 60)} دقيقة`)

export function DownloadButton({
  url, fileName, size, label, hint, disabled,
}: {
  url: string
  fileName: string
  size: number
  label: string
  hint?: string
  disabled?: boolean
}) {
  const [st, setSt] = useState<DownloadState>({ phase: 'idle', got: 0, total: size || 0, speed: 0, lanes: 1 })
  const abortRef = useRef<AbortController | null>(null)
  const meterRef = useRef<{ t: number; b: number }[]>([])

  const onProgress = useCallback((got: number, total: number, lanes: number) => {
    const now = performance.now()
    const m = meterRef.current
    m.push({ t: now, b: got })
    while (m.length > 2 && now - m[0].t > 2500) m.shift()
    const first = m[0]
    const speed = m.length > 1 && now > first.t ? (got - first.b) / ((now - first.t) / 1000) : 0
    setSt((s) => ({ ...s, phase: 'running', got, total: total || s.total, speed, lanes }))
  }, [])

  const start = useCallback(async () => {
    if (st.phase === 'running') return
    const ac = new AbortController()
    abortRef.current = ac
    meterRef.current = []
    setSt({ phase: 'running', got: 0, total: size || 0, speed: 0, lanes: 1 })
    try {
      const buf = await smartFetch(url, size, ac.signal, onProgress)
      if (ac.signal.aborted) return
      const blobUrl = URL.createObjectURL(new Blob([buf as unknown as BlobPart], { type: 'video/mp4' }))
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(blobUrl), 120_000)
      setSt((s) => ({ ...s, phase: 'done', got: s.total }))
    } catch (e) {
      if (ac.signal.aborted) {
        setSt((s) => ({ ...s, phase: 'idle' }))
        return
      }
      setSt((s) => ({ ...s, phase: 'error', err: (e as Error)?.message || 'فشل التحميل' }))
    }
  }, [st.phase, url, size, fileName, onProgress])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  /* ------------------------------------------------------------------- UI */

  if (st.phase === 'running') {
    const pct = st.total > 0 ? Math.min(100, Math.round((st.got / st.total) * 100)) : 0
    const eta = st.speed > 0 && st.total > st.got ? (st.total - st.got) / st.speed : null
    return (
      <div className="w-full rounded-2xl border border-orange-200 bg-orange-50/60 p-4 space-y-3">
        <div className="flex items-center justify-between text-sm font-bold">
          <span className="flex items-center gap-2 text-zinc-900">
            <Gauge className="w-4 h-4 text-orange-500" />
            بننزّل بأقصى سرعة {st.lanes > 1 ? <span className="text-[11px] font-black text-orange-600 bg-orange-100 rounded-full px-2 py-0.5">×{st.lanes} مسارات</span> : null}
          </span>
          <span className="tabular-nums text-orange-700">{pct}%</span>
        </div>
        <div className="h-3 rounded-full bg-orange-100 overflow-hidden">
          <div className="h-full rounded-full bg-orange-500 transition-all duration-200" style={{ width: `${Math.max(2, pct)}%` }} />
        </div>
        <div className="flex items-center justify-between text-xs text-zinc-500 tabular-nums font-semibold">
          <span>{st.total > 0 ? `${fmtMB(st.got)} من ${fmtMB(st.total)}` : fmtMB(st.got)}</span>
          <span className="flex items-center gap-2">
            {st.speed > 0 && <span className="text-orange-600">{fmtSpeed(st.speed)}</span>}
            {eta !== null && <span>باقي ~{fmtEta(eta)}</span>}
          </span>
        </div>
        <button onClick={cancel}
          className="w-full h-9 rounded-xl border border-zinc-200 bg-white text-zinc-500 text-sm font-bold hover:border-red-200 hover:text-red-600 transition inline-flex items-center justify-center gap-2">
          <X className="w-4 h-4" /> إلغاء
        </button>
      </div>
    )
  }

  if (st.phase === 'error') {
    return (
      <div className="space-y-2">
        <button onClick={start}
          className="w-full h-14 rounded-2xl bg-orange-500 hover:bg-orange-600 active:scale-[0.99] text-white font-black text-lg shadow-lg shadow-orange-500/25 transition flex items-center justify-center gap-2.5">
          <Download className="w-5 h-5" /> جرّب تاني
        </button>
        <p className="text-xs text-red-600 text-center">{st.err} — أو افتح اللينك المباشر تحت</p>
        <a href={url} className="flex items-center justify-center gap-2 text-xs font-bold text-orange-600 underline underline-offset-2">
          <Link2 className="w-3.5 h-3.5" /> تحميل عادي من غير تسريع
        </a>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <button onClick={start} disabled={disabled}
        className="w-full h-14 rounded-2xl bg-orange-500 hover:bg-orange-600 active:scale-[0.99] text-white font-black text-lg shadow-lg shadow-orange-500/25 transition flex items-center justify-center gap-2.5 disabled:opacity-60">
        {st.phase === 'done' ? <CheckCircle2 className="w-5 h-5" /> : <Download className="w-5 h-5" />}
        {st.phase === 'done' ? `اتحفظ ✓ — نزّله تاني${st.total ? ` (${fmtMB(st.total)})` : ''}` : label}
      </button>
      {st.phase === 'done' && (
        <a href={url} className="flex items-center justify-center gap-2 text-xs font-bold text-orange-600 underline underline-offset-2">
          <Link2 className="w-3.5 h-3.5" /> لو الملف محفظش: افتح اللينك المباشر
        </a>
      )}
      {hint && st.phase === 'idle' && <p className="text-center text-[11px] text-zinc-400 leading-relaxed">{hint}</p>}
    </div>
  )
}

/* ------------------------------------------------------------ downloader */

async function smartFetch(
  url: string,
  size: number,
  signal: AbortSignal,
  onProgress: (got: number, total: number, lanes: number) => void,
): Promise<Uint8Array> {
  // 1) probe Range support (tiny 2-byte request)
  let rangeOK = false
  let total = size
  try {
    const probe = await fetch(url, { headers: { Range: 'bytes=0-1' }, signal, cache: 'no-store' })
    const cr = probe.headers.get('content-range')
    await probe.arrayBuffer().catch(() => undefined) // drain the tiny body
    if (probe.status === 206 && cr) {
      rangeOK = true
      const t = parseInt(cr.split('/')[1] || '0', 10)
      if (t > 0) total = t
    }
  } catch (e) {
    if (signal.aborted) throw e
  }

  if (!rangeOK || !total || total < 2 * 1024 * 1024) {
    // sequential streamed download with progress
    const r = await fetch(url, { signal, cache: 'no-store' })
    if (!r.ok) throw new Error(`التحميل فشل (${r.status})`)
    const len = Number(r.headers.get('content-length') || 0)
    if (len) total = len
    if (!r.body) return new Uint8Array(await r.arrayBuffer())
    const reader = r.body.getReader()
    const chunks: Uint8Array[] = []
    let got = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      got += value.length
      onProgress(got, total || got, 1)
    }
    const out = new Uint8Array(got)
    let off = 0
    for (const c of chunks) { out.set(c, off); off += c.length }
    return out
  }

  // 2) parallel lanes (bigger file → more lanes)
  const LANES = total > 96 * 1024 * 1024 ? 8 : total > 24 * 1024 * 1024 ? 6 : 4
  const chunk = Math.ceil(total / LANES)
  const parts: Uint8Array[] = new Array(LANES)
  let got = 0
  let lastTick = 0

  await Promise.all(Array.from({ length: LANES }, async (_, i) => {
    const s = i * chunk
    const e = Math.min(total - 1, s + chunk - 1)
    if (s > e) return
    const r = await fetch(url, { headers: { Range: `bytes=${s}-${e}` }, signal, cache: 'no-store' })
    if (!r.ok && r.status !== 206) throw new Error(`التحميل فشل (${r.status})`)
    if (!r.body) {
      parts[i] = new Uint8Array(await r.arrayBuffer())
      got += parts[i].length
      onProgress(got, total, LANES)
      return
    }
    const reader = r.body.getReader()
    const buf = new Uint8Array(e - s + 1)
    let off = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf.set(value, off)
      off += value.length
      got += value.length
      if (got - lastTick > 256 * 1024 || got >= total) { lastTick = got; onProgress(got, total, LANES) }
    }
    parts[i] = buf.subarray(0, off)
  }))

  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    if (!p) continue
    out.set(p, off)
    off += p.length
  }
  return out.subarray(0, off)
}
