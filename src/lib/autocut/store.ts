'use client'

/**
 * Studio state machine. The original video is never modified: every stage is
 * reversible (decisions are re-editable until render, "Undo" restores engine
 * defaults, the source file is read-only).
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import { api, getOwnerToken } from './api'
import { ChunkedUploader } from './uploader'
import { buildRenderPlan } from './planner'
import { buildProcessedMap } from './geometry'
import { fmtTimecode } from './format'
import {
  DEFAULT_SETTINGS,
  SETTINGS_PRESETS,
  isSmartKind,
  type CutRegion,
  type Decisions,
  type DetectionSettings,
  type DetectionStats,
  type EnvelopeInfo,
  type JobDTO,
  type RegionAction,
  type SmartInfo,
  type TranscriptEntry,
} from './types'

const fmtTimecodeOf = (ms: number) => fmtTimecode(ms)

export type UploadState = {
  phase: 'idle' | 'uploading' | 'paused' | 'done' | 'error' | 'canceled'
  sentBytes: number
  totalBytes: number
  speedBps: number
  error?: string
}

interface StudioStore {
  hydrated: boolean
  jobs: JobDTO[]
  job: JobDTO | null

  settings: DetectionSettings
  decisions: Decisions | null
  envelopeInfo: EnvelopeInfo | null
  warnings: string[]
  /** المونتاج الذكي — summary of the ASR+LLM pass (null = regular job) */
  smartInfo: SmartInfo | null
  /** Toggle for the NEXT upload (user choice on the upload card). */
  smartMode: boolean
  setSmartMode: (on: boolean) => void
  streamUrl: string | null
  outputUrl: string | null
  downloadUrl: string | null

  /** Text-based editor: per-sentence transcript (null = not run yet). */
  transcript: TranscriptEntry[] | null
  transcriptLoading: boolean
  loadTranscript: () => Promise<void>
  /** Run the ASR + AI smart pass on the current job (Gling-style panel). */
  triggerSmart: () => Promise<void>
  /** Delete ONE sentence (from the transcript panel) — becomes a cut region. */
  deleteUtterance: (idx: number) => void
  /** Restore a deleted sentence (removes its cut region). */
  restoreUtterance: (idx: number) => void
  /** Delete ALL AI-suggested sentences at once (one undo step). */
  deleteAllSuggested: () => void

  /** Undo/redo history for decisions edits (Ctrl+Z / Ctrl+Shift+Z). */
  canUndo: boolean
  canRedo: boolean
  undo: () => void
  redo: () => void

  selectedRegionId: string | null
  playerMode: 'original' | 'autocut'
  compareRegionId: string | null
  decisionsDirty: boolean
  /** True while the user re-edits cuts of an already-rendered job. */
  editingAfterRender: boolean

  /** Manual montage: in/out marks on the original timeline (ms). */
  markInMs: number | null
  markOutMs: number | null
  setMarkIn: (ms: number) => void
  setMarkOut: (ms: number) => void
  clearMarks: () => void
  addManualRegion: (startMs?: number, endMs?: number) => void
  deleteRegion: (id: string) => void

  upload: UploadState
  uploader: ChunkedUploader | null
  resumeFile: { name: string; size: number } | null

  bootstrap: () => Promise<void>
  refreshJobs: () => Promise<void>
  setJob: (job: JobDTO | null) => void
  newUpload: () => void
  refreshJob: () => Promise<void>
  openJob: (id: string) => Promise<void>
  startUpload: (file: File) => Promise<void>
  pauseUpload: () => void
  resumeUpload: () => void
  cancelUpload: () => void
  attachResumeFile: (file: File) => Promise<void>
  finishUpload: () => Promise<void>

  loadDecisions: () => Promise<void>
  reDetect: (settings?: DetectionSettings) => Promise<void>
  setSettings: (patch: Partial<DetectionSettings>) => void
  applyPreset: (presetId: string) => void
  resetSettings: () => void

  patchRegion: (id: string, patch: Partial<CutRegion>) => void
  setRegionAction: (id: string, action: RegionAction) => void
  splitRegion: (id: string, atMs?: number) => void
  keepAllRegions: () => void
  removeAllRegions: () => void
  resetDecisions: () => Promise<void>
  saveDecisions: () => Promise<void>
  markDecisionsSaved: () => void

  selectRegion: (id: string | null) => void
  setPlayerMode: (mode: 'original' | 'autocut') => void
  setCompareRegion: (id: string | null) => void
  showResult: () => void

  startRender: () => Promise<void>
  cancelJob: () => Promise<void>
  retryJob: () => Promise<void>
  deleteJob: () => Promise<void>
  backToEditor: () => Promise<void>

  getStats: () => DetectionStats | null
  getProcessedMap: () => ReturnType<typeof buildProcessedMap>
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

