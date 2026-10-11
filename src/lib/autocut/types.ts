/**
 * AutoCut Studio — shared type contracts.
 * Imported by the Next.js app (client + server) AND the background worker
 * (mini-services/autocut-worker). Keep this file dependency-free.
 */

export type JobStatus =
  | 'uploading'
  | 'ready'
  | 'queued_analyze'
  | 'analyzing'
  | 'detected'
  | 'queued_render'
  | 'rendering'
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'canceled'

export type StageId =
  | 'upload'
  | 'probe'
  | 'envelope'
  | 'detect'
  | 'review'
  | 'render'
  | 'concat'
  | 'finalize'
  | 'done'
  | 'error'

export const ACTIVE_STATUSES: JobStatus[] = [
  'uploading',
  'ready',
  'queued_analyze',
  'analyzing',
  'queued_render',
  'rendering',
  'finalizing',
]

export interface VideoMeta {
  durationMs: number
  width: number
  height: number
  fps: number
  videoCodec: string
  audioCodec: string
  audioChannels: number
  audioChannelLayout: string
  audioSampleRate: number
  audioStreamCount: number
  bitrate: number // total bitrate bits/s
  formatName: string
  sizeBytes: number
  hasAudio: boolean
  hasVideo: boolean
  gopMs: number | null // median keyframe interval (informational, for Fast mode)
}

export interface DetectionSettings {
  /** RMS level below which audio counts as silence, dB. -60 .. -20 */
  thresholdDb: number
  /** Silences shorter than this are never cut. ms */
  minSilenceMs: number
  /** Silences longer than this are left completely untouched. null = no limit */
  maxSilenceMs: number | null
  /** Material preserved immediately before a detected silence. ms */
  keepBeforeMs: number
  /** Material preserved immediately after a detected silence. ms */
  keepAfterMs: number
  /** Compress silences down to targetSilenceMs instead of removing them. */
  compressSilence: boolean
  /** Target pause length kept when compressing. ms */
  targetSilenceMs: number
  /** Cap on how much may be removed from a single silence. null = unlimited */
  maxRemovalMs: number | null
  /** Snap cut boundaries to waveform energy minima to protect words. */
  smartPadding: boolean
  /** Don't treat normal breaths as cuttable silence. */
  breathingProtection: boolean
  /** Don't treat very quiet speech as silence. */
  lowSpeechProtection: boolean
  /** Auto-compensate for constant background noise / room tone. */
  noiseTolerance: boolean
}

export type RegionAction = 'remove' | 'keep' | 'compress'

export type RegionKind =
  | 'silence'
  | 'breath'
  | 'lowspeech'
  | 'manual'
  | 'filler'
  | 'repetition'
  | 'mistake'
  | 'offtopic'

/** Region kinds produced by the smart-edit pipeline (ASR + LLM). */
export const SMART_KINDS: RegionKind[] = ['filler', 'repetition', 'mistake', 'offtopic']

export function isSmartKind(kind: RegionKind): boolean {
  return kind === 'filler' || kind === 'repetition' || kind === 'mistake' || kind === 'offtopic'
}

export interface CutRegion {
  id: string
  /** Detected silence span. */
  startMs: number
  endMs: number
  /** Effective removal window (padding already applied). */
  cutStartMs: number
  cutEndMs: number
  action: RegionAction
  kind: RegionKind
  /** 0..1 engine confidence. */
  confidence: number
  /** How deep below threshold the silence sits, dB (silence kind only). */
  depthDb?: number
  /** Per-region override of the compress target. ms */
  targetMs?: number | null
  /** Smart-edit note: quoted transcript + AI reason (Arabic). */
  note?: string
}

/** Summary of the smart-edit (مونتاج ذكي) pass, stored in AutoCutJob.smartJson. */
export interface SmartInfo {
  enabled: boolean
  /** A per-sentence transcript file exists (text-based editing available). */
  transcript?: boolean
  utterances: number
  speechMs: number
  cutUtterances: number
  byCategory: Record<string, number>
  warnings: string[]
  asrMs: number
  llmMs: number
}

