'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Scissors, Upload, Download, Zap, Loader2, RefreshCw, HardDrive, Film,
  AlertTriangle, CheckCircle2, Eye, FastForward, Clock, CloudUpload, ExternalLink, Rocket, Github,
  Pause, Play, X,
} from 'lucide-react'

/* ------------------------------------------------------------------ types */
type Cut = [number, number]
type Job = {
  id: string
  name: string
  size: number
  phase: 'uploading' | 'uploaded' | 'analyzing' | 'ready' | 'rendering' | 'mirroring' | 'done' | 'error'
  uploaded: number
  uploadIntervals?: [number, number][]
  error?: string
  gofile?: { url: string }
  bunny?: { url: string; guid: string; mp4?: string }
  meta?: { durationMs: number; fps: number; width: number; height: number; sr: number; ch: number }
  plan?: { durationMs: number; keptMs: number; savedMs: number; cutsCount: number; cuts: Cut[]; settings: { gapMs: number; thresholdDb: number } }
  output?: { size: number; durationMs: number; cutsCount: number }
  progress?: { phase: string; stage: string; pct: number; speedX?: number; etaSec?: number } | null
}

const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}
const fmtMB = (b: number) => `${(b / 1024 / 1024).toFixed(1)} م.ب`
const fmtETA = (sec: number) => {
  if (sec < 90) return `${Math.max(5, Math.round(sec))} ثانية`
  if (sec < 5400) return `${Math.round(sec / 60)} دقيقة`
  return `${Math.round(sec / 3600)} ساعة`
}

/* -------------------------------------------------------------- uploading */
const LANES = 4 // parallel upload lanes — saturates the pipe instead of waiting per-chunk