/** Undo/redo history (module-level, mirrored into the store as flags). */
const history = {
  past: [] as Decisions[],
  future: [] as Decisions[],
  limit: 50,
}

/** Sliding-window coalescing: rapid same-key mutations (typing in a number
 *  field, dragging a region edge) collapse into ONE undo step. */
let lastPushKey = ''
let lastPushAt = 0

function pushHistory(get: () => StudioStore, set: (s: Partial<StudioStore>) => void, key?: string) {
  const now = Date.now()
  if (key && key === lastPushKey && now - lastPushAt < 1500) {
    lastPushAt = now
    return
  }
  lastPushKey = key ?? ''
  lastPushAt = now
  const { decisions } = get()
  if (!decisions) return
  history.past.push(decisions)
  if (history.past.length > history.limit) history.past.shift()
  history.future = []
  set({ canUndo: true, canRedo: false })
}

function resetHistory(set: (s: Partial<StudioStore>) => void) {
  history.past = []
  history.future = []
  set({ canUndo: false, canRedo: false })
}

export const useStudio = create<StudioStore>((set, get) => ({
  hydrated: false,
  jobs: [],
  job: null,

  settings: { ...DEFAULT_SETTINGS },
  decisions: null,
  envelopeInfo: null,
  warnings: [],
  smartInfo: null,
  smartMode: false,
  streamUrl: null,
  outputUrl: null,
  downloadUrl: null,

  selectedRegionId: null,
  playerMode: 'original',
  compareRegionId: null,
  decisionsDirty: false,
  editingAfterRender: false,

  markInMs: null,
  markOutMs: null,

  setMarkIn(ms) {
    const dur = get().job?.meta?.durationMs ?? Infinity
    set({ markInMs: Math.max(0, Math.min(dur, Math.round(ms))) })
  },
  setMarkOut(ms) {
    const dur = get().job?.meta?.durationMs ?? Infinity
    set({ markOutMs: Math.max(0, Math.min(dur, Math.round(ms))) })
  },
  clearMarks() {
    set({ markInMs: null, markOutMs: null })
  },

  addManualRegion(startMs, endMs) {
    const { decisions, job } = get()
    if (!decisions || !job?.meta) return
    let s = startMs ?? get().markInMs
    let e = endMs ?? get().markOutMs
    if (s == null || e == null) {
      toast.error('حدّد البداية والنهاية الأول', { description: 'اضغط I عند بداية الجزء المطلوب إزالته و O عند نهايته' })
      return
    }
    if (e < s) [s, e] = [e, s]
    const dur = job.meta.durationMs
    s = Math.max(0, Math.round(s))
    e = Math.min(dur, Math.round(e))
    if (e - s < 20) {
      toast.error('القص أصغر من 20ms', { description: 'وسّع التحديد شوية' })
      return
    }
    const region: CutRegion = {
      id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      startMs: s,
      endMs: e,
      cutStartMs: s,
      cutEndMs: e,
      action: 'remove',
      kind: 'manual',
      confidence: 1,
    }
    pushHistory(get, set)
    const regions = [...decisions.regions, region].sort((a, b) => a.startMs - b.startMs)
    set({
      decisions: { ...decisions, regions },
      decisionsDirty: true,
      selectedRegionId: region.id,
      markInMs: null,
      markOutMs: null,
    })
    scheduleSave(get, set)
    toast.success('اتضاف القص', {
      description: `${fmtTimecodeOf(s)} ← ${fmtTimecodeOf(e)} (${((e - s) / 1000).toFixed(2)}s)`,
    })
  },

  deleteRegion(id) {
    const { decisions } = get()
    if (!decisions) return
    pushHistory(get, set)
    const regions = decisions.regions.filter((r) => r.id !== id)
    set({ decisions: { ...decisions, regions }, decisionsDirty: true, selectedRegionId: null })
    scheduleSave(get, set)
  },

  upload: { phase: 'idle', sentBytes: 0, totalBytes: 0, speedBps: 0 },
  uploader: null,
  resumeFile: null,

  transcript: null,
  transcriptLoading: false,

  async loadTranscript() {
    const { job } = get()
    if (!job) return
    set({ transcriptLoading: true })
    try {
      const res = await api.getTranscript(job.id)
      set({ transcript: res.available && res.utterances ? res.utterances : null, transcriptLoading: false })
    } catch {
      set({ transcriptLoading: false })
    }
  },

  async triggerSmart() {
    const { job } = get()
    if (!job) return
    try {
      await api.triggerSmart(job.id)
      set({ transcript: null })
      await get().refreshJob()
    } catch (e: any) {
      toast.error('مقدرناش نبدأ التحليل', { description: String(e?.message ?? e) })
    }
  },

  /** Region id convention for text-driven deletions: `utt-<idx>` (manual) or
   *  `smart-<idx>` (AI-suggested, applied by the user). Same span either way. */
  deleteUtterance(idx) {
    const { decisions, transcript } = get()
    if (!decisions) return
    const entry = transcript?.find((t) => t.idx === idx)
    if (!entry) return
    if (decisions.regions.some((r) => r.id === `utt-${idx}` || r.id === `smart-${idx}`)) return
    const kind: CutRegion['kind'] = entry.verdict
      ? entry.verdict.category === 'false_start'
        ? 'mistake'
        : entry.verdict.category === 'off_topic'
          ? 'offtopic'
          : entry.verdict.category === 'repetition'
            ? 'repetition'
            : 'filler'
      : 'manual'
    const region: CutRegion = {
      id: entry.verdict ? `smart-${idx}` : `utt-${idx}`,
      startMs: entry.startMs,
      endMs: entry.endMs,
      cutStartMs: entry.startMs,
      cutEndMs: entry.endMs,
      action: 'remove',
      kind,
      confidence: entry.verdict?.confidence ?? 1,
      note: entry.text
        ? `«${entry.text.slice(0, 110)}»${entry.verdict ? ` — ${entry.verdict.reason}` : ''}`.slice(0, 200)
        : undefined,
    }
    pushHistory(get, set, `utt:${idx}`)
    const regions = [...decisions.regions, region].sort((a, b) => a.startMs - b.startMs)
    set({ decisions: { ...decisions, regions }, decisionsDirty: true, selectedRegionId: region.id })
    scheduleSave(get, set)
  },

  restoreUtterance(idx) {
    const { decisions } = get()
    if (!decisions) return
    const regions = decisions.regions.filter((r) => r.id !== `utt-${idx}` && r.id !== `smart-${idx}`)
    if (regions.length === decisions.regions.length) return
    pushHistory(get, set, `utt:${idx}`)
    set({ decisions: { ...decisions, regions }, decisionsDirty: true, selectedRegionId: null })
    scheduleSave(get, set)
  },

  deleteAllSuggested() {
    const { decisions, transcript } = get()
    if (!decisions || !transcript) return
    const existing = new Set(decisions.regions.map((r) => r.id))
    const suggested = transcript.filter((t) => t.verdict)
    const missing = suggested.filter((t) => !existing.has(`smart-${t.idx}`) && !existing.has(`utt-${t.idx}`))
    if (missing.length === 0) {
      toast.info('كل المقترحات متطبقة بالفعل')
      return
    }
    pushHistory(get, set)
    const newRegions: CutRegion[] = missing.map((t) => ({
      id: `smart-${t.idx}`,
      startMs: t.startMs,
      endMs: t.endMs,
      cutStartMs: t.startMs,
      cutEndMs: t.endMs,
      action: 'remove' as const,
      kind:
        t.verdict!.category === 'false_start'
          ? ('mistake' as const)
          : t.verdict!.category === 'off_topic'
            ? ('offtopic' as const)
            : t.verdict!.category === 'repetition'
              ? ('repetition' as const)
              : ('filler' as const),
      confidence: t.verdict!.confidence,
      note: t.text ? `«${t.text.slice(0, 110)}» — ${t.verdict!.reason}`.slice(0, 200) : undefined,
    }))
    const regions = [...decisions.regions, ...newRegions].sort((a, b) => a.startMs - b.startMs)
    set({ decisions: { ...decisions, regions }, decisionsDirty: true })
    scheduleSave(get, set)
    toast.success(`اتشالت ${missing.length} جملة`, {
      description: 'تقدر ترجّعها بـ Ctrl+Z أو زر الاسترجاع جنب كل جملة',
    })
  },

  canUndo: false,
  canRedo: false,
  undo() {
    const { decisions } = get()
    if (!decisions || history.past.length === 0) return
    const prev = history.past.pop()!
    history.future.push(decisions)
    set({ decisions: prev, decisionsDirty: true, canUndo: history.past.length > 0, canRedo: true })
    scheduleSave(get, set)
  },
  redo() {
    const { decisions } = get()
    if (!decisions || history.future.length === 0) return
    const next = history.future.pop()!
    history.past.push(decisions)
    set({ decisions: next, decisionsDirty: true, canUndo: true, canRedo: history.future.length > 0 })
    scheduleSave(get, set)
  },

  async bootstrap() {
    getOwnerToken()
    try {
      const { jobs } = await api.listJobs()
      set({ jobs, hydrated: true })
      const latest = jobs[0]
      if (latest) {
        await get().openJob(latest.id)
      }
    } catch {
      set({ hydrated: true })
    }
  },

  async refreshJobs() {
    try {
      const { jobs } = await api.listJobs()
      set({ jobs })
    } catch {
      /* offline */
    }
  },

  setJob(job) {
    set({ job })
  },

  /** Leave the current job view and show the upload stage (job is kept in
   *  the jobs list — nothing is deleted). */
  newUpload() {
    const up = get().upload
    set({
      job: null,
      decisions: null,
      envelopeInfo: null,
      warnings: [],
      streamUrl: null,
      outputUrl: null,
      downloadUrl: null,
      selectedRegionId: null,
      compareRegionId: null,
      decisionsDirty: false,
      editingAfterRender: false,
      resumeFile: null,
      // preserve an in-flight upload so switching views does not abort it
      upload: up.phase === 'uploading' || up.phase === 'paused' ? up : { phase: 'idle', sentBytes: 0, totalBytes: 0, speedBps: 0 },
    })
    void get().refreshJobs()
  },

  async refreshJob() {
    const { job } = get()
    if (!job) return
    try {
      const { job: fresh } = await api.getJob(job.id)
      const prev = get().job
      set({ job: fresh })
      const becameDetected = prev && prev.status !== 'detected' && fresh.status === 'detected'
      const becameDone = prev && prev.status !== 'done' && fresh.status === 'done'
      if (becameDetected) {
        await get().loadDecisions()
        void get().loadTranscript()
      }
      if (becameDone) await loadMedia(fresh.id, set)
    } catch (e: any) {
      // The job vanished server-side (deleted from another tab / expired
      // cleanup / DB reset). Stop polling instead of hammering a 404 forever.
      if (e?.status === 404 || e?.code === 'JOB_NOT_FOUND' || e?.status === 403 || e?.code === 'FORBIDDEN') {
        if (get().job?.id === job.id) {
          set({
            job: null,
            decisions: null,
            envelopeInfo: null,
            warnings: [],
            streamUrl: null,
            outputUrl: null,
            downloadUrl: null,
            selectedRegionId: null,
            compareRegionId: null,
            decisionsDirty: false,
          })
          toast.info('Job removed', {
            description:
              'This job no longer exists on the server (it was deleted or expired). Pick or upload another video.',
          })
          await get().refreshJobs()
        }
      }
      /* transient network errors are ignored — next poll retries */
    }
  },

  async openJob(id) {
    set({
      job: null,
      decisions: null,
      envelopeInfo: null,
      warnings: [],
      streamUrl: null,
      outputUrl: null,
      downloadUrl: null,
      selectedRegionId: null,
      compareRegionId: null,
      decisionsDirty: false,
      editingAfterRender: false,
      playerMode: 'original',
      transcript: null,
      transcriptLoading: false,
    })
    resetHistory(set)
    try {
      const { job } = await api.getJob(id)
      set({ job })
      await loadMedia(id, set)
      if (job.status === 'detected' || job.status === 'done' || job.status === 'failed' || job.status === 'canceled') {
        await get().loadDecisions()
        void get().loadTranscript()
      }
      if (job.status === 'uploading') {
        set({
          upload: { phase: 'paused', sentBytes: job.uploadBytes, totalBytes: job.sizeBytes, speedBps: 0 },
          resumeFile: { name: job.filename, size: job.sizeBytes },
        })
      }
    } catch (e: any) {
      // Stale list entry — drop it from the menu instead of silently failing
      if (e?.status === 404 || e?.code === 'JOB_NOT_FOUND') {
        await get().refreshJobs()
      }
    }
  },

  async startUpload(file) {
    try {
      const smart = get().smartMode
      const { job } = await api.initJob(file.name, file.size, file.type || 'video/mp4', smart)
      set({
        job,
        resumeFile: null,
        upload: { phase: 'uploading', sentBytes: 0, totalBytes: file.size, speedBps: 0 },
        decisions: null,
        envelopeInfo: null,
        warnings: [],
        smartInfo: null,
        streamUrl: null,
        outputUrl: null,
      })
      const uploader = new ChunkedUploader(file, job.id, {
        onProgress: (info) => {
          set({
            upload: {
              phase: get().upload.phase === 'paused' ? 'paused' : 'uploading',
              sentBytes: info.sentBytes,
              totalBytes: info.totalBytes,
              speedBps: info.speedBps,
            },
          })
        },
        onStateChange: (phase) => {
          set({ upload: { ...get().upload, phase } })
          if (phase === 'done') void get().finishUpload()
        },
        onError: (message) => {
          set({ upload: { ...get().upload, phase: 'error', error: message } })
        },
      })
      set({ uploader })
      void uploader.run()
    } catch (e: any) {
      set({ upload: { phase: 'error', sentBytes: 0, totalBytes: file.size, speedBps: 0, error: e?.message ?? 'Upload failed' } })
    }
  },

  pauseUpload() {
    get().uploader?.pause()
  },

  resumeUpload() {
    get().uploader?.resume()
  },

  cancelUpload() {
    get().uploader?.cancel()
    const job = get().job
    if (job) void api.deleteJob(job.id).catch(() => {})
    set({ job: null, uploader: null, upload: { phase: 'idle', sentBytes: 0, totalBytes: 0, speedBps: 0 } })
    void get().refreshJobs()
  },

  async attachResumeFile(file) {
    const { job } = get()
    if (!job) return
    if (file.name !== job.filename || file.size !== job.sizeBytes) {
      throw new Error(`Please select the exact same file: "${job.filename}" (${job.sizeBytes} bytes)`)
    }
    const uploader = new ChunkedUploader(file, job.id, {
      onProgress: (info) => set({ upload: { phase: 'uploading', sentBytes: info.sentBytes, totalBytes: info.totalBytes, speedBps: info.speedBps } }),
      onStateChange: (phase) => {
        set({ upload: { ...get().upload, phase } })
        if (phase === 'done') void get().finishUpload()
      },
      onError: (message) => set({ upload: { ...get().upload, phase: 'error', error: message } }),
    })
    uploader.setServerOffset(get().upload.sentBytes)
    set({ uploader, resumeFile: null })
    void uploader.run()
  },

  async finishUpload() {
    const { job } = get()
    if (!job) return
    try {
      const { job: fresh } = await api.completeUpload(job.id)
      set({ job: fresh })
    } catch (e: any) {
      set({ upload: { ...get().upload, phase: 'error', error: e?.message ?? 'Could not finalize the upload' } })
    }
  },

  async loadDecisions() {
    const { job } = get()
    if (!job) return
    try {
      const res = await api.getDecisions(job.id)
      set({
        settings: res.settings ?? { ...DEFAULT_SETTINGS },
        decisions: res.decisions,
        envelopeInfo: res.envelope ?? null,
        decisionsDirty: false,
        warnings: [],
        smartInfo: res.smart ?? null,
      })
      resetHistory(set)
      if (res.decisions) {
        const plan = buildRenderPlan(res.decisions, res.durationMs || job.meta?.durationMs || 0)
        set({ warnings: plan.warnings })
      }
      if (res.smart?.warnings?.length) {
        set({ warnings: [...get().warnings, ...res.smart.warnings] })
      }
    } catch {
      /* not ready yet */
    }
  },

  async reDetect(settingsArg) {
    const { job, settings } = get()
    if (!job) return
    const next = settingsArg ?? settings
    set({ settings: next })
    const res = await api.detect(job.id, next)
    set({
      decisions: { regions: res.regions, targetSilenceMs: next.targetSilenceMs, render: get().decisions?.render ?? { fadeMs: 12, renderMode: 'precision' } },
      envelopeInfo: res.envelope,
      warnings: res.warnings ?? [],
      decisionsDirty: false,
      selectedRegionId: null,
    })
    resetHistory(set)
  },

  setSettings(patch) {
    set({ settings: { ...get().settings, ...patch } })
  },

  setSmartMode(on) {
    set({ smartMode: on })
  },

  applyPreset(presetId) {
    const preset = SETTINGS_PRESETS.find((p) => p.id === presetId)
    if (preset) set({ settings: { ...preset.settings } })
  },

  resetSettings() {
    set({ settings: { ...DEFAULT_SETTINGS } })
  },

  patchRegion(id, patch) {
    const { decisions } = get()
    if (!decisions) return
    pushHistory(get, set, `patch:${id}`)
    const regions = decisions.regions.map((r) => {
      if (r.id !== id) return r
      const next = { ...r, ...patch }
      // keep invariants: 20ms minimum, cut window within ±5s of the detected span
      const lo = r.startMs - 5000
      const hi = r.endMs + 5000
      next.cutStartMs = Math.min(Math.max(next.cutStartMs, lo), next.cutEndMs - 20)
      next.cutEndMs = Math.max(Math.min(next.cutEndMs, hi), next.cutStartMs + 20)
      return next
    })
    set({ decisions: { ...decisions, regions }, decisionsDirty: true })
    scheduleSave(get, set)
  },

  setRegionAction(id, action) {
    const { decisions } = get()
    if (!decisions) return
    pushHistory(get, set)
    const regions = decisions.regions.map((r) => (r.id === id ? { ...r, action } : r))
    set({ decisions: { ...decisions, regions }, decisionsDirty: true })
    scheduleSave(get, set)
  },

  splitRegion(id, atMs) {
    const { decisions } = get()
    if (!decisions) return
    const idx = decisions.regions.findIndex((r) => r.id === id)
    if (idx < 0) return
    const r = decisions.regions[idx]
    const at = atMs ?? Math.round((r.cutStartMs + r.cutEndMs) / 2)
    if (at <= r.cutStartMs + 30 || at >= r.cutEndMs - 30) return
    pushHistory(get, set)
    const a: CutRegion = { ...r, endMs: at, cutEndMs: at, id: `${r.id}-a` }
    const b: CutRegion = { ...r, startMs: at, cutStartMs: at, id: `${r.id}-b` }
    const regions = [...decisions.regions.slice(0, idx), a, b, ...decisions.regions.slice(idx + 1)]
    set({ decisions: { ...decisions, regions }, decisionsDirty: true, selectedRegionId: a.id })
    scheduleSave(get, set)
  },

  keepAllRegions() {
    const { decisions } = get()
    if (!decisions) return
    pushHistory(get, set)
    const regions = decisions.regions.map((r) =>
      r.kind === 'silence' || isSmartKind(r.kind) ? { ...r, action: 'keep' as RegionAction } : r
    )
    set({ decisions: { ...decisions, regions }, decisionsDirty: true })
    scheduleSave(get, set)
  },

  removeAllRegions() {
    const { decisions } = get()
    if (!decisions) return
    pushHistory(get, set)
    const regions = decisions.regions.map((r) =>
      r.kind === 'silence' || isSmartKind(r.kind) ? { ...r, action: 'remove' as RegionAction } : r
    )
    set({ decisions: { ...decisions, regions }, decisionsDirty: true })
    scheduleSave(get, set)
  },

  async resetDecisions() {
    // Undo Auto Cut — back to the engine's default detection for current settings
    await get().reDetect()
  },

  async saveDecisions() {
    const { job, decisions } = get()
    if (!job || !decisions) return
    try {
      const res = await api.saveDecisions(job.id, decisions)
      set({ warnings: res.warnings ?? [], decisionsDirty: false })
    } catch {
      /* surfaced through dirty flag / render validation */
    }
  },

  markDecisionsSaved() {
    set({ decisionsDirty: false })
  },

  selectRegion(id) {
    set({ selectedRegionId: id })
  },

  setPlayerMode(mode) {
    set({ playerMode: mode })
  },

  setCompareRegion(id) {
    set({ compareRegionId: id })
  },

  async startRender() {
    const { job, decisions } = get()
    if (!job || !decisions) return
    try {
      set({ editingAfterRender: false })
      if (get().decisionsDirty) await get().saveDecisions()
      await api.render(job.id, decisions.render)
      await get().refreshJob()
    } catch (e: any) {
      throw e
    }
  },

  async cancelJob() {
    const { job } = get()
    if (!job) return
    await api.cancel(job.id).catch(() => {})
    await get().refreshJob()
  },

  async retryJob() {
    const { job } = get()
    if (!job) return
    await api.retry(job.id).catch(() => {})
    await get().refreshJob()
  },

  async deleteJob() {
    const { job } = get()
    if (!job) return
    await api.deleteJob(job.id).catch(() => {})
    set({
      job: null,
      decisions: null,
      envelopeInfo: null,
      warnings: [],
      streamUrl: null,
      outputUrl: null,
      downloadUrl: null,
      selectedRegionId: null,
      upload: { phase: 'idle', sentBytes: 0, totalBytes: 0, speedBps: 0 },
    })
    await get().refreshJobs()
  },

  async backToEditor() {
    // Undo after render: decisions become editable again (original untouched)
    const { job } = get()
    if (!job) return
    set({ editingAfterRender: true, playerMode: 'original' })
    await get().refreshJob()
  },

  showResult() {
    set({ editingAfterRender: false, playerMode: 'original' })
  },

  getStats() {
    const { decisions, job } = get()
    if (!decisions || !job?.meta) return null
    return buildRenderPlan(decisions, job.meta.durationMs).stats
  },

  getProcessedMap() {
    const { decisions, job } = get()
    const dur = job?.meta?.durationMs ?? 0
    return buildProcessedMap(decisions, dur)
  },
}))

async function loadMedia(jobId: string, set: (s: Partial<StudioStore>) => void) {
  try {
    const urls = await api.mediaUrls(jobId)
    set({ streamUrl: urls.streamUrl, outputUrl: urls.outputUrl, downloadUrl: urls.downloadUrl })
  } catch {
    /* ignore */
  }
}

function scheduleSave(get: () => StudioStore, set: (s: Partial<StudioStore>) => void) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    const { job, decisions, decisionsDirty } = get()
    if (!job || !decisions || !decisionsDirty) return
    api
      .saveDecisions(job.id, decisions)
      .then((res) => set({ warnings: res.warnings ?? [], decisionsDirty: false }))
      .catch(() => {})
  }, 900)
}