/** Per-sentence AI verdict (smart pass), part of the transcript. */
export interface TranscriptVerdict {
  category: 'filler' | 'repetition' | 'false_start' | 'off_topic'
  reason: string
  confidence: number
}

/** One transcribed sentence with its exact audio span. */
export interface TranscriptEntry {
  idx: number
  startMs: number
  endMs: number
  text: string
  verdict: TranscriptVerdict | null
}

export interface TranscriptFile {
  v: number
  generatedAt: number
  suggestOnly?: boolean
  utterances: TranscriptEntry[]
}

export type RenderMode = 'precision' | 'fast'

export interface RenderSettings {
  /** Audio fade length at cut joins. ms */
  fadeMs: number
  renderMode: RenderMode
}

export interface Decisions {
  regions: CutRegion[]
  /** Global compress target captured when decisions were made. ms */
  targetSilenceMs: number
  render: RenderSettings
}

export interface DetectionStats {
  regionCount: number
  totalSilenceMs: number
  willRemoveMs: number
  finalDurationMs: number
  savedPct: number
}

export interface JobError {
  code: string
  message: string
  details?: string
}

export interface JobDTO {
  id: string
  filename: string
  mime: string
  sizeBytes: number
  status: JobStatus
  stage: StageId
  stageMessage: string | null
  progress: number
  etaSeconds: number | null
  error: JobError | null
  meta: VideoMeta | null
  /** Bytes durably received so far (== sizeBytes once upload completes). */
  uploadBytes: number
  hasDecisions: boolean
  stats: DetectionStats | null
  renderMode: RenderMode | null
  outputSizeBytes: number | null
  outputDurationMs: number | null
  createdAt: string
  updatedAt: string
}

export interface EnvelopeInfo {
  frameMs: number
  frames: number
  durationMs: number
  noiseFloorDb: number
  dynamicRangeDb: number
}

export interface DetectResponse {
  settings: DetectionSettings
  regions: CutRegion[]
  stats: DetectionStats
  warnings: string[]
  envelope: EnvelopeInfo
}

/** Display-ready waveform buckets for a zoom window, dB values. */
export interface EnvelopeBuckets {
  startMs: number
  endMs: number
  frameMs: number
  buckets: number
  min: number[]
  max: number[]
}

export interface KeepSegment {
  startMs: number
  endMs: number
}

export interface RemovedSpan {
  startMs: number
  endMs: number
}

export interface RenderPlan {
  keepSegments: KeepSegment[]
  removedSpans: RemovedSpan[]
  stats: DetectionStats
  warnings: string[]
  fatal: JobError | null
}

export const DEFAULT_SETTINGS: DetectionSettings = {
  thresholdDb: -35,
  minSilenceMs: 800,
  maxSilenceMs: null,
  keepBeforeMs: 50,
  keepAfterMs: 50,
  compressSilence: true,
  targetSilenceMs: 100,
  maxRemovalMs: null,
  smartPadding: true,
  breathingProtection: true,
  lowSpeechProtection: true,
  noiseTolerance: true,
}

export interface SettingsPreset {
  id: string
  label: string
  description: string
  settings: DetectionSettings
}

export const SETTINGS_PRESETS: SettingsPreset[] = [
  {
    id: 'aggressive',
    label: 'Aggressive',
    description: 'Remove dead air almost completely. Best for screen recordings and tight tutorials.',
    settings: {
      ...DEFAULT_SETTINGS,
      thresholdDb: -40,
      minSilenceMs: 400,
      keepBeforeMs: 60,
      keepAfterMs: 80,
      compressSilence: false,
      targetSilenceMs: 120,
      smartPadding: true,
    },
  },
  {
    id: 'natural',
    label: 'Natural',
    description: 'Shorten pauses to a short natural beat. Recommended for educational videos.',
    settings: { ...DEFAULT_SETTINGS },
  },
  {
    id: 'conservative',
    label: 'Conservative',
    description: 'Only remove obvious, long dead air. Maximum safety for speech.',
    settings: {
      ...DEFAULT_SETTINGS,
      thresholdDb: -32,
      minSilenceMs: 1500,
      keepBeforeMs: 250,
      keepAfterMs: 300,
      targetSilenceMs: 600,
      compressSilence: true,
    },
  },
]
