'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Scissors, Upload, Download, Zap, Loader2, RefreshCw, HardDrive, Film,
  AlertTriangle, CheckCircle2, Eye, FastForward, Clock, CloudUpload, ExternalLink, Rocket, Github,
  X, Cloud,
} from 'lucide-react'
import { useUpload } from '@/hooks/use-upload'
import { UploadProgressCard } from '@/components/upload-progress-card'
import type { ChunkProgress, ChunkedUploadHandle } from '@/lib/chunked-upload'
import { formatBytes as fmtBytesCard } from '@/lib/chunked-upload'

/* ------------------------------------------------------------------ types */
type Cut = [number, number]
type Job = {
  id: string
  name: string
  size: number
  phase: 'uploaded' | 'analyzing' | 'ready' | 'rendering' | 'mirroring' | 'done' | 'error'
  error?: string
  asset?: { path: string; bunnyOK?: boolean }
  storage?: { path: string; size: number }
  resultUrl?: string
  originalUrl?: string
  meta?: { durationMs: number; fps: number; width: number; height: number; sr: number; ch: number }
  plan?: { durationMs: number; keptMs: number; savedMs: number; cutsCount: number; cuts: Cut[]; settings: { gapMs: number; thresholdDb: number } }
  output?: { size: number; durationMs: number; cutsCount: number }
  progress?: { phase: string; stage: string; pct: number; speedX?: number; etaSec?: number } | null
}

/** the asset ref returned by /api/uploads/chunked/complete (signed) */
type AssetRef = {
  path: string
  name: string
  size: number
  token: string
  mimeType?: string
}
type CompleteRes = {
  asset: AssetRef
  server?: { jobId: string }
  bunnyOK: boolean
  warning?: string
}

/** cloud mode — after the (shared) upload completes, the streamed cut runs */
type CloudState = {
  phase: 'cutting' | 'done' | 'error'
  ref?: AssetRef
  cut?: { stage: string; pct: number; text?: string; speedX?: number; etaSec?: number }
  result?: { original?: string | null; resultUrl?: string | null; output?: any; plan?: any; meta?: any }
  error?: string
}