function putChunk(jobId: string, offset: number, blob: Blob, sha: string, onLoaded: (n: number) => void, signal?: AbortSignal) {
  return new Promise<{ ok: boolean; status: number; data: any }>((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `/api/jobs/${jobId}/file?offset=${offset}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    if (sha) xhr.setRequestHeader('X-Chunk-SHA256', sha)
    xhr.upload.onprogress = (e) => onLoaded(e.loaded)
    xhr.onload = () => {
      let data: any = null
      try { data = JSON.parse(xhr.responseText) } catch { /* empty */ }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data })
    }
    xhr.onerror = () => resolve({ ok: false, status: 0, data: null })
    xhr.ontimeout = () => resolve({ ok: false, status: 0, data: null })
    xhr.onabort = () => resolve({ ok: false, status: 0, data: null })
    if (signal) {
      if (signal.aborted) return resolve({ ok: false, status: 0, data: null })
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }
    xhr.timeout = 300000
    xhr.send(blob)
  })
}

function cancelErr() { return Object.assign(new Error('اتلغى الرفع'), { name: 'CancelError' }) }

async function sha256Hex(blob: Blob): Promise<string> {
  try {
    const buf = await blob.arrayBuffer()
    const h = await crypto.subtle.digest('SHA-256', buf)
    let s = ''
    const u = new Uint8Array(h)
    for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, '0')
    return s
  } catch { return '' } // very old browsers → skip integrity header
}

/** is chunk [s,e) fully inside the merged server intervals? */
function chunkDone(intervals: [number, number][], s: number, e: number) {
  for (const [a, b] of intervals) {
    if (a >= e) break
    if (a <= s && e <= b) return true
  }
  return false
}

/**
 * Resumable parallel uploader (gofile-style user control).
 * - 4 lanes pull chunk indexes from a shared queue (out-of-order server writes)
 * - every chunk carries SHA-256; server verifies before writing
 * - unlimited retries with capped backoff — network drops / server restarts
 *   NEVER restart the upload from zero: server coverage map tells us what's
 *   already on disk and we only send the missing ranges
 * - user can PAUSE (lanes drain gracefully, coverage kept) or CANCEL (throws)
 */
async function uploadFile(
  jobId: string,
  file: File,
  onProgress: (sent: number, lanes: number[]) => void,
  onNotice: (msg: string) => void,
  resumeIntervals?: [number, number][],
  ctrl?: { paused: boolean; cancelled: boolean },
  signal?: AbortSignal,
): Promise<'done' | 'paused'> {
  const CHUNK = 8 * 1024 * 1024
  const size = file.size
  const nChunks = Math.max(1, Math.ceil(size / CHUNK))

  const covered: boolean[] = new Array(nChunks).fill(false)
  let doneBytes = 0
  if (resumeIntervals?.length) {
    for (let i = 0; i < nChunks; i++) {
      const s = i * CHUNK, e = Math.min(s + CHUNK, size)
      if (chunkDone(resumeIntervals, s, e)) { covered[i] = true; doneBytes += e - s }
    }
    if (doneBytes > 0) onNotice(`كمّلنا من حيث وقفنا — ${fmtMB(doneBytes)} كانوا اترفعوا خلاص`)
  }
  onProgress(doneBytes, new Array(LANES).fill(0))

  const queue: number[] = []
  for (let i = 0; i < nChunks; i++) if (!covered[i]) queue.push(i)
  if (queue.length === 0) return 'done'

  const inflight: number[] = new Array(LANES).fill(0)
  const report = () => onProgress(doneBytes + inflight.reduce((a, b) => a + b, 0), [...inflight])
  const stopped = () => {
    if (ctrl?.cancelled) throw cancelErr()
    return !!ctrl?.paused
  }

  const lane = async (li: number) => {
    try {
      while (true) {
        if (stopped()) return
        const idx = queue.shift()
        if (idx === undefined) return
        const start = idx * CHUNK, end = Math.min(start + CHUNK, size)
        const blob = file.slice(start, end)
        const sha = await sha256Hex(blob)
        inflight[li] = 0
        for (let attempt = 0; ; attempt++) {
          if (stopped()) return
          const res = await putChunk(jobId, start, blob, sha, (loaded) => { inflight[li] = loaded; report() }, signal)
          if (res.ok) break
          if (stopped()) return
          if (res.status === 409) {
            // server closed the upload phase (already complete) → lane done
            if (res.data?.complete) return
            throw new Error(res.data?.error || 'الرفع اتقفل من السيرفر')
          }
          if (res.status === 422 && attempt >= 6) throw new Error('جزء بيتبعت بايظ — جرّب تعمل ريفريش')
          if (attempt === 0) onNotice('مشكلة شبكة — بنعيد من نفس النقطة بالظبط، مفيش حاجة هتترفع من الأول')
          else if (attempt % 5 === 4) onNotice(`لسه بنحاول — محاولة ${attempt + 1} (عند ${fmtMB(start)})`)
          // capped backoff in 200ms ticks so pause/cancel take effect instantly
          const backoff = Math.min(8000, 700 * 2 ** Math.min(attempt, 4))
          for (let t = 0; t < backoff; t += 200) {
            if (stopped()) return
            await new Promise((r) => setTimeout(r, 200))
          }
        }
        inflight[li] = 0
        doneBytes += end - start
        report()
      }
    } finally {
      inflight[li] = 0
      report()
    }
  }
  await Promise.all(Array.from({ length: LANES }, (_, i) => lane(i)))
  return ctrl?.paused ? 'paused' : 'done'
}

/* --------------------------------------------------------------- timeline */
function Timeline({ durationMs, cuts, playheadRef, onSeek, active }: {
  durationMs: number
  cuts: Cut[]
  playheadRef: React.RefObject<HTMLDivElement | null>
  onSeek: (ms: number) => void
  active: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const cv = canvasRef.current, wrap = wrapRef.current
    if (!cv || !wrap || !durationMs) return
    const draw = () => {
      const w = wrap.clientWidth, h = wrap.clientHeight
      const dpr = window.devicePixelRatio || 1
      cv.width = w * dpr; cv.height = h * dpr
      const ctx = cv.getContext('2d')!
      ctx.scale(dpr, dpr)
      ctx.fillStyle = '#fafafa'
      ctx.fillRect(0, 0, w, h)
      // kept speech blocks
      ctx.fillStyle = '#e4e4e7'
      let cur = 0
      for (const [s, e] of cuts) {
        const a = (cur / durationMs) * w, b = (s / durationMs) * w
        if (b > a) ctx.fillRect(a, h * 0.28, b - a, h * 0.44)
        cur = e
      }
      if (durationMs > cur) ctx.fillRect((cur / durationMs) * w, h * 0.28, w - (cur / durationMs) * w, h * 0.44)
      // removed silences (orange)
      ctx.fillStyle = '#f97316'
      for (const [s, e] of cuts) {
        const a = (s / durationMs) * w, b = (e / durationMs) * w
        ctx.fillRect(a, 0, Math.max(1.2, b - a), h)
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [cuts, durationMs])

  const seekAt = (clientX: number) => {
    const el = wrapRef.current
    if (!el || !durationMs) return
    const r = el.getBoundingClientRect()
    const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    onSeek(pct * durationMs)
  }

  return (
    <div
      ref={wrapRef}
      dir="ltr"
      className={`relative h-11 rounded-xl border border-zinc-200 bg-zinc-50 overflow-hidden ${active ? 'cursor-pointer' : 'opacity-60'}`}
      onClick={(e) => active && seekAt(e.clientX)}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <div ref={playheadRef} className="absolute top-0 bottom-0 w-[2px] bg-zinc-900 rounded-full hidden" />
    </div>
  )
}

/* ------------------------------------------------------------ main app */
export default function Home() {
  const [job, setJob] = useState<Job | null>(null)
  const [jobErr, setJobErr] = useState<string | null>(null)
  const [showcase, setShowcase] = useState(false) // server refused upload: read-only serverless host (Vercel…)
  const [up, setUp] = useState<{ file: File; sent: number; speed: number; lanes: number[] } | null>(null)
  const [upPaused, setUpPaused] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [view, setView] = useState<'src' | 'out'>('src')
  const [skip, setSkip] = useState(true)
  const [gapMs, setGapMs] = useState(200)
  const [thr, setThr] = useState(-35)
  const [crf, setCrf] = useState(32)

  const videoRef = useRef<HTMLVideoElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const cutsRef = useRef<Cut[]>([])
  const skipRef = useRef(true)
  const viewRef = useRef<'src' | 'out'>('src')
  const speedTracker = useRef({ last: 0, at: 0 })
  const upCtrl = useRef({ paused: false, cancelled: false })
  const upAbort = useRef<AbortController | null>(null)
  const upFileRef = useRef<File | null>(null)
  const upIdRef = useRef<string>('')

  useEffect(() => { skipRef.current = skip }, [skip])
  useEffect(() => { viewRef.current = view }, [view])
  useEffect(() => {
    if (job?.plan) cutsRef.current = job.plan.cuts
  }, [job?.plan])

  const refresh = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/jobs/${id}`, { cache: 'no-store' })
      if (r.status === 404) { localStorage.removeItem('qattaas:job'); setJob(null); return }
      const j: Job = await r.json()
      setJob(j)
    } catch { /* offline tick */ }
  }, [])

  // restore last job on mount
  useEffect(() => {
    const id = localStorage.getItem('qattaas:job')
    if (id) refresh(id)
  }, [refresh])

  // polling
  useEffect(() => {
    if (!job) return
    const active = ['analyzing', 'rendering', 'mirroring', 'uploaded'].includes(job.phase)
    const t = setInterval(() => refresh(job.id), active ? 1200 : 5000)
    return () => clearInterval(t)
  }, [job, refresh])

  /* upload flow — shared runner (upload + kick off analyze) */
  const runUploadAndAnalyze = useCallback(async (id: string, file: File, resumeIntervals?: [number, number][]) => {
    upIdRef.current = id
    upFileRef.current = file
    upCtrl.current = { paused: false, cancelled: false }
    upAbort.current = new AbortController()
    setUpPaused(false)
    speedTracker.current = { last: 0, at: Date.now() }
    try {
      const outcome = await uploadFile(
        id,
        file,
        (sent, lanes) => {
          const tr = speedTracker.current
          const now = Date.now()
          if (now - tr.at > 700 && sent > tr.last) {
            const speed = ((sent - tr.last) / 1024 / 1024) / ((now - tr.at) / 1000)
            setUp((u) => (u ? { ...u, sent, speed, lanes } : u))
            speedTracker.current = { last: sent, at: now }
          } else {
            setUp((u) => (u ? { ...u, sent, lanes } : u))
          }
        },
        (msg) => setNotice(msg),
        resumeIntervals,
        upCtrl.current,
        upAbort.current.signal,
      )
      if (outcome === 'paused') { setUpPaused(true); return }
      const ar = await fetch(`/api/jobs/${id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'analyze' }),
      })
      if (!ar.ok) throw new Error('فشل بدء التحليل')
      setView('src')
      setUp(null)
      await refresh(id)
    } catch (e: any) {
      if (e?.name === 'CancelError') {
        localStorage.removeItem('qattaas:job')
        setUp(null); setNotice(null)
      } else {
        setJobErr(e?.message || 'حصل خطأ في الرفع')
        setUp(null)
      }
    }
  }, [refresh])

  const startUpload = useCallback(async (file: File) => {
    setJobErr(null)
    setShowcase(false)
    setNotice(null)
    setUp({ file, sent: 0, speed: 0, lanes: [0, 0, 0, 0] })
    // resume an interrupted upload of the SAME file if one exists on the server
    let id = ''
    let resumeIntervals: [number, number][] | undefined
    const savedId = localStorage.getItem('qattaas:job')
    if (savedId) {
      try {
        const r = await fetch(`/api/jobs/${savedId}`, { cache: 'no-store' })
        if (r.ok) {
          const j = await r.json()
          if (j?.phase === 'uploading' && j.name === file.name && Number(j.size) === file.size) {
            id = String(j.id)
            resumeIntervals = (j.uploadIntervals || []).map(
              (iv: any) => [Number(iv[0]), Number(iv[1])] as [number, number],
            )
          }
        }
      } catch { /* offline — fall through to fresh job */ }
    }

    if (!id) {
      const r = await fetch('/api/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, size: file.size }),
      })
      if (!r.ok) {
        if (r.status === 503) setShowcase(true)
        setUp(null)
        throw new Error((await r.json().catch(() => null))?.error || 'فشل إنشاء المهمة')
      }
      const { id: newId } = await r.json()
      id = String(newId)
      localStorage.setItem('qattaas:job', id)
    }
    await runUploadAndAnalyze(id, file, resumeIntervals)
  }, [runUploadAndAnalyze])

  const pauseUpload = () => {
    upCtrl.current.paused = true
    upAbort.current?.abort() // in-flight chunks abort → lanes drain gracefully
  }

  const resumeUpload = async () => {
    const file = upFileRef.current, id = upIdRef.current
    if (!file || !id) return
    setUpPaused(false)
    setNotice(null)
    let iv: [number, number][] | undefined
    try {
      const r = await fetch(`/api/jobs/${id}`, { cache: 'no-store' })
      if (r.ok) {
        const j = await r.json()
        iv = (j?.uploadIntervals || []).map(
          (x: any) => [Number(x[0]), Number(x[1])] as [number, number],
        )
      }
    } catch { /* resume blind — server will reject bad offsets */ }
    await runUploadAndAnalyze(id, file, iv)
  }

  const cancelUpload = () => {
    upCtrl.current.cancelled = true
    upAbort.current?.abort()
    if (upPaused) {
      // no active loop (paused) → clean up directly
      localStorage.removeItem('qattaas:job')
      setUp(null); setNotice(null); setUpPaused(false)
    }
  }

  const startRender = useCallback(async () => {
    if (!job) return
    await fetch(`/api/jobs/${job.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'render', gapMs, thresholdDb: thr, crf }),
    })
    refresh(job.id)
  }, [job, gapMs, thr, crf, refresh])

  const newVideo = () => {
    localStorage.removeItem('qattaas:job')
    setJob(null); setUp(null); setJobErr(null); setNotice(null); setShowcase(false); setView('src'); setSkip(true); setUpPaused(false)
  }

  /* smart input #1 — paste a video straight from the clipboard (Ctrl+V) */
  useEffect(() => {
    if (job || up) return
    const onPaste = (e: ClipboardEvent) => {
      const f = Array.from(e.clipboardData?.files || [])[0]
      if (f && f.size > 1000) {
        e.preventDefault()
        startUpload(f)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [job, up, startUpload])

  /* smart input #2 — drop a video ANYWHERE on the page (full-screen overlay) */
  useEffect(() => {
    if (job || up) return
    let depth = 0
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files')
    const onEnter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDragOver(true) } }
    const onLeave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragOver(false) }
    const onOver = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault() }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0; setDragOver(false)
      const f = e.dataTransfer?.files?.[0]
      if (f && f.size > 1000) startUpload(f)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [job, up, startUpload])

  /* smart skip + playhead */
  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    const t = v.currentTime * 1000
    if (skipRef.current && viewRef.current === 'src' && cutsRef.current.length) {
      const cuts = cutsRef.current
      let lo = 0, hi = cuts.length - 1
      while (lo <= hi) {
        const m = (lo + hi) >> 1
        const [s, e] = cuts[m]
        if (t < s) hi = m - 1
        else if (t >= e) lo = m + 1
        else { v.currentTime = e / 1000 + 0.03; return }
      }
    }
  }, [])

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const v = videoRef.current, ph = playheadRef.current
      if (v && ph && job) {
        const dur = view === 'out' ? (job.output?.durationMs ?? v.duration * 1000) : (job.plan?.durationMs ?? v.duration * 1000)
        if (dur && isFinite(dur) && dur > 0) {
          const pct = Math.min(100, (v.currentTime * 1000 / dur) * 100)
          ph.style.left = `${pct}%`
          ph.classList.remove('hidden')
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [job, view])

  const seekTo = (ms: number) => {
    const v = videoRef.current
    if (v) v.currentTime = ms / 1000
  }

  /* ---------------------------------------------------------- render: upload screen */
  if (!job && !up) {
    return (
      <div className="h-dvh flex flex-col bg-white">
        <Header hasJob={false} onNew={newVideo} />
        <main className="flex-1 grid place-items-center p-6">
          <div className="w-full max-w-lg -mt-10">
            <div className="text-center mb-8">
              <div className="inline-grid place-items-center w-20 h-20 rounded-3xl bg-orange-500 shadow-lg shadow-orange-500/25 mb-5">
                <Scissors className="w-10 h-10 text-white" strokeWidth={2.2} />
              </div>
              <h1 className="text-4xl font-black tracking-tight">قصّاص الصمت</h1>
              <p className="text-zinc-500 mt-2 text-lg">ارفع فيديو — هنشيل الصمت ونرجّعهولك بأقصى سرعة</p>
            </div>

            {jobErr && (
              <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" /> {jobErr}
                </div>
                {showcase && (
                  <div className="mt-3 flex flex-col gap-3">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <a
                        href="https://colab.research.google.com/github/mrmoneimofficial-del/autocut/blob/main/colab.ipynb"
                        target="_blank"
                        rel="noopener"
                        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-orange-500 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-orange-600"
                      >
                        <Rocket className="w-4 h-4" />
                        شغّل نسخة كاملة مجانًا على Google Colab
                      </a>
                      <a
                        href="https://codespaces.new/mrmoneimofficial-del/autocut"
                        target="_blank"
                        rel="noopener"
                        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-red-300 bg-white px-4 py-2.5 text-sm font-bold text-red-700 shadow-sm transition hover:bg-red-50"
                      >
                        <Github className="w-4 h-4" />
                        أو على GitHub Codespaces
                      </a>
                    </div>
                    <span className="text-xs leading-5 text-red-600">
                      النسخة دي للعرض بس (استضافة بدون تخزين). الروابط دي بتفتحلك سيرفر شغال مجاني في دقيقة —
                      ترفع الفيديو وتقصّه عادي، وفي آخره لينك دائم للنتيجة.
                    </span>
                  </div>
                )}
              </div>
            )}

            <label
              className="group flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-zinc-300 bg-zinc-50/60 px-8 py-14 cursor-pointer transition hover:border-orange-400 hover:bg-orange-50/40"
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.add('border-orange-400', 'bg-orange-50/40') }}
              onDragLeave={(e) => { e.stopPropagation(); e.currentTarget.classList.remove('border-orange-400', 'bg-orange-50/40') }}
              onDrop={(e) => {
                e.preventDefault(); e.stopPropagation()
                e.currentTarget.classList.remove('border-orange-400', 'bg-orange-50/40')
                setDragOver(false)
                const f = e.dataTransfer.files?.[0]
                if (f) startUpload(f)
              }}
            >
              <input type="file" accept="video/*" className="sr-only"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) startUpload(f) }} />
              <div className="grid place-items-center w-14 h-14 rounded-2xl bg-orange-500/10 transition group-hover:bg-orange-500/20">
                <Upload className="w-7 h-7 text-orange-500" />
              </div>
              <div className="text-center">
                <div className="font-bold text-lg">اسحب الفيديو هنا أو اضغط للاختيار</div>
                <div className="text-sm text-zinc-500 mt-1">أي صيغة فيديو فيها صوت — MP4 وMOV وMKV وWEBM</div>
                <div className="text-xs text-zinc-400 mt-2">تقدر كمان تلزقه من الحافظة (Ctrl+V) أو تسحبه في أي حتة في الصفحة</div>
              </div>
            </label>

            <div className="mt-6 flex items-center justify-center gap-6 text-sm text-zinc-500">
              <span className="flex items-center gap-1.5"><Zap className="w-4 h-4 text-orange-500" /> أقصى سرعة ترميز</span>
              <span className="flex items-center gap-1.5"><FastForward className="w-4 h-4 text-orange-500" /> بريفيو ذكي يتخطى الصمت</span>
            </div>
          </div>
        </main>
        {/* full-screen drop overlay — drop anywhere, not just the box */}
        {dragOver && !job && !up && (
          <div className="fixed inset-0 z-50 pointer-events-none p-4">
            <div className="h-full w-full rounded-3xl border-4 border-dashed border-orange-400 bg-orange-50/80 backdrop-blur-[2px] grid place-items-center">
              <div className="text-center">
                <Upload className="w-14 h-14 text-orange-500 mx-auto mb-3" />
                <div className="text-2xl font-black text-orange-600">سيب الفيديو في أي مكان</div>
                <div className="text-sm text-orange-500 mt-1">هنبدأ الرفع فورًا</div>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  /* ------------------------------------- render: interrupted upload (resume) */
  if (job && !up && job.phase === 'uploading') {
    const pct = job.size ? Math.min(100, ((job.uploaded || 0) / job.size) * 100) : 0
    return (
      <div className="h-dvh flex flex-col bg-white">
        <Header hasJob onNew={newVideo} />
        <main className="flex-1 grid place-items-center p-6">
          <div className="w-full max-w-lg -mt-10 rounded-3xl border border-orange-200 bg-orange-50/50 p-8 shadow-sm">
            <div className="flex items-center gap-4 mb-5">
              <div className="grid place-items-center w-12 h-12 rounded-2xl bg-orange-500/10">
                <RefreshCw className="w-6 h-6 text-orange-500" />
              </div>
              <div className="min-w-0">
                <div className="font-bold truncate">{job.name}</div>
                <div className="text-sm text-zinc-500">{fmtMB(job.uploaded || 0)} من {fmtMB(job.size)} اترفعوا خلاص</div>
              </div>
            </div>
            <div className="h-3 rounded-full bg-orange-100 overflow-hidden mb-5">
              <div className="h-full rounded-full bg-orange-500" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-sm text-zinc-600 leading-relaxed mb-4">
              الرفع اتقطع (قفلت الصفحة أو النت وقع) — <b>اختار نفس الملف تاني</b> وهنكمّل من نفس النقطة بالظبط، من غير ما نبدأ من الأول.
            </p>
            <label className="group flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-orange-300 bg-white px-6 py-8 cursor-pointer transition hover:border-orange-400 hover:bg-orange-50/40">
              <input type="file" accept="video/*" className="sr-only"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) startUpload(f) }} />
              <Upload className="w-6 h-6 text-orange-500" />
              <span className="font-bold">اختار نفس الملف — «{job.name}»</span>
              <span className="text-xs text-zinc-500">لازم نفس الملف بالظبط (الاسم والحجم) عشان نتأكد إنه هو هو</span>
            </label>
          </div>
        </main>
      </div>
    )
  }

  /* ---------------------------------------------------------- render: upload progress */
  if (!job && up) {
    const pct = up.file.size ? Math.min(100, (up.sent / up.file.size) * 100) : 0
    const eta = up.speed > 0.05 ? (up.file.size - up.sent) / 1024 / 1024 / up.speed : null
    return (
      <div className="h-dvh flex flex-col bg-white">
        <Header hasJob onNew={newVideo} />
        <main className="flex-1 grid place-items-center p-6">
          <div className="w-full max-w-lg -mt-10 rounded-3xl border border-zinc-200 p-8 shadow-sm">
            <div className="flex items-center gap-4 mb-6">
              <div className="grid place-items-center w-12 h-12 rounded-2xl bg-orange-500/10">
                <Film className="w-6 h-6 text-orange-500" />
              </div>
              <div className="min-w-0">
                <div className="font-bold truncate">{up.file.name}</div>
                <div className="text-sm text-zinc-500">{fmtMB(up.file.size)}</div>
              </div>
            </div>
            <div className="h-3 rounded-full bg-zinc-100 overflow-hidden">
              <div className={`h-full rounded-full transition-all duration-300 ${upPaused ? 'bg-zinc-400' : 'bg-orange-500'}`} style={{ width: `${pct}%` }} />
            </div>
            {/* live lanes — the 4 parallel streams eating the file */}
            <div className="mt-2.5 flex items-center gap-1.5" dir="ltr" title="٤ مسارات رفع متوازية">
              {(up.lanes || []).map((lb, i) => (
                <div key={i} className="h-1.5 flex-1 rounded-full bg-zinc-100 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${upPaused ? 'bg-zinc-400' : 'bg-orange-300'}`}
                    style={{ width: `${Math.min(100, (lb / (8 * 1024 * 1024)) * 100)}%`, transition: 'width 200ms ease' }}
                  />
                </div>
              ))}
              <span className="text-[10px] font-bold text-zinc-400 shrink-0">4×⇅</span>
            </div>
            {notice && (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-xs font-bold text-orange-700">
                <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin" style={{ animationDuration: '3s' }} />
                {notice}
              </div>
            )}
            <div className="mt-3 flex justify-between text-sm text-zinc-500">
              <span className="font-bold text-zinc-900">{upPaused ? 'متوقف مؤقتًا' : `${pct.toFixed(0)}%`}</span>
              <span>{upPaused ? 'اضغط استئناف لتكميل من نفس النقطة' : up.speed > 0.05 ? `${up.speed.toFixed(1)} م.ب/ث${eta ? ` — باقي ${fmtETA(eta)}` : ''}` : 'بنجهّز…'}</span>
            </div>
            {(upPaused || up.sent < up.file.size) && (
              <div className="mt-5 flex items-center gap-2">
                {!upPaused ? (
                  <button onClick={pauseUpload}
                    className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 h-10 text-sm font-bold text-zinc-700 transition hover:border-orange-300 hover:text-orange-600">
                    <Pause className="w-4 h-4" /> إيقاف مؤقت
                  </button>
                ) : (
                  <button onClick={resumeUpload}
                    className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 h-10 text-sm font-bold text-white shadow-sm transition hover:bg-orange-600">
                    <Play className="w-4 h-4" /> استئناف
                  </button>
                )}
                <button onClick={cancelUpload}
                  className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 h-10 text-sm font-bold text-zinc-500 transition hover:border-red-200 hover:text-red-600">
                  <X className="w-4 h-4" /> إلغاء
                </button>
                <span className="text-[11px] text-zinc-400">{fmtMB(up.sent)} من {fmtMB(up.file.size)}</span>
              </div>
            )}
          </div>
        </main>
      </div>
    )
  }

  /* ---------------------------------------------------------- render: workbench */
  const phase = job!.phase
  const meta = job!.meta
  const plan = job!.plan
  const prog = job!.progress
  const isResult = view === 'out' && (phase === 'done' || phase === 'mirroring')
  const playingDuration = isResult ? job!.output?.durationMs : plan?.durationMs
  const statsChanged = plan && (plan.settings.gapMs !== gapMs || plan.settings.thresholdDb !== thr)

  return (
    <div className="h-dvh flex flex-col bg-white">
      <Header hasJob onNew={newVideo} />

      <main className="flex-1 min-h-0 flex flex-col lg:flex-row">
        {/* video panel — renders on the RIGHT in RTL (first child) */}
        <section className="flex-1 min-h-0 flex flex-col p-4 sm:p-6 gap-4 order-1 lg:order-none">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              {(phase === 'done' || phase === 'mirroring') && (
                <div className="inline-flex rounded-xl border border-zinc-200 bg-zinc-50 p-1">
                  <SegBtn active={view === 'src'} onClick={() => setView('src')}>الأصلي</SegBtn>
                  <SegBtn active={view === 'out'} onClick={() => setView('out')}>النتيجة</SegBtn>
                </div>
              )}
              {view === 'src' && phase !== 'analyzing' && plan && plan.cutsCount > 0 && (
                <button
                  onClick={() => setSkip((s) => !s)}
                  className={`inline-flex items-center gap-2 rounded-xl border px-3 h-9 text-sm font-bold transition ${skip ? 'border-orange-500 bg-orange-500 text-white' : 'border-zinc-200 bg-white text-zinc-600 hover:border-orange-300'}`}
                  title="البريفيو الذكي: تخطي الفجوات المتشالة تلقائيًا أثناء التشغيل"
                >
                  <FastForward className="w-4 h-4" />
                  تخطي الصمت
                </button>
              )}
              {phase === 'rendering' && (
                <span className="inline-flex items-center gap-2 rounded-xl bg-orange-50 border border-orange-200 px-3 h-9 text-sm font-bold text-orange-700">
                  <span className="w-2 h-2 rounded-full bg-orange-500 pulse-dot" />
                  بنقصّ الفيديو دلوقتي…
                </span>
              )}
              {phase === 'mirroring' && (
                <span className="inline-flex items-center gap-2 rounded-xl bg-orange-50 border border-orange-200 px-3 h-9 text-sm font-bold text-orange-700">
                  <CloudUpload className="w-4 h-4" />
                  نحفظ نسخة خارجية…
                </span>
              )}
            </div>
            <div className="text-sm text-zinc-500 tabular-nums font-semibold" id="timelabel">
              {isResult ? 'النتيجة النهائية' : plan ? `المدة بعد القص: ${fmtTime(plan.keptMs)}` : meta ? fmtTime(meta.durationMs) : '…'}
            </div>
          </div>

          <div className="flex-1 min-h-0 rounded-2xl overflow-hidden bg-zinc-950 grid place-items-center">
            <video
              ref={videoRef}
              key={isResult ? 'out' : 'src'}
              className="max-h-full max-w-full w-full h-full object-contain"
              controls
              preload="metadata"
              playsInline
              src={`/api/jobs/${job!.id}/file?v=${isResult ? 'out' : 'src'}`}
              onTimeUpdate={onTimeUpdate}
              onSeeked={onTimeUpdate}
            />
          </div>

          <Timeline
            durationMs={isResult ? (job!.output?.durationMs ?? 1) : (plan?.durationMs ?? meta?.durationMs ?? 1)}
            cuts={isResult ? [] : (plan?.cuts ?? [])}
            playheadRef={playheadRef}
            onSeek={seekTo}
            active={phase !== 'analyzing'}
          />
          <div className="flex items-center justify-between text-xs text-zinc-400 px-1" dir="rtl">
            <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-zinc-300 inline-block" /> الكلام</span>
            <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-orange-500 inline-block" /> صمت هيتشال</span>
          </div>
        </section>

        {/* sidebar — renders on the LEFT in RTL (second child) */}
        <aside className="w-full lg:w-[350px] xl:w-[380px] shrink-0 border-t lg:border-t-0 lg:border-r border-zinc-200 bg-white overflow-y-auto order-2 lg:order-none">
          <div className="p-5 space-y-5">

            {phase === 'error' && (
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
                <div className="flex items-center gap-2 font-bold text-red-700 text-sm">
                  <AlertTriangle className="w-4 h-4" /> حصل خطأ
                </div>
                <p className="text-sm text-red-600 mt-1.5 leading-relaxed">{job!.error || 'خطأ غير معروف'}</p>
                <div className="flex gap-2 mt-3">
                  <button onClick={startRender} className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-bold px-3 h-9 transition">
                    <RefreshCw className="w-4 h-4" /> إعادة المحاولة
                  </button>
                  <button onClick={newVideo} className="rounded-lg border border-red-200 bg-white text-red-700 text-sm font-bold px-3 h-9 hover:bg-red-50 transition">
                    فيديو تاني
                  </button>
                </div>
              </div>
            )}

            {/* info */}
            <section className="rounded-2xl border border-zinc-200 p-4">
              <div className="flex items-start gap-3">
                <div className="grid place-items-center w-10 h-10 rounded-xl bg-zinc-100 shrink-0">
                  <Film className="w-5 h-5 text-zinc-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold truncate" title={job!.name}>{job!.name}</div>
                  <div className="text-xs text-zinc-500 mt-0.5 flex items-center gap-2 flex-wrap">
                    <span className="flex items-center gap-1"><HardDrive className="w-3 h-3" /> {fmtMB(job!.size)}</span>
                    {meta && <span className="flex items-center gap-1"><Film className="w-3 h-3" /> {meta.width}×{meta.height}</span>}
                    {meta && <span>{fmtTime(meta.durationMs)}</span>}
                  </div>
                </div>
              </div>
            </section>

            {/* analysis spinner */}
            {phase === 'analyzing' && (
              <div className="rounded-2xl border border-orange-200 bg-orange-50/60 p-6 text-center">
                <Loader2 className="w-8 h-8 text-orange-500 animate-spin mx-auto" />
                <div className="font-bold mt-3">بنمسح الفيديو ونحدد الفجوات…</div>
                <div className="text-sm text-zinc-500 mt-1">الفيديوهات الطويلة بتاخد ثواني معدودة</div>
              </div>
            )}

            {/* stats */}
            {plan && phase !== 'analyzing' && (
              <section className="rounded-2xl border border-zinc-200 overflow-hidden">
                <div className="px-4 pt-4 pb-2 flex items-center justify-between">
                  <h2 className="font-black text-sm text-zinc-900">النتيجة المتوقعة</h2>
                  {(phase === 'done' || phase === 'mirroring') && <span className="inline-flex items-center gap-1 text-xs font-bold text-orange-600"><CheckCircle2 className="w-3.5 h-3.5" /> تم القص</span>}
                </div>
                <div className="px-4 pb-4 space-y-2.5 text-sm">
                  <Row label="المدة الأصلية" value={fmtTime(plan.durationMs)} />
                  <Row label="المدة بعد القص" value={fmtTime((phase === 'done' || phase === 'mirroring') ? (job!.output?.durationMs ?? plan.keptMs) : plan.keptMs)} />
                  <Row label="فجوات هتتشال" value={String(plan.cutsCount).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[+d])} />
                  <div className="flex items-center justify-between pt-2.5 border-t border-zinc-100">
                    <span className="text-zinc-500">التوفير</span>
                    <span className="font-black text-orange-600 text-lg tabular-nums">
                      {fmtTime(plan.savedMs)} <span className="text-sm">({Math.round((plan.savedMs / Math.max(1, plan.durationMs)) * 100)}%)</span>
                    </span>
                  </div>
                  {statsChanged && phase === 'ready' && (
                    <p className="text-xs text-zinc-400 pt-1">غيّرت الإعدادات — هتتطبق وتتحدث الإحصائيات عند القص</p>
                  )}
                </div>
              </section>
            )}

            {/* settings */}
            {(phase === 'ready' || phase === 'rendering' || phase === 'mirroring' || phase === 'done' || phase === 'error') && (
              <section className={`rounded-2xl border p-4 space-y-4 ${(phase === 'rendering' || phase === 'mirroring') ? 'border-zinc-200 opacity-60' : 'border-zinc-200'}`}>
                <h2 className="font-black text-sm">إعدادات القص</h2>
                <Setting label="الفجوة المتبقية بين الكلام" hint="كل سكتة هيتساب منها قد إيه">
                  <select value={gapMs} disabled={phase === 'rendering'} onChange={(e) => setGapMs(+e.target.value)} className={selCls}>
                    <option value={100}>0.1 ثانية — سريع جدًا</option>
                    <option value={200}>0.2 ثانية — طبيعي</option>
                    <option value={300}>0.3 ثانية — مرتاح</option>
                  </select>
                </Setting>
                <Setting label="حساسية كشف الصمت" hint="دقّة تحديد الفجوات">
                  <select value={thr} disabled={phase === 'rendering'} onChange={(e) => setThr(+e.target.value)} className={selCls}>
                    <option value={-40}>ناعمة — تشيل أهدى الأصوات</option>
                    <option value={-35}>متوازنة</option>
                    <option value={-30}>خفيفة — الفجوات الواضحة بس</option>
                  </select>
                </Setting>
                <Setting label="الجودة والحجم" hint="الترميز بأقصى سرعة في كل الحالات">
                  <select value={crf} disabled={phase === 'rendering'} onChange={(e) => setCrf(+e.target.value)} className={selCls}>
                    <option value={28}>عالية</option>
                    <option value={32}>متوازنة</option>
                    <option value={36}>حجم أصغر</option>
                  </select>
                </Setting>
              </section>
            )}

            {/* action: render progress */}
            {phase === 'rendering' && prog && (
              <section className="rounded-2xl border border-orange-200 bg-orange-50/50 p-4 space-y-3">
                <div className="flex items-center justify-between text-sm font-bold">
                  <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-orange-500 pulse-dot" /> {prog.stage}</span>
                  <span className="tabular-nums text-orange-700">{Math.round(prog.pct)}%</span>
                </div>
                <div className="h-2.5 rounded-full bg-orange-100 overflow-hidden">
                  <div className="h-full rounded-full bg-orange-500 transition-all duration-500" style={{ width: `${prog.pct}%` }} />
                </div>
                <div className="flex justify-between text-xs text-zinc-500 tabular-nums font-semibold">
                  {prog.speedX ? <span>السرعة: {prog.speedX}× الوقت الحقيقي</span> : <span />}
                  {prog.etaSec ? <span>باقي ~{fmtETA(prog.etaSec)}</span> : <span />}
                </div>
              </section>
            )}

            {/* action: external mirror (non-blocking bonus) */}
            {phase === 'mirroring' && (
              <section className="rounded-2xl border border-orange-200 bg-orange-50/50 p-4 space-y-2">
                <div className="flex items-center gap-2 text-sm font-bold text-orange-700">
                  <CloudUpload className="w-4 h-4 shrink-0" />
                  نحفظ نسخة خارجية من النتيجة…
                </div>
                <p className="text-xs text-zinc-500 leading-relaxed">دي مش بتأخر تحميلك — النتيجة جاهزة ونزّلها من الزر البرتقالي تحت، واللينك الخارجي هيظهر هنا خلال لحظات ويعيش حتى بعد ما السيرفر يقفل.</p>
              </section>
            )}

            {/* action: cut button */}
            {phase === 'ready' && (
              <button
                onClick={startRender}
                className="w-full h-14 rounded-2xl bg-orange-500 hover:bg-orange-600 active:scale-[0.99] text-white font-black text-lg shadow-lg shadow-orange-500/25 transition flex items-center justify-center gap-2.5"
              >
                <Zap className="w-5 h-5" />
                قصّ الفيديو الآن
              </button>
            )}

            {/* action: download (available from mirroring — output is already on disk) */}
            {(phase === 'done' || phase === 'mirroring') && job!.output && (
              <div className="space-y-3">
                <a
                  href={`/api/jobs/${job!.id}/file?v=out&dl=1`}
                  className="w-full h-14 rounded-2xl bg-orange-500 hover:bg-orange-600 active:scale-[0.99] text-white font-black text-lg shadow-lg shadow-orange-500/25 transition flex items-center justify-center gap-2.5"
                >
                  <Download className="w-5 h-5" />
                  تحميل الفيديو ({fmtMB(job!.output.size)})
                </a>
                <button
                  onClick={() => { setView('out'); videoRef.current?.load() }}
                  className="w-full h-11 rounded-2xl border border-zinc-200 hover:border-orange-300 text-zinc-700 font-bold transition flex items-center justify-center gap-2"
                >
                  <Eye className="w-4 h-4" /> معاينة النتيجة
                </button>
                {(job!.gofile?.url || job!.bunny?.url) && (
                  <a
                    href={job!.bunny?.url || job!.gofile!.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full h-11 rounded-2xl border border-zinc-200 hover:border-orange-300 text-zinc-700 font-bold transition flex items-center justify-center gap-2 text-sm"
                  >
                    <ExternalLink className="w-4 h-4" />
                    {job!.bunny ? 'المشاهدة على Bunny Stream (دائم)' : 'نسخة خارجية دائمة (GoFile)'}
                  </a>
                )}
                {job!.bunny?.mp4 && (
                  <a
                    href={job!.bunny.mp4}
                    target="_blank"
                    rel="noopener"
                    className="w-full h-11 rounded-2xl border border-zinc-200 hover:border-orange-300 text-zinc-700 font-bold transition flex items-center justify-center gap-2 text-sm"
                  >
                    <Film className="w-4 h-4" />
                    رابط MP4 مباشر من الـ CDN
                  </a>
                )}
                <div className="flex items-center justify-center gap-4 text-xs text-zinc-400 tabular-nums">
                  <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {fmtTime(job!.output.durationMs)}</span>
                  <span className="flex items-center gap-1"><HardDrive className="w-3 h-3" /> {fmtMB(job!.output.size)}</span>
                  <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-orange-500" /> تزامن 100%</span>
                </div>
                {job!.gofile?.url && (
                  <p className="text-center text-[11px] text-zinc-400 leading-relaxed">
                    اللينك الخارجي من GoFile — بيعيش مع آخر تحميل منه (GoFile بيمسح الملفات غير النشطة تلقائيًا).
                  </p>
                )}
                {job!.bunny?.url && (
                  <p className="text-center text-[11px] text-zinc-400 leading-relaxed">
                    اللينك من Bunny Stream وبيعيش للأبد — لو لسه مش شغال، انتظر دقيقة لحد ما الترميز يخلص. (لينك الـ MP4 افتحه بالضغط من هنا مباشرةً).
                  </p>
                )}
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  )
}

/* -------------------------------------------------------------- bits */
function Header({ hasJob, onNew }: { hasJob: boolean; onNew: () => void }) {
  return (
    <header className="h-14 shrink-0 border-b border-zinc-200 bg-white flex items-center justify-between px-4 sm:px-6">
      <div className="flex items-center gap-2.5">
        <div className="grid place-items-center w-9 h-9 rounded-xl bg-orange-500">
          <Scissors className="w-5 h-5 text-white" strokeWidth={2.4} />
        </div>
        <div className="leading-tight">
          <div className="font-black text-lg">قصّاص</div>
          <div className="text-[11px] text-zinc-500">قص الصمت بأقصى سرعة</div>
        </div>
      </div>
      {hasJob && (
        <button onClick={onNew} className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 px-3.5 h-9 text-sm font-bold text-zinc-700 hover:border-orange-300 hover:text-orange-600 transition">
          <Upload className="w-4 h-4" /> فيديو جديد
        </button>
      )}
    </header>
  )
}

function SegBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-3.5 h-8 text-sm font-bold transition ${active ? 'bg-white border border-zinc-200 shadow-sm text-zinc-900' : 'text-zinc-500 hover:text-zinc-800'}`}
    >
      {children}
    </button>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-zinc-500">{label}</span>
      <span className="font-bold tabular-nums">{value}</span>
    </div>
  )
}

function Setting({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-bold text-zinc-800">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-400">{hint}</span>}
    </label>
  )
}

const selCls =
  'w-full h-10 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800 focus:border-orange-400 focus:ring-2 focus:ring-orange-100 outline-none transition cursor-pointer disabled:opacity-50'
