'use client'

/**
 * AutoCut Studio shell — orchestrates the whole workflow:
 *   Upload → Analyze → Review → Preview → Render → Result
 * The uploaded original is never modified; every stage is reversible.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStudio } from '@/lib/autocut/store'
import { buildRenderPlan } from '@/lib/autocut/planner'
import { seekPlayer, currentPlayheadMs } from '@/components/autocut/player'
import { Player } from '@/components/autocut/player'
import { TimelineCanvas } from '@/components/autocut/timeline-canvas'
import { ManualCutBar } from '@/components/autocut/manual-cut-bar'
import { ControlsPanel } from '@/components/autocut/controls-panel'
import { RegionsTable } from '@/components/autocut/regions-table'
import { TranscriptPanel } from '@/components/autocut/transcript-panel'
import { usePlayhead } from '@/lib/autocut/playhead'
import { fmtBytes, fmtDuration, fmtEta, fmtPct, fmtSpeed } from '@/lib/autocut/format'
import { ACTIVE_STATUSES, isSmartKind } from '@/lib/autocut/types'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  UploadCloud,
  Pause,
  Play,
  X,
  RefreshCw,
  Scissors,
  CheckCircle2,
  AlertTriangle,
  Clock,
  HardDrive,
  FileVideo,
  ChevronDown,
  Cpu,
  Undo2,
  Redo2,
  Trash2,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// ---------------------------------------------------------------------------

export function AutoCutStudio() {
  const job = useStudio((s) => s.job)
  const jobs = useStudio((s) => s.jobs)
  const bootstrap = useStudio((s) => s.bootstrap)
  const refreshJob = useStudio((s) => s.refreshJob)
  const hydrated = useStudio((s) => s.hydrated)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  // poll active jobs (analysis/render progress)…
  const active = job && ACTIVE_STATUSES.includes(job.status) && job.status !== 'uploading'
  useEffect(() => {
    if (!job) return
    if (active) {
      const iv = setInterval(() => void refreshJob(), 1500)
      return () => clearInterval(iv)
    }
    // …and keep a slow heartbeat while idle, so a job deleted / expired
    // server-side (other tab, cleanup sweep) clears the view instead of
    // leaving the user on a dead "Media unavailable" screen.
    const iv = setInterval(() => void refreshJob(), 20000)
    return () => clearInterval(iv)
  }, [active, refreshJob, job?.id, job?.status])

  if (!hydrated) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Cpu className="h-4 w-4 animate-pulse" /> Opening studio…
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen w-full flex-col bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1600px] items-center gap-3 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-amber-500">
              <Scissors className="h-4 w-4 text-black" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight">AutoCut Studio</div>
              <div className="text-[10px] text-zinc-500">Professional silence removal for long-form video</div>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {job && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 border-zinc-800 bg-zinc-900 text-xs text-zinc-300 hover:border-amber-700/60 hover:bg-zinc-800 hover:text-amber-300"
                onClick={() => useStudio.getState().newUpload()}
              >
                <UploadCloud className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">New upload</span>
              </Button>
            )}
            {job && (
              <div className="hidden items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 md:flex">
                <FileVideo className="h-3.5 w-3.5 text-zinc-500" />
                <span className="max-w-[220px] truncate text-xs text-zinc-300">{job.filename}</span>
                <StatusBadge status={job.status} />
              </div>
            )}
            <JobsMenu />
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 px-4 py-4">
        {!job && <UploadStage />}
        {job && <JobStage />}
      </main>

      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950">
        <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center justify-between gap-1.5 px-4 py-2 text-[10px] text-zinc-600">
          <span>
            Runs entirely server-side — your browser stays light. Files are removed automatically after 24 hours.
          </span>
          <span className="flex items-center gap-1">
            <ShieldCheck className="h-3 w-3" /> Original uploads are never modified
          </span>
        </div>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------- header bits

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    uploading: { label: 'Uploading', cls: 'bg-zinc-800 text-zinc-300 border-zinc-700' },
    ready: { label: 'Ready', cls: 'bg-zinc-800 text-zinc-300 border-zinc-700' },
    queued_analyze: { label: 'Queued', cls: 'bg-amber-950/60 text-amber-300 border-amber-800/60' },
    analyzing: { label: 'Analyzing', cls: 'bg-amber-950/60 text-amber-300 border-amber-800/60' },
    detected: { label: 'Review cuts', cls: 'bg-emerald-950/60 text-emerald-300 border-emerald-800/60' },
    queued_render: { label: 'Queued', cls: 'bg-amber-950/60 text-amber-300 border-amber-800/60' },
    rendering: { label: 'Rendering', cls: 'bg-amber-950/60 text-amber-300 border-amber-800/60' },
    finalizing: { label: 'Finalizing', cls: 'bg-amber-950/60 text-amber-300 border-amber-800/60' },
    done: { label: 'Done', cls: 'bg-emerald-950/60 text-emerald-300 border-emerald-800/60' },
    failed: { label: 'Failed', cls: 'bg-red-950/60 text-red-300 border-red-800/60' },
    canceled: { label: 'Canceled', cls: 'bg-zinc-800 text-zinc-400 border-zinc-700' },
  }
  const s = map[status] ?? { label: status, cls: 'bg-zinc-800 text-zinc-300 border-zinc-700' }
  return (
    <span className={cn('rounded-sm border px-1.5 py-0.5 text-[10px] font-medium', s.cls)}>{s.label}</span>
  )
}

function JobsMenu() {
  const jobs = useStudio((s) => s.jobs)
  const job = useStudio((s) => s.job)
  const openJob = useStudio((s) => s.openJob)
  const deleteJob = useStudio((s) => s.deleteJob)
  const refreshJobs = useStudio((s) => s.refreshJobs)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 border-zinc-800 bg-zinc-900 text-xs text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800">
          <Clock className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Jobs</span>
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 border-zinc-800 bg-zinc-900">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-zinc-500">المشاريع</DropdownMenuLabel>
        {jobs.length === 0 && <div className="px-3 py-4 text-center text-xs text-zinc-600">مفيش مشاريع لسه</div>}
        {jobs.slice(0, 10).map((j) => (
          <DropdownMenuItem key={j.id} className="group gap-2 py-2" onSelect={() => void openJob(j.id)}>
            <FileVideo className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-zinc-200">{j.filename}</div>
              <div className="text-[10px] text-zinc-500">
                {fmtBytes(j.sizeBytes)} · <StatusInline status={j.status} />
                {j.stats ? ` · وفّر ${fmtPct(j.stats.savedPct)}` : ''}
              </div>
            </div>
            {job?.id === j.id && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-amber-400" />}
            <button
              className="hidden rounded p-1 text-zinc-500 hover:text-red-400 group-hover:block"
              onClick={e => {
                e.stopPropagation()
                if (job?.id === j.id) {
                  void deleteJob()
                } else {
                  // delete without switching the open job
                  void fetch(`/api/autocut/jobs/${j.id}`, {
                    method: 'DELETE',
                    headers: { 'x-owner-token': localStorage.getItem('autocut-owner-token') ?? '' },
                  }).then(() => refreshJobs())
                }
              }}
              aria-label="Delete job"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function StatusInline({ status }: { status: string }) {
  const map: Record<string, string> = {
    uploading: 'بيرفع…',
    ready: 'جاهز',
    queued_analyze: 'في انتظار التحليل',
    analyzing: 'بيحلّل…',
    detected: 'جاهز للمونتاج',
    queued_render: 'في انتظار التصدير',
    rendering: 'بيصدّر…',
    finalizing: 'بيخلّص…',
    done: 'مقصوص ✓ جاهز',
    failed: 'فشل',
    canceled: 'أُلغي',
  }
  return <span>{map[status] ?? status}</span>
}

// ---------------------------------------------------------------- upload

function UploadStage() {
  const startUpload = useStudio((s) => s.startUpload)
  const upload = useStudio((s) => s.upload)
  const smartMode = useStudio((s) => s.smartMode)
  const setSmartMode = useStudio((s) => s.setSmartMode)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const pick = useCallback(() => inputRef.current?.click(), [])

  const onFiles = useCallback(
    (files: FileList | null) => {
      const f = files?.[0]
      if (!f) return
      if (f.size > 32 * 1024 * 1024 * 1024) {
        toast.error('File too large', { description: 'The maximum supported size is 32 GB.' })
        return
      }
      void startUpload(f)
    },
    [startUpload]
  )

  return (
    <section className="flex flex-1 items-center justify-center py-10">
      <div className="w-full max-w-xl">
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload a video"
          onClick={pick}
          onKeyDown={(e) => e.key === 'Enter' && pick()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            onFiles(e.dataTransfer.files)
          }}
          className={cn(
            'flex flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed p-10 text-center transition-colors',
            dragging ? 'border-amber-500 bg-amber-500/5' : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900/70'
          )}
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-zinc-800/80">
            <UploadCloud className="h-6 w-6 text-amber-400" />
          </div>
          <div>
            <div className="text-base font-medium">Drop a video here</div>
            <div className="mt-1 text-xs text-zinc-500">or click to browse — up to 32 GB / 4+ hours</div>
          </div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {['MP4', 'MOV', 'MKV', 'WebM', 'AVI', 'MPG'].map((f) => (
              <span key={f} className="rounded-sm border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
                {f}
              </span>
            ))}
          </div>
          <div className="text-[11px] leading-relaxed text-zinc-600">
            Chunked & resumable upload · server-side FFmpeg analysis and rendering ·
            <br />
            your browser only previews and controls the process.
          </div>
          <input ref={inputRef} type="file" accept="video/*,audio/*,.mkv,.avi,.mov" className="hidden" onChange={(e) => onFiles(e.target.files)} />
        </div>

        {/* المونتاج الذكي — smart edit toggle */}
        <div
          className={cn(
            'mt-4 rounded-xl border p-4 transition-colors',
            smartMode ? 'border-amber-700/70 bg-amber-950/20' : 'border-zinc-800 bg-zinc-900/40'
          )}
        >
          <label className="flex cursor-pointer items-start gap-3" htmlFor="smart-mode-toggle">
            <Switch
              id="smart-mode-toggle"
              checked={smartMode}
              onCheckedChange={setSmartMode}
              className="mt-0.5 data-[state=checked]:bg-amber-600"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-100">
                <Sparkles className="h-4 w-4 text-amber-400" />
                المونتاج الذكي
                <span className="rounded-sm border border-amber-800/60 bg-amber-950/40 px-1 py-px text-[9px] uppercase tracking-wider text-amber-400">تجريبي</span>
              </div>
              <div className="mt-1 text-xs leading-relaxed text-zinc-500" dir="rtl">
                شيل الحشو (اممم، يعني، اه)، الجمل المكررة، والبدايات الغلط — مش بس الصمت.
                <br />
                الذكاء الاصطناعي بفرّغ الكلام ويرشّح الجمل اللي تتشال، وانت تراجعها وتوافق قبل التنفيذ.
              </div>
            </div>
          </label>
        </div>

        <div className="mt-6 grid gap-2 text-[11px] text-zinc-600">
          <div className="flex items-center gap-2">
            <HardDrive className="h-3.5 w-3.5" />
            Uploads, renders and previews are private to this browser session and auto-deleted after 24 h.
          </div>
          <div className="flex items-center gap-2">
            <Undo2 className="h-3.5 w-3.5" />
            Nothing is destructive: the original file is preserved untouched for every job.
          </div>
        </div>
        {upload.phase === 'error' && (
          <div className="mt-4 rounded-lg border border-red-900/60 bg-red-950/40 p-3 text-xs text-red-300">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="h-3.5 w-3.5" /> Upload failed
            </div>
            <div className="mt-1 text-red-400/80">{upload.error}</div>
          </div>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- job stages

function JobStage() {
  const job = useStudio((s) => s.job)
  const editingAfterRender = useStudio((s) => s.editingAfterRender)
  if (!job) return null

  if (job.status === 'uploading') return <UploadProgress />
  if (['queued_analyze', 'analyzing'].includes(job.status)) return <ProcessingProgress phase="analysis" />
  if (['queued_render', 'rendering', 'finalizing'].includes(job.status)) return <ProcessingProgress phase="render" />
  if (job.status === 'failed') return <FailedStage />
  if (job.status === 'done') return <Editor done={!editingAfterRender} />
  return <Editor />
}

// ---------------------------------------------------------------- uploading

function UploadProgress() {
  const job = useStudio((s) => s.job)
  const upload = useStudio((s) => s.upload)
  const uploader = useStudio((s) => s.uploader)
  const resumeFile = useStudio((s) => s.resumeFile)
  const attachResumeFile = useStudio((s) => s.attachResumeFile)
  const pauseUpload = useStudio((s) => s.pauseUpload)
  const resumeUpload = useStudio((s) => s.resumeUpload)
  const cancelUpload = useStudio((s) => s.cancelUpload)
  const fileRef = useRef<HTMLInputElement>(null)
  const [resumeError, setResumeError] = useState<string | null>(null)

  const total = upload.totalBytes || job?.sizeBytes || 0
  const pct = total > 0 ? Math.min(100, (upload.sentBytes / total) * 100) : 0
  const pausedResume = upload.phase === 'paused' && !!resumeFile

  // Stall hint: while "uploading", if the byte counter has not moved for 45 s
  // the connection is wedged (or the tab runs pre-fix code) — offer a reload;
  // the upload is resumable, so nothing is lost.
  const [stalled, setStalled] = useState(false)
  const lastBytesRef = useRef({ bytes: upload.sentBytes, at: Date.now() })
  useEffect(() => {
    if (upload.phase !== 'uploading') {
      setStalled(false)
      return
    }
    const lb = lastBytesRef.current
    if (upload.sentBytes !== lb.bytes) {
      lastBytesRef.current = { bytes: upload.sentBytes, at: Date.now() }
      setStalled(false)
    }
    const iv = setInterval(() => {
      const l = lastBytesRef.current
      if (Date.now() - l.at > 45_000) setStalled(true)
    }, 5000)
    return () => clearInterval(iv)
  }, [upload.phase, upload.sentBytes])

  return (
    <section className="flex flex-1 items-center justify-center py-10">
      <div className="w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800">
            <UploadCloud className="h-5 w-5 text-amber-400" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{job?.filename}</div>
            <div className="text-xs text-zinc-500">
              {fmtBytes(upload.sentBytes)} of {fmtBytes(total)} · {fmtSpeed(upload.speedBps)}
            </div>
          </div>
          <StatusBadge status="uploading" />
        </div>

        <div className="mt-5">
          <Progress value={pct} className="h-2 bg-zinc-800 [&>div]:bg-amber-500" />
          <div className="mt-1.5 flex justify-between font-mono text-[11px] text-zinc-500">
            <span>{pct.toFixed(1)}%</span>
            <span>{upload.phase === 'paused' ? 'PAUSED' : upload.phase === 'error' ? 'ERROR' : 'UPLOADING'}</span>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {upload.phase === 'uploading' && (
            <Button variant="outline" size="sm" className="gap-1.5 border-zinc-700 bg-zinc-900 text-xs" onClick={pauseUpload}>
              <Pause className="h-3.5 w-3.5" /> Pause
            </Button>
          )}
          {upload.phase === 'paused' && !pausedResume && (
            <Button variant="outline" size="sm" className="gap-1.5 border-zinc-700 bg-zinc-900 text-xs" onClick={resumeUpload}>
              <Play className="h-3.5 w-3.5" /> Resume
            </Button>
          )}
          <Button variant="outline" size="sm" className="gap-1.5 border-zinc-800 bg-zinc-900 text-xs text-red-400 hover:bg-red-950/30" onClick={cancelUpload}>
            <X className="h-3.5 w-3.5" /> Discard upload
          </Button>
        </div>

        {stalled && upload.phase === 'uploading' && (
          <div className="mt-4 rounded-lg border border-amber-900/50 bg-amber-950/30 p-3 text-xs text-amber-300">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="h-3.5 w-3.5" /> The upload seems stalled
            </div>
            <div className="mt-0.5 text-amber-400/80">
              Nothing has moved for a while — the connection may be wedged. Reload the page and re-select the same
              file: already-sent parts are kept, so the upload continues instead of restarting.
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 gap-1.5 border-amber-900/60 text-xs text-amber-300"
              onClick={() => window.location.reload()}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Reload & resume
            </Button>
          </div>
        )}

        {upload.phase === 'error' && (
          <div className="mt-4 rounded-lg border border-red-900/60 bg-red-950/40 p-3 text-xs text-red-300">
            <div className="font-medium">The upload was interrupted</div>
            <div className="mt-0.5 text-red-400/80">{upload.error ?? 'Network error'}</div>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 gap-1.5 border-red-900/60 text-xs text-red-300"
              onClick={() => uploader?.resume()}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Retry upload
            </Button>
          </div>
        )}

        {pausedResume && (
          <div className="mt-4 rounded-lg border border-amber-900/50 bg-amber-950/30 p-3 text-xs text-amber-300">
            <div className="flex items-center gap-1.5 font-medium">
              <Clock className="h-3.5 w-3.5" /> Resume interrupted upload
            </div>
            <div className="mt-1 text-amber-400/80">
              {fmtBytes(upload.sentBytes)} of {fmtBytes(total)} are already on the server. Re-select the same file to continue
              where it stopped — nothing restarts from zero.
            </div>
            {resumeError && <div className="mt-1 text-red-400">{resumeError}</div>}
            <Button variant="outline" size="sm" className="mt-2 gap-1.5 border-amber-900/60 text-xs text-amber-300" onClick={() => fileRef.current?.click()}>
              <UploadCloud className="h-3.5 w-3.5" /> Select “{resumeFile?.name}”
            </Button>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (!f) return
                attachResumeFile(f).catch((err) => setResumeError(String(err?.message ?? err)))
              }}
            />
          </div>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- processing

const STAGE_LABELS: Record<string, string> = {
  upload: 'Upload',
  probe: 'Reading metadata',
  envelope: 'Extracting audio',
  detect: 'Detecting silence',
  review: 'Review',
  render: 'Rendering',
  concat: 'Merging sections',
  finalize: 'Finalizing',
  done: 'Done',
  error: 'Error',
}

function ProcessingProgress({ phase }: { phase: 'analysis' | 'render' }) {
  const job = useStudio((s) => s.job)
  const cancelJob = useStudio((s) => s.cancelJob)
  const startedRef = useRef(Date.now())
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => setElapsed((Date.now() - startedRef.current) / 1000), 1000)
    return () => clearInterval(iv)
  }, [])

  const stageOrder =
    phase === 'analysis'
      ? ['probe', 'envelope', 'detect', 'review']
      : ['render', 'concat', 'finalize', 'done']
  const stageIdx = Math.max(0, stageOrder.indexOf(job?.stage ?? ''))
  const pct = job?.progress ?? 0

  return (
    <section className="flex flex-1 items-center justify-center py-10">
      <div className="w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8">
        <div className="flex items-center gap-3">
          <div className="relative flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800">
            {phase === 'analysis' ? <Cpu className="h-5 w-5 animate-pulse text-amber-400" /> : <Scissors className="h-5 w-5 animate-pulse text-amber-400" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{job?.filename}</div>
            <div className="text-xs text-zinc-500">
              {phase === 'analysis' ? 'Server-side analysis in progress' : 'Server-side rendering in progress'}
            </div>
          </div>
          <StatusBadge status={job?.status ?? ''} />
        </div>

        <div className="mt-5">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-xs font-medium text-zinc-300">{job?.stageMessage ?? 'Working…'}</span>
            <span className="font-mono text-xs text-amber-400">{pct.toFixed(1)}%</span>
          </div>
          <Progress value={pct} className="h-2 bg-zinc-800 [&>div]:bg-amber-500" />
          <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-zinc-500 sm:grid-cols-4">
            <span>
              stage <span className="text-zinc-300">{STAGE_LABELS[job?.stage ?? ''] ?? job?.stage}</span>
            </span>
            <span>
              elapsed <span className="text-zinc-300">{fmtEta(elapsed)}</span>
            </span>
            <span>
              remaining <span className="text-zinc-300">{job?.etaSeconds != null ? fmtEta(job.etaSeconds) : '—'}</span>
            </span>
            <span>
              duration <span className="text-zinc-300">{job?.meta ? fmtDuration(job.meta.durationMs, { compact: true }) : '—'}</span>
            </span>
          </div>
        </div>

        {/* stage rail */}
        <div className="mt-5 flex items-center gap-1.5">
          {stageOrder.map((s, i) => (
            <div key={s} className="flex-1">
              <div
                className={cn(
                  'h-1 rounded-full',
                  i < stageIdx ? 'bg-emerald-600' : i === stageIdx ? 'bg-amber-500' : 'bg-zinc-800'
                )}
              />
              <div className={cn('mt-1 text-center text-[9px] uppercase tracking-wide', i <= stageIdx ? 'text-zinc-400' : 'text-zinc-700')}>
                {STAGE_LABELS[s]}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <div className="text-[11px] text-zinc-600">
            You can close this tab — processing continues on the server and resumes here when you return.
          </div>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto gap-1.5 border-zinc-800 bg-zinc-900 text-xs text-red-400 hover:bg-red-950/30"
            onClick={() => void cancelJob()}
          >
            <X className="h-3.5 w-3.5" /> Cancel processing
          </Button>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- failed

function FailedStage() {
  const job = useStudio((s) => s.job)
  const retryJob = useStudio((s) => s.retryJob)
  const deleteJob = useStudio((s) => s.deleteJob)
  const backToEditor = useStudio((s) => s.backToEditor)
  const err = job?.error
  const canEdit = !!job?.meta // envelope may exist → allow going back to review

  return (
    <section className="flex flex-1 items-center justify-center py-10">
      <div className="w-full max-w-2xl rounded-2xl border border-red-900/50 bg-red-950/20 p-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-950">
            <AlertTriangle className="h-5 w-5 text-red-400" />
          </div>
          <div>
            <div className="text-sm font-medium text-red-200">{err?.code?.replace(/_/g, ' ').toLowerCase() ?? 'processing failed'}</div>
            <div className="text-xs text-red-400/70">{job?.filename}</div>
          </div>
        </div>
        <div className="mt-4 text-xs leading-relaxed text-red-300/90">{err?.message ?? 'An unexpected error occurred.'}</div>
        {err?.details && (
          <details className="mt-2 rounded-md border border-red-900/40 bg-black/30 p-2">
            <summary className="cursor-pointer text-[11px] text-red-400/70">Technical details</summary>
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-red-400/60">{err.details}</pre>
          </details>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" className="gap-1.5 bg-amber-500 text-xs font-medium text-black hover:bg-amber-400" onClick={() => void retryJob()}>
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </Button>
          {canEdit && (
            <Button variant="outline" size="sm" className="gap-1.5 border-zinc-700 bg-zinc-900 text-xs text-zinc-300" onClick={() => void backToEditor()}>
              <Undo2 className="h-3.5 w-3.5" /> Back to cut review
            </Button>
          )}
          <Button variant="outline" size="sm" className="gap-1.5 border-zinc-800 bg-zinc-900 text-xs text-red-400 hover:bg-red-950/30" onClick={() => void deleteJob()}>
            <Trash2 className="h-3.5 w-3.5" /> Delete job
          </Button>
        </div>
        <div className="mt-3 text-[11px] text-zinc-600">
          Retrying is safe: finished render sections and the loudness map are kept.
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- editor

function Editor({ done }: { done?: boolean }) {
  const job = useStudio((s) => s.job)
  const decisions = useStudio((s) => s.decisions)
  const smartInfo = useStudio((s) => s.smartInfo)
  const transcript = useStudio((s) => s.transcript)
  const canUndo = useStudio((s) => s.canUndo)
  const canRedo = useStudio((s) => s.canRedo)
  const undo = useStudio((s) => s.undo)
  const redo = useStudio((s) => s.redo)

  // Professional montage keyboard shortcuts (editor mode only)
  useEffect(() => {
    if (done) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const st = useStudio.getState()
      if (!st.decisions || !st.job?.meta) return
      // Undo/redo work even with modifiers — handled before the modifier bail
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) st.redo()
        else st.undo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        st.redo()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const ph = Math.round(currentPlayheadMs())
      switch (e.key) {
        case 'i':
        case 'I':
          st.setMarkIn(ph)
          break
        case 'o':
        case 'O':
          st.setMarkOut(ph)
          break
        case 'a':
        case 'A':
        case 'Enter':
          if (st.markInMs != null && st.markOutMs != null) {
            e.preventDefault()
            st.addManualRegion()
          }
          break
        case 'Escape':
          st.clearMarks()
          break
        case 'ArrowRight':
        case 'ArrowLeft': {
          // Jump between cuts: boundaries of remove/compress regions
          const bounds = [...new Set(st.decisions.regions.flatMap((r) =>
            r.action === 'remove' || r.action === 'compress' ? [r.cutStartMs, r.cutEndMs] : []
          ))].sort((a, b) => a - b)
          if (bounds.length === 0) return
          if (e.key === 'ArrowRight') {
            const next = bounds.find((b) => b > ph + 25)
            if (next != null) {
              e.preventDefault()
              seekPlayer(next)
            }
          } else {
            const prevB = [...bounds].reverse().find((b) => b < ph - 25)
            if (prevB != null) {
              e.preventDefault()
              seekPlayer(prevB)
            }
          }
          break
        }
        case 'Delete':
        case 'Backspace': {
          const sel = st.decisions.regions.find((x) => x.id === st.selectedRegionId)
          if (sel && (sel.kind === 'manual' || sel.kind === 'silence' || isSmartKind(sel.kind))) {
            e.preventDefault()
            st.deleteRegion(sel.id)
          }
          break
        }
        case ' ':
          e.preventDefault()
          ;(window as any).__autocutToggle?.()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [done])

  // Safety net: guarantee the transcript of a detected job is fetched even
  // when openJob/refreshJob raced (the text panel needs it to mount at all).
  useEffect(() => {
    if (job?.status === 'detected' && useStudio.getState().transcript == null) {
      void useStudio.getState().loadTranscript()
    }
  }, [job?.id, job?.status])

  // NOTE: stats must be derived via useMemo, NOT via a store selector — a
  // selector returning a fresh object every call makes React 19's
  // useSyncExternalStore bail out with "getSnapshot should be cached".
  const stats = useMemo(
    () => (decisions && job?.meta ? buildRenderPlan(decisions, job.meta.durationMs).stats : null),
    [decisions, job]
  )
  const smartActive = useMemo(
    () => (decisions ? decisions.regions.some((r) => isSmartKind(r.kind)) : false),
    [decisions]
  )
  const backToEditor = useStudio((s) => s.backToEditor)
  const seek = useCallback((ms: number) => seekPlayer(ms), [])

  const metaRows = useMemo(() => {
    const m = job?.meta
    if (!m) return []
    return [
      m.width && m.height ? `${m.width}×${m.height}` : '',
      m.fps ? `${m.fps} fps` : '',
      m.videoCodec ? m.videoCodec.toUpperCase() : '',
      m.audioCodec ? `${m.audioCodec.toUpperCase()} ${m.audioChannelLayout || ''} @ ${(m.audioSampleRate / 1000).toFixed(1)} kHz` : '',
      m.audioStreamCount > 1 ? `${m.audioStreamCount} audio tracks` : '',
      m.sizeBytes ? fmtBytes(m.sizeBytes) : '',
    ].filter(Boolean)
  }, [job?.meta])

  const tabTriggerCls = cn(
    'gap-1.5 px-3 text-xs text-zinc-400',
    'data-[state=active]:bg-zinc-800 data-[state=active]:text-amber-300 data-[state=active]:shadow-none',
    'dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-zinc-800 dark:data-[state=active]:text-amber-300',
  )

  return (
    <div className="flex flex-col gap-4 xl:flex-row">
      {/* left/main */}
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <Player />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-0.5">
          <div className="flex flex-wrap gap-1.5">
            {metaRows.map((r, i) => (
              <span key={i} className="rounded-sm border border-zinc-800 bg-zinc-900/60 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
                {r}
              </span>
            ))}
          </div>
          {stats && (
            <div className="ml-auto flex items-center gap-2 font-mono text-[11px]">
              <span className="text-zinc-500">
                {fmtDuration(stats.finalDurationMs, { compact: true })} final · saved{' '}
                <span className="text-amber-400">{fmtPct(stats.savedPct)}</span>
              </span>
            </div>
          )}
          {!done && (
            <div className={cn('flex items-center gap-0.5', !stats && 'ml-auto')}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={undo}
                disabled={!canUndo}
                title="تراجع (Ctrl+Z)"
                aria-label="تراجع"
                className="h-8 w-8 px-0 text-zinc-400 hover:text-zinc-100"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={redo}
                disabled={!canRedo}
                title="إعادة (Ctrl+Shift+Z)"
                aria-label="إعادة"
                className="h-8 w-8 px-0 text-zinc-400 hover:text-zinc-100"
              >
                <Redo2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          {done && (
            <Button variant="outline" size="sm" className="gap-1.5 border-zinc-700 bg-zinc-900 text-xs text-zinc-300" onClick={() => void backToEditor()}>
              <Undo2 className="h-3.5 w-3.5" /> عدّل القصات تاني
            </Button>
          )}
        </div>

        {!done && decisions && <ManualCutBar />}

        <TimelineCanvas onSeek={seek} />

        {!done && !transcript && smartInfo?.enabled && smartActive && (
          <div dir="rtl" className="rounded-lg border border-amber-800/50 bg-amber-950/20 p-3 text-xs text-amber-200">
            <div className="flex items-center gap-1.5 font-medium">
              <Sparkles className="h-4 w-4 text-amber-400" /> المونتاج الذكي
            </div>
            <div className="mt-1 leading-relaxed text-amber-200/80">
              اتفرّغت {smartInfo.utterances} جملة — الذكاء الاصطناعي رشّح شيل{' '}
              <span className="font-semibold text-amber-300">{smartInfo.cutUtterances}</span>
              {smartInfo.byCategory?.filler ? ` (${smartInfo.byCategory.filler} حشو` : ''}
              {smartInfo.byCategory?.repetition ? ` · ${smartInfo.byCategory.repetition} تكرار` : ''}
              {smartInfo.byCategory?.false_start ? ` · ${smartInfo.byCategory.false_start} بداية غلط` : ''}
              {smartInfo.byCategory?.off_topic ? ` · ${smartInfo.byCategory.off_topic} خارج الموضوع` : ''}
              {smartInfo.byCategory?.filler ? ')' : ''}. راجعها في جدول القصات — النوع «ذكي» والسبب مكتوب جوه كل صف.
            </div>
          </div>
        )}

        {!done && (
          <Tabs defaultValue="transcript" className="w-full">
            <TabsList dir="rtl" className="h-9 w-fit gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-1">
              <TabsTrigger value="transcript" className={tabTriggerCls}>
                📝 نص الفيديو{transcript ? ` (${transcript.length})` : ''}
              </TabsTrigger>
              <TabsTrigger value="regions" className={tabTriggerCls}>
                ✂️ جدول القطعات{decisions ? ` (${decisions.regions.length})` : ''}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="transcript">
              <TranscriptPanel />
            </TabsContent>
            <TabsContent value="regions">
              <RegionsTable />
            </TabsContent>
          </Tabs>
        )}
        {job?.outputDurationMs != null && (
          <div dir="rtl" className="rounded-lg border border-emerald-900/50 bg-emerald-950/20 p-4 text-xs text-emerald-300">
            <div className="flex flex-wrap items-center gap-1.5 font-medium">
              <CheckCircle2 className="h-4 w-4" /> {done ? 'القص خلص — الفيديو جاهز' : 'في نتيجة مقصوصة متاحة'}
              {!done && (
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto h-7 gap-1.5 border-emerald-900/60 bg-emerald-950/40 px-2 text-[11px] text-emerald-300 hover:bg-emerald-950/70"
                  onClick={() => useStudio.getState().showResult()}
                >
                  <Play className="h-3 w-3" /> شوف النتيجة
                </Button>
              )}
            </div>
            <div className="mt-1 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[11px] text-emerald-400/80 sm:grid-cols-4">
              <span>
                الأصلي <span className="text-emerald-200">{job.meta ? fmtDuration(job.meta.durationMs, { compact: true }) : '—'}</span>
              </span>
              <span>
                النهائي <span className="text-emerald-200">{fmtDuration(job.outputDurationMs, { compact: true })}</span>
              </span>
              <span>
                اتشال <span className="text-emerald-200">{fmtPct(job.meta ? 100 - (job.outputDurationMs / job.meta.durationMs) * 100 : null)}</span>
              </span>
              <span>
                الحجم <span className="text-emerald-200">{job.outputSizeBytes ? fmtBytes(job.outputSizeBytes) : '—'}</span>
              </span>
            </div>
          </div>
        )}
      </div>

      {/* right sidebar */}
      <aside className="w-full shrink-0 xl:w-[360px]">
        <ControlsPanel />
      </aside>
    </div>
  )
}