/** an interrupted upload session saved in localStorage (same file → resume) */
type SavedUpload = { sessionId: string; fileName: string; fileSize: number }

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
  const [dragOver, setDragOver] = useState(false)
  const [view, setView] = useState<'src' | 'out'>('src')
  const [skip, setSkip] = useState(true)
  const [gapMs, setGapMs] = useState(200)
  const [thr, setThr] = useState(-35)
  const [crf, setCrf] = useState(32)
  /* cloud mode */
  const [srvMode, setSrvMode] = useState<'server' | 'cloud' | null>(null)
  const [cloudCutOK, setCloudCutOK] = useState(true)
  const [cloudMaxMB, setCloudMaxMB] = useState(200)
  const [cloudBunny, setCloudBunny] = useState(true)
  const [cloud, setCloud] = useState<CloudState | null>(null)
  /* upload session resume (the attached system's status/resume mechanism) */
  const [savedUpload, setSavedUpload] = useState<SavedUpload | null>(null)
  const [resumeInfo, setResumeInfo] = useState<{ done: number; total: number } | null>(null)
  const [retryFile, setRetryFile] = useState<File | null>(null)

  /* the ONE upload system — مستر منعم chunked uploader (both modes) */
  const {
    upload, uploading, fileName: upFileName,
    chunkProgress, simpleProgress, chunkHandle, cancelSimple,
  } = useUpload()

  const videoRef = useRef<HTMLVideoElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const cutsRef = useRef<Cut[]>([])
  const skipRef = useRef(true)
  const viewRef = useRef<'src' | 'out'>('src')
  const cloudAbort = useRef<AbortController | null>(null)
  const lastChunkErrRef = useRef<string | null>(null)
  /** the live chunked sessionId — lets a failed/cancelled upload resume from
   *  the bytes already banked on the server instead of starting over */
  const lastSidRef = useRef<string | null>(null)

  /* mode probe readiness — a picked file waits for this before choosing a path */
  const modeReadyRef = useRef<{ promise: Promise<'server' | 'cloud'>; resolve: (m: 'server' | 'cloud') => void } | null>(null)
  if (modeReadyRef.current === null) {
    let res!: (m: 'server' | 'cloud') => void
    const p = new Promise<'server' | 'cloud'>((r) => { res = r })
    modeReadyRef.current = { promise: p, resolve: res }
  }

  useEffect(() => { skipRef.current = skip }, [skip])
  useEffect(() => { viewRef.current = view }, [view])
  useEffect(() => { if (job?.plan) cutsRef.current = job.plan.cuts }, [job?.plan])

  /* remember the last terminal error the uploader reported (the hook clears
     its progress state once the promise settles — the page needs the message) */
  useEffect(() => {
    if (chunkProgress?.status === 'error' && chunkProgress.error) lastChunkErrRef.current = chunkProgress.error
    if (chunkProgress?.status === 'uploading') lastChunkErrRef.current = null
  }, [chunkProgress])

  const refresh = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/jobs/${id}`, { cache: 'no-store' })
      if (r.status === 404) { localStorage.removeItem('qattaas:job'); setJob(null); return }
      const j: Job = await r.json()
      setJob(j)
    } catch { /* offline tick */ }
  }, [])

  // capability probe: server pipeline vs cloud mode (Vercel…) + restores
  useEffect(() => {
    let alive = true
    ;(async () => {
      let m: 'server' | 'cloud' = 'server'
      let cutOK = true
      let maxMB = 200
      let bunny = true
      try {
        const r = await fetch('/api/jobs', { cache: 'no-store' })
        const j = await r.json()
        if (j?.ok && (j.mode === 'cloud' || j.mode === 'cloud-lite')) {
          m = 'cloud'
          cutOK = j.mode === 'cloud'
          maxMB = Number(j.cloud?.maxMB || 200)
          bunny = j.cloud?.bunny !== false
        }
      } catch { /* probe failed → cloud flow (upload→bunny→streamed cut works anywhere) */ m = 'cloud' }
      if (new URLSearchParams(window.location.search).get('mode') === 'cloud') m = 'cloud'
      if (!alive) return
      modeReadyRef.current!.resolve(m)
      setSrvMode(m)
      setCloudCutOK(cutOK)
      setCloudMaxMB(maxMB)
      setCloudBunny(bunny)

      // restore an interrupted upload session (resume with the same file)
      try {
        const saved = JSON.parse(localStorage.getItem('qattaas:upload') || 'null')
        if (saved?.sessionId && saved.fileName && Number(saved.fileSize) > 0) {
          const r = await fetch(`/api/uploads/chunked/${saved.sessionId}/status`, { cache: 'no-store' })
          if (r.ok) {
            const st = await r.json()
            if (alive && st && !st.complete) {
              setSavedUpload({ sessionId: saved.sessionId, fileName: saved.fileName, fileSize: Number(saved.fileSize) })
              setResumeInfo({ done: Number(st.bankedBytes || 0), total: Number(st.fileSize || saved.fileSize) })
            } else if (alive && st?.complete) {
              // session finished uploading but never completed → offer re-pick too
              setSavedUpload({ sessionId: saved.sessionId, fileName: saved.fileName, fileSize: Number(saved.fileSize) })
              setResumeInfo({ done: Number(st.fileSize || saved.fileSize), total: Number(st.fileSize || saved.fileSize) })
            } else if (alive) {
              localStorage.removeItem('qattaas:upload')
            }
          } else if (alive) {
            localStorage.removeItem('qattaas:upload')
          }
        }
      } catch { /* ignore */ }

      if (m === 'cloud') {
        try {
          const saved = JSON.parse(localStorage.getItem('qattaas:cloud:last') || 'null')
          if (saved?.result && Date.now() - Number(saved.at || 0) < 24 * 3600_000) {
            setCloud({ phase: 'done', ref: saved.ref, result: saved.result })
          }
        } catch { /* ignore */ }
      }
    })()
    return () => { alive = false }
  }, [])

  // restore last job on mount (server mode only)
  useEffect(() => {
    if (srvMode === 'cloud') return
    const id = localStorage.getItem('qattaas:job')
    if (id) refresh(id)
  }, [refresh, srvMode])

  // polling
  useEffect(() => {
    if (!job) return
    const active = ['analyzing', 'rendering', 'mirroring', 'uploaded'].includes(job.phase)
    const t = setInterval(() => refresh(job.id), active ? 1200 : 5000)
    return () => clearInterval(t)
  }, [job, refresh])

  /* --------------------------------------------- cloud mode: streamed cut */
  /** POST /api/cloud/cut and consume its NDJSON event stream */
  const runCloudCut = useCallback(async (ref: AssetRef) => {
    const ac = new AbortController()
    cloudAbort.current = ac
    setCloud({ phase: 'cutting', ref, cut: { stage: 'prep', pct: 0, text: 'بنجهّز المعالجة…' } })
    try {
      const r = await fetch('/api/cloud/cut', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: { path: ref.path, name: ref.name, size: ref.size, token: ref.token },
          settings: { gapMs, thresholdDb: thr, crf },
        }),
        signal: ac.signal,
      })
      if (!r.ok || !r.body) {
        const j = await r.json().catch(() => null)
        throw new Error(j?.error || `فشل بدء القص (${r.status})`)
      }
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let finished = false
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          let ev: any
          try { ev = JSON.parse(line) } catch { continue }
          if (ev.stage === 'download') {
            setCloud((c) => c ? { ...c, cut: { stage: 'download', pct: ev.pct || 0, text: 'بننزّل الفيديو من التخزين السحابي…' } } : c)
          } else if (ev.stage === 'cut') {
            setCloud((c) => c ? { ...c, cut: { stage: 'cut', pct: ev.pct || 0, text: ev.text, speedX: ev.speedX, etaSec: ev.etaSec } } : c)
          } else if (ev.stage === 'done') {
            finished = true
            setCloud((c) => c ? { ...c, phase: 'done', result: ev.result } : c)
            try { localStorage.setItem('qattaas:cloud:last', JSON.stringify({ ref, result: ev.result, at: Date.now() })) } catch { /* full */ }
          } else if (ev.stage === 'error') {
            throw new Error(ev.error || 'المعالجة فشلت')
          }
        }
      }
      if (!finished) {
        setCloud((c) => (c && c.phase === 'cutting'
          ? { ...c, phase: 'error', error: 'انقطع الاتصال بالمعالجة — لو الفيديو كبير جرّب نسخة أصغر أو النسخة الكاملة (كولاب/كودسبيسز)' }
          : c))
      }
    } catch (e: any) {
      if (ac.signal.aborted) { setCloud(null); return }
      setCloud((c) => ({ ...(c || { phase: 'cutting' as const }), phase: 'error' as const, error: e?.message || 'فشل القص' }))
    }
  }, [gapMs, thr, crf])

  /* ------------------------------------------ the ONE upload entry point */
  const handleFilePick = useCallback(async (file: File) => {
    setJobErr(null)
    setRetryFile(file)
    lastChunkErrRef.current = null
    const m = await modeReadyRef.current!.promise

    // resume an interrupted upload of the SAME file if a session exists
    let resume: SavedUpload | null = null
    if (savedUpload && savedUpload.fileName === file.name && savedUpload.fileSize === file.size) {
      resume = savedUpload
    }

    let result: CompleteRes | null = null
    try {
      result = await upload<CompleteRes>({
        file,
        basePath: '/api/uploads/chunked',
        resume,
        onSession: (sid) => {
          lastSidRef.current = sid
          // bookmark the session → a reload can resume exactly where we stopped
          try {
            localStorage.setItem('qattaas:upload', JSON.stringify({
              sessionId: sid, fileName: file.name, fileSize: file.size,
            }))
          } catch { /* full */ }
        },
      })
    } catch (e: any) {
      if (e?.name === 'CancelError' || e?.name === 'CancelledError') {
        // cancelled → keep the session resumable from the banked bytes
        if (lastSidRef.current) {
          setSavedUpload({ sessionId: lastSidRef.current, fileName: file.name, fileSize: file.size })
        }
        return
      }
      setJobErr(e?.message || 'فشل الرفع')
      if (lastSidRef.current) {
        // the retry button (and a reload) resume from the banked bytes — never from scratch
        setSavedUpload({ sessionId: lastSidRef.current, fileName: file.name, fileSize: file.size })
      }
      return
    }

    if (!result) {
      // cancelled → stay quiet (session kept for resume); error → surface it
      const err = lastChunkErrRef.current
      if (err && err !== 'تم الإلغاء') setJobErr(err)
      if (lastSidRef.current) {
        setSavedUpload({ sessionId: lastSidRef.current, fileName: file.name, fileSize: file.size })
      }
      return
    }

    // success → the session is complete; drop the resume bookmark
    lastSidRef.current = null
    try { localStorage.removeItem('qattaas:upload') } catch { /* noop */ }
    setSavedUpload(null)
    setResumeInfo(null)
    setRetryFile(null)
    if (result.warning) setJobErr(result.warning)

    if (m === 'server' && result.server?.jobId) {
      // classic local pipeline: analyze → timeline workbench → render
      localStorage.setItem('qattaas:job', result.server.jobId)
      setView('src')
      try {
        const ar = await fetch(`/api/jobs/${result.server.jobId}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'analyze' }),
        })
        if (!ar.ok) throw new Error('فشل بدء التحليل')
        await refresh(result.server.jobId)
      } catch (e: any) {
        setJobErr(e?.message || 'فشل بدء التحليل')
      }
    } else {
      // cloud: streamed cut from Bunny Storage
      await runCloudCut(result.asset)
    }
  }, [upload, savedUpload, runCloudCut, refresh, chunkHandle])

  const filePickRef = useRef(handleFilePick)
  useEffect(() => { filePickRef.current = handleFilePick }, [handleFilePick])

  const cancelCloud = () => {
    cloudAbort.current?.abort()
    setCloud(null)
  }

  /** cancel the in-flight upload (session stays on the server → resumable) */
  const cancelUpload = () => {
    if (chunkProgress) chunkHandle.current?.cancel()
    else cancelSimple()
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
    try { localStorage.removeItem('qattaas:cloud:last') } catch { /* noop */ }
    cloudAbort.current?.abort()
    setJob(null); setJobErr(null); setView('src'); setSkip(true)
    setCloud(null); setRetryFile(null)
  }

  /* smart input #1 — paste a video straight from the clipboard (Ctrl+V) */
  useEffect(() => {
    if (job || uploading || cloud) return
    const onPaste = (e: ClipboardEvent) => {
      const f = Array.from(e.clipboardData?.files || [])[0]
      if (f && f.size > 1000) {
        e.preventDefault()
        filePickRef.current(f)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [job, uploading, cloud])

  /* smart input #2 — drop a video ANYWHERE on the page (full-screen overlay) */
  useEffect(() => {
    if (job || uploading || cloud) return
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
      if (f && f.size > 1000) filePickRef.current(f)
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
  }, [job, uploading, cloud])

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

  /* ---------------------------------------------------------- render: cloud mode */
  if (srvMode === 'cloud') {
    /* ---- cloud dropzone (settings apply at cut time — one-shot flow) ---- */
    if (!cloud && !uploading) {
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
                <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-4 py-1.5 text-xs font-bold text-orange-700">
                  <Cloud className="w-3.5 h-3.5" />
                  وضع السحابة — رفع مقطّع + قص مباشر + حفظ دائم على Bunny
                </div>
              </div>

              {!cloudCutOK && (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>الاستضافة دي بتدعم الرفع والتخزين، لكن القص نفسه مش متفعّل هنا — للقص الكامل شغّل النسخة المجانية من Colab أو Codespaces.</span>
                </div>
              )}
              {cloudCutOK && !cloudBunny && (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>التخزين السحابي (Bunny) لسه مش متظبط على السيرفر ده (BUNNY_STORAGE_PASSWORD ناقص) — الرفع ممكن يشتغل مؤقتًا بس الروابط الدائمة مش هتتحفظ.</span>
                </div>
              )}

              {jobErr && (
                <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center gap-2 flex-wrap">
                  <AlertTriangle className="w-4 h-4 shrink-0" /> {jobErr}
                  {retryFile && (
                    <button onClick={() => filePickRef.current(retryFile)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 h-8 text-xs font-bold text-white hover:bg-orange-600 transition">
                      <RefreshCw className="w-3.5 h-3.5" /> إعادة الرفع
                    </button>
                  )}
                </div>
              )}

              {savedUpload && resumeInfo && (
                <ResumeCard saved={savedUpload} info={resumeInfo} onPick={(f) => filePickRef.current(f)} onDismiss={() => {
                  try { localStorage.removeItem('qattaas:upload') } catch { /* noop */ }
                  setSavedUpload(null); setResumeInfo(null)
                }} />
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
                  if (f) filePickRef.current(f)
                }}
              >
                <input type="file" accept="video/*" className="sr-only"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) filePickRef.current(f) }} />
                <div className="grid place-items-center w-14 h-14 rounded-2xl bg-orange-500/10 transition group-hover:bg-orange-500/20">
                  <Upload className="w-7 h-7 text-orange-500" />
                </div>
                <div className="text-center">
                  <div className="font-bold text-lg">اسحب الفيديو هنا أو اضغط للاختيار</div>
                  <div className="text-sm text-zinc-500 mt-1">أي صيغة فيديو فيها صوت — MP4 وMOV وMKV وWEBM</div>
                  <div className="text-xs text-zinc-400 mt-2">تقدر كمان تلزقه من الحافظة (Ctrl+V) أو تسحبه في أي حتة في الصفحة</div>
                </div>
              </label>

              <div className="mt-5 rounded-2xl border border-zinc-200 p-4 space-y-4">
                <h2 className="font-black text-sm">إعدادات القص <span className="font-normal text-zinc-400">(هتتطبق بعد الرفع)</span></h2>
                <CutSettings gapMs={gapMs} thr={thr} crf={crf} onGap={setGapMs} onThr={setThr} onCrf={setCrf} />
                <p className="text-xs text-zinc-400 leading-relaxed">
                  المسار السحابي بياخد لحد {cloudMaxMB} م.ب وبيشتغل على أي استضافة حتى اللي من غير تخزين. للفيديوهات الأكبر{' '}
                  <a className="text-orange-600 font-bold underline underline-offset-2" href="https://codespaces.new/mrmoneimofficial-del/autocut" target="_blank" rel="noopener">شغّل نسخة كاملة مجانًا</a>.
                </p>
              </div>
            </div>
          </main>
          {dragOver && !cloud && !uploading && (
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

    /* ---- cloud (and server): uploading through the chunked system ---- */
    if (uploading) {
      return (
        <div className="h-dvh flex flex-col bg-white">
          <Header hasJob onNew={newVideo} />
          <main className="flex-1 grid place-items-center p-6">
            <div className="w-full max-w-lg -mt-10 space-y-4">
              <UploadPanel
                fileName={upFileName}
                fileSize={chunkProgress?.totalBytes ?? simpleProgress?.total ?? 0}
                chunkProgress={chunkProgress}
                simpleProgress={simpleProgress}
                chunkHandle={chunkHandle.current}
                onCancel={cancelUpload}
              />
              <p className="text-center text-xs text-zinc-400 leading-relaxed">
                الفيديو بيترفع بقطع صغيرة ذكية بتتكيّف مع اتصالك — لو الشبكة ضعيفة بيصغّر القطعة ويكمّل من نفس النقطة، وبعدها بيتحفظ على تخزين Bunny الدائم.
              </p>
            </div>
          </main>
        </div>
      )
    }

    /* ---- cloud: cutting (streamed stages) ---- */
    if (cloud?.phase === 'cutting') {
      const cut = cloud.cut || { stage: 'prep', pct: 0 }
      return (
        <div className="h-dvh flex flex-col bg-white">
          <Header hasJob onNew={newVideo} />
          <main className="flex-1 grid place-items-center p-6">
            <div className="w-full max-w-lg -mt-10 rounded-3xl border border-zinc-200 p-8 shadow-sm">
              <div className="flex items-center gap-4 mb-6">
                <div className="grid place-items-center w-12 h-12 rounded-2xl bg-green-50">
                  <CheckCircle2 className="w-6 h-6 text-green-600" />
                </div>
                <div className="min-w-0">
                  <div className="font-bold truncate">{cloud.ref?.name}</div>
                  <div className="text-sm text-zinc-500">اترفع على التخزين السحابي ✓ — دلوقتي بنقصّ الصمت</div>
                </div>
              </div>
              <div className="h-3 rounded-full bg-zinc-100 overflow-hidden">
                <div className="h-full rounded-full bg-orange-500 transition-all duration-500" style={{ width: `${Math.max(2, cut.pct)}%` }} />
              </div>
              <div className="mt-3 flex justify-between text-sm text-zinc-500">
                <span className="flex items-center gap-2 font-bold text-zinc-900">
                  {cut.stage === 'download' ? <Download className="w-4 h-4 text-orange-500" /> : <Zap className="w-4 h-4 text-orange-500" />}
                  {cut.text || 'بنقصّ الفيديو…'}
                </span>
                <span className="tabular-nums font-bold text-orange-700">{cut.pct}%</span>
              </div>
              {(cut.speedX || cut.etaSec) && (
                <div className="mt-2 flex justify-between text-xs text-zinc-400 tabular-nums font-semibold">
                  {cut.speedX ? <span>السرعة: {cut.speedX}× الوقت الحقيقي</span> : <span />}
                  {cut.etaSec ? <span>باقي ~{fmtETA(cut.etaSec)}</span> : <span />}
                </div>
              )}
              <div className="mt-5 flex items-center gap-2">
                <button onClick={cancelCloud}
                  className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 h-10 text-sm font-bold text-zinc-500 transition hover:border-red-200 hover:text-red-600">
                  <X className="w-4 h-4" /> إلغاء المعالجة
                </button>
              </div>
            </div>
          </main>
        </div>
      )
    }

    /* ---- cloud: done (results) ---- */
    if (cloud?.phase === 'done') {
      const r = cloud.result
      const plan = r?.plan
      const outDur = r?.output?.durationMs ?? plan?.keptMs
      return (
        <div className="h-dvh flex flex-col bg-white">
          <Header hasJob onNew={newVideo} />
          <main className="flex-1 grid place-items-center p-6 overflow-y-auto">
            <div className="w-full max-w-lg -mt-6 space-y-5 py-6">
              <div className="text-center">
                <div className="inline-grid place-items-center w-16 h-16 rounded-3xl bg-green-50 mb-4">
                  <CheckCircle2 className="w-8 h-8 text-green-600" />
                </div>
                <h1 className="text-3xl font-black">تم القص 🎉</h1>
                {r?.meta && (
                  <p className="text-zinc-500 mt-1 text-sm">
                    {r.meta.width}×{r.meta.height} — الأصل {fmtTime(plan?.durationMs || r.meta.durationMs)}
                  </p>
                )}
              </div>

              {r?.resultUrl ? (
                <a href={r.resultUrl} target="_blank" rel="noopener"
                  className="w-full h-14 rounded-2xl bg-orange-500 hover:bg-orange-600 active:scale-[0.99] text-white font-black text-lg shadow-lg shadow-orange-500/25 transition flex items-center justify-center gap-2.5">
                  <Download className="w-5 h-5" />
                  نزّل النتيجة (رابط دائم)
                </a>
              ) : (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  القص خلص بس حفظ النتيجة على التخزين السحابي حصل فيه مشكلة — جرّب تقصّه تاني أو استخدم النسخة الكاملة.
                </div>
              )}

              {r?.original && (
                <a href={r.original} target="_blank" rel="noopener"
                  className="w-full h-11 rounded-2xl border border-zinc-200 hover:border-orange-300 text-zinc-700 font-bold transition flex items-center justify-center gap-2 text-sm">
                  <ExternalLink className="w-4 h-4" /> الفيديو الأصلي على التخزين
                </a>
              )}

              {plan && (
                <section className="rounded-2xl border border-zinc-200 overflow-hidden">
                  <div className="px-4 pt-4 pb-2 font-black text-sm text-zinc-900">النتيجة</div>
                  <div className="px-4 pb-4 space-y-2.5 text-sm">
                    <Row label="المدة الأصلية" value={fmtTime(plan.durationMs)} />
                    <Row label="المدة بعد القص" value={fmtTime(outDur || plan.keptMs)} />
                    <Row label="فجوات اتشالت" value={String(plan.cutsCount).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[+d])} />
                    <div className="flex items-center justify-between pt-2.5 border-t border-zinc-100">
                      <span className="text-zinc-500">التوفير</span>
                      <span className="font-black text-orange-600 text-lg tabular-nums">
                        {fmtTime(plan.savedMs)} <span className="text-sm">({Math.round((plan.savedMs / Math.max(1, plan.durationMs)) * 100)}%)</span>
                      </span>
                    </div>
                  </div>
                </section>
              )}

              {cloud.ref && (
                <details className="rounded-2xl border border-zinc-200 p-4">
                  <summary className="cursor-pointer text-sm font-black">جرّب إعدادات تانية؟ (من غير إعادة رفع)</summary>
                  <div className="mt-4 space-y-4">
                    <CutSettings gapMs={gapMs} thr={thr} crf={crf} onGap={setGapMs} onThr={setThr} onCrf={setCrf} />
                    <button onClick={() => runCloudCut(cloud.ref!)}
                      className="w-full h-12 rounded-2xl bg-orange-500 hover:bg-orange-600 text-white font-bold transition flex items-center justify-center gap-2">
                      <Zap className="w-4 h-4" /> قصّه تاني بالإعدادات الجديدة
                    </button>
                  </div>
                </details>
              )}

              <p className="text-center text-[11px] text-zinc-400 leading-relaxed">
                الملفات محفوظة على Bunny Storage — النتيجة بتترجع في نفس مكان الأصل، والروابط الموقّعة بتفتح لمدة أسبوع من وقت القص.
              </p>

              <button onClick={newVideo}
                className="w-full h-11 rounded-2xl border border-zinc-200 hover:border-orange-300 text-zinc-700 font-bold transition flex items-center justify-center gap-2 text-sm">
                <Upload className="w-4 h-4" /> فيديو جديد
              </button>
            </div>
          </main>
        </div>
      )
    }

    /* ---- cloud: error ---- */
    if (cloud?.phase === 'error') {
      return (
        <div className="h-dvh flex flex-col bg-white">
          <Header hasJob onNew={newVideo} />
          <main className="flex-1 grid place-items-center p-6">
            <div className="w-full max-w-lg -mt-10 rounded-3xl border border-red-200 bg-red-50/50 p-8 shadow-sm">
              <div className="flex items-center gap-4 mb-5">
                <div className="grid place-items-center w-12 h-12 rounded-2xl bg-red-100">
                  <AlertTriangle className="w-6 h-6 text-red-600" />
                </div>
                <div className="font-black text-lg">حصل خطأ</div>
              </div>
              <p className="text-sm text-red-700 leading-relaxed">{cloud.error || 'خطأ غير معروف'}</p>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                {cloud.ref && (
                  <button onClick={() => runCloudCut(cloud.ref!)}
                    className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 h-10 text-sm font-bold text-white shadow-sm transition hover:bg-orange-600">
                    <RefreshCw className="w-4 h-4" /> إعادة محاولة القص
                  </button>
                )}
                <button onClick={newVideo}
                  className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 h-10 text-sm font-bold text-zinc-700 transition hover:border-orange-300">
                  فيديو جديد
                </button>
              </div>
              <div className="mt-5 pt-4 border-t border-red-100">
                <p className="text-xs text-red-600 leading-relaxed mb-2">الفيلم كبير أو الاستضافة بطيئة؟ النسخة الكاملة المجانية بتاخد أي حجم:</p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <a href="https://colab.research.google.com/github/mrmoneimofficial-del/autocut/blob/main/colab.ipynb"
                    target="_blank" rel="noopener"
                    className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-orange-500 px-3.5 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-orange-600">
                    <Rocket className="w-3.5 h-3.5" /> Google Colab
                  </a>
                  <a href="https://codespaces.new/mrmoneimofficial-del/autocut"
                    target="_blank" rel="noopener"
                    className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-3.5 py-2 text-xs font-bold text-zinc-700 shadow-sm transition hover:border-orange-300">
                    <Github className="w-3.5 h-3.5" /> GitHub Codespaces
                  </a>
                </div>
              </div>
            </div>
          </main>
        </div>
      )
    }
  }

  /* ------------------------------------------------- render: server mode landing */
  if (!job && !uploading) {
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
              <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center gap-2 flex-wrap">
                <AlertTriangle className="w-4 h-4 shrink-0" /> {jobErr}
                {retryFile && (
                  <button onClick={() => filePickRef.current(retryFile)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 h-8 text-xs font-bold text-white hover:bg-orange-600 transition">
                    <RefreshCw className="w-3.5 h-3.5" /> إعادة الرفع
                  </button>
                )}
              </div>
            )}

            {savedUpload && resumeInfo && (
              <ResumeCard saved={savedUpload} info={resumeInfo} onPick={(f) => filePickRef.current(f)} onDismiss={() => {
                try { localStorage.removeItem('qattaas:upload') } catch { /* noop */ }
                setSavedUpload(null); setResumeInfo(null)
              }} />
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
                if (f) filePickRef.current(f)
              }}
            >
              <input type="file" accept="video/*" className="sr-only"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) filePickRef.current(f) }} />
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
        {dragOver && !job && !uploading && (
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

  /* ------------------------------------------- render: upload progress (server) */
  if (!job && uploading) {
    return (
      <div className="h-dvh flex flex-col bg-white">
        <Header hasJob onNew={newVideo} />
        <main className="flex-1 grid place-items-center p-6">
          <div className="w-full max-w-lg -mt-10 space-y-4">
            <UploadPanel
              fileName={upFileName}
              fileSize={chunkProgress?.totalBytes ?? simpleProgress?.total ?? 0}
              chunkProgress={chunkProgress}
              simpleProgress={simpleProgress}
              chunkHandle={chunkHandle.current}
              onCancel={cancelUpload}
            />
            <p className="text-center text-xs text-zinc-400 leading-relaxed">
              الفيديو بيترفع بقطع صغيرة ذكية بتتكيّف مع اتصالك — لو الشبكة ضعيفة بيصغّر القطعة ويكمّل من نفس النقطة، وبعدها بيبدأ التحليل فورًا.
            </p>
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
                  بنحفظ النتيجة على التخزين…
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

            {/* action: storage upload (non-blocking bonus) */}
            {phase === 'mirroring' && (
              <section className="rounded-2xl border border-orange-200 bg-orange-50/50 p-4 space-y-2">
                <div className="flex items-center gap-2 text-sm font-bold text-orange-700">
                  <CloudUpload className="w-4 h-4 shrink-0" />
                  بنحفظ النتيجة على التخزين السحابي…
                </div>
                <p className="text-xs text-zinc-500 leading-relaxed">دي مش بتأخر تحميلك — النتيجة جاهزة ونزّلها من الزر البرتقالي تحت، والرابط الدائم هيظهر هنا خلال لحظات ويعيش حتى بعد ما السيرفر يقفل.</p>
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
                {job!.resultUrl && (
                  <a
                    href={job!.resultUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full h-11 rounded-2xl border border-zinc-200 hover:border-orange-300 text-zinc-700 font-bold transition flex items-center justify-center gap-2 text-sm"
                  >
                    <ExternalLink className="w-4 h-4" />
                    رابط دائم من Bunny Storage
                  </a>
                )}
                {job!.originalUrl && (
                  <a
                    href={job!.originalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full h-11 rounded-2xl border border-zinc-200 hover:border-orange-300 text-zinc-700 font-bold transition flex items-center justify-center gap-2 text-sm"
                  >
                    <Film className="w-4 h-4" />
                    الأصل على التخزين السحابي
                  </a>
                )}
                <div className="flex items-center justify-center gap-4 text-xs text-zinc-400 tabular-nums">
                  <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {fmtTime(job!.output.durationMs)}</span>
                  <span className="flex items-center gap-1"><HardDrive className="w-3 h-3" /> {fmtMB(job!.output.size)}</span>
                  <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-orange-500" /> تزامن 100%</span>
                </div>
                {job!.resultUrl ? (
                  <p className="text-center text-[11px] text-zinc-400 leading-relaxed">
                    اللينك الدائم من Bunny Storage — النتيجة محفوظة جنب الفيديو الأصلي على نفس التخزين.
                  </p>
                ) : (
                  <p className="text-center text-[11px] text-zinc-400 leading-relaxed">
                    التخزين السحابي مش متظبط على السيرفر ده — النتيجة محفوظة محليًا ونزّلها من الزر البرتقالي.
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

/** interrupted-upload resume card — the attached system's resume mechanism surfaced in the UI */
function ResumeCard({ saved, info, onPick, onDismiss }: {
  saved: SavedUpload
  info: { done: number; total: number }
  onPick: (f: File) => void
  onDismiss: () => void
}) {
  const pct = info.total > 0 ? Math.round((info.done / info.total) * 100) : 0
  return (
    <div className="mb-4 rounded-2xl border border-orange-200 bg-orange-50/50 p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className="grid place-items-center w-10 h-10 rounded-2xl bg-orange-500/10 shrink-0">
          <RefreshCw className="w-5 h-5 text-orange-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-bold truncate text-sm">{saved.fileName}</div>
          <div className="text-xs text-zinc-500">
            {info.done >= info.total
              ? 'الرفع خلص خلاص — اختار نفس الملف وهنكمّل فورًا'
              : `${fmtBytesCard(info.done)} من ${fmtBytesCard(saved.fileSize)} اترفعوا خلاص`}
          </div>
        </div>
        <button onClick={onDismiss} title="تجاهل"
          className="w-8 h-8 rounded-md hover:bg-orange-100 flex items-center justify-center text-zinc-400 hover:text-zinc-700 transition shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="h-2 rounded-full bg-orange-100 overflow-hidden mb-3">
        <div className="h-full rounded-full bg-orange-500" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <label className="group flex flex-col items-center gap-1.5 rounded-xl border-2 border-dashed border-orange-300 bg-white px-4 py-5 cursor-pointer transition hover:border-orange-400 hover:bg-orange-50/40">
        <input type="file" accept="video/*" className="sr-only"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f) }} />
        <Upload className="w-5 h-5 text-orange-500" />
        <span className="font-bold text-sm">اختار نفس الملف — «{saved.fileName}»</span>
        <span className="text-[11px] text-zinc-500">لازم نفس الملف بالظبط (الاسم والحجم) عشان نتأكد إنه هو هو</span>
      </label>
    </div>
  )
}

/** upload screen frame — header + the shared UploadProgressCard (both modes) */
function UploadPanel({ fileName, fileSize, chunkProgress, simpleProgress, chunkHandle, onCancel }: {
  fileName: string
  fileSize: number
  chunkProgress: ChunkProgress | null
  simpleProgress: { loaded: number; total: number; percent: number } | null
  chunkHandle: ChunkedUploadHandle | null
  onCancel: () => void
}) {
  return (
    <div className="rounded-3xl border border-zinc-200 p-8 shadow-sm">
      <div className="flex items-center gap-4 mb-6">
        <div className="grid place-items-center w-12 h-12 rounded-2xl bg-orange-500/10">
          <Film className="w-6 h-6 text-orange-500" />
        </div>
        <div className="min-w-0">
          <div className="font-bold truncate">{fileName || '…'}</div>
          <div className="text-sm text-zinc-500">{fmtBytesCard(fileSize)}</div>
        </div>
      </div>
      <UploadProgressCard
        fileName={fileName || 'فيديو'}
        chunkProgress={chunkProgress}
        simpleProgress={simpleProgress}
        chunkHandle={chunkHandle}
        onCancel={onCancel}
        mergingLabel="بنجهّز الملف على السيرفر…"
      />
    </div>
  )
}

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

/** compact 3-select settings card — shared by cloud dropzone + cloud re-cut */
function CutSettings({ gapMs, thr, crf, onGap, onThr, onCrf }: {
  gapMs: number; thr: number; crf: number
  onGap: (v: number) => void; onThr: (v: number) => void; onCrf: (v: number) => void
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <Setting label="الفجوة بين الكلام">
        <select value={gapMs} onChange={(e) => onGap(+e.target.value)} className={selCls}>
          <option value={100}>0.1 ثانية</option>
          <option value={200}>0.2 ثانية</option>
          <option value={300}>0.3 ثانية</option>
        </select>
      </Setting>
      <Setting label="حساسية الكشف">
        <select value={thr} onChange={(e) => onThr(+e.target.value)} className={selCls}>
          <option value={-40}>ناعمة</option>
          <option value={-35}>متوازنة</option>
          <option value={-30}>خفيفة</option>
        </select>
      </Setting>
      <Setting label="الجودة">
        <select value={crf} onChange={(e) => onCrf(+e.target.value)} className={selCls}>
          <option value={28}>عالية</option>
          <option value={32}>متوازنة</option>
          <option value={36}>أصغر حجمًا</option>
        </select>
      </Setting>
    </div>
  )
}

const selCls =
  'w-full h-10 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800 focus:border-orange-400 focus:ring-2 focus:ring-orange-100 outline-none transition cursor-pointer disabled:opacity-50'
