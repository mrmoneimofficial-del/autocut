import { db } from '@/lib/db'
import type { AutoCutJob } from '@prisma/client'
import fs from 'node:fs'
import type { Decisions, DetectionStats, DetectionSettings, JobDTO, JobError, VideoMeta } from './types'
import { buildRenderPlan } from './planner'
import { jobDir, originalPath, fileExt } from './paths'

type JobRow = AutoCutJob

export function safeJsonParse<T>(s: string | null | undefined): T | null {
  if (!s) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

export function uploadBytesOnDisk(row: JobRow): number {
  try {
    const p = originalPath(row.id, fileExt(row.filename))
    return fs.existsSync(p) ? fs.statSync(p).size : 0
  } catch {
    return 0
  }
}

export function jobToDTO(row: JobRow): JobDTO {
  const meta = safeJsonParse<VideoMeta>(row.metaJson)
  const decisions = safeJsonParse<Decisions>(row.decisionsJson)
  let stats: DetectionStats | null = null
  if (decisions && meta && meta.durationMs > 0) {
    stats = buildRenderPlan(decisions, meta.durationMs).stats
  }
  const error = safeJsonParse<JobError>(row.errorJson)
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    sizeBytes: Number(row.sizeBytes) || 0,
    status: row.status as JobDTO['status'],
    stage: row.stage as JobDTO['stage'],
    stageMessage: row.stageMessage,
    progress: row.progress ?? 0,
    etaSeconds: row.etaSeconds ?? null,
    error,
    meta,
    uploadBytes: row.status === 'uploading' ? uploadBytesOnDisk(row) : Number(row.sizeBytes) || 0,
    hasDecisions: !!decisions,
    stats,
    renderMode: (row.renderMode as JobDTO['renderMode']) ?? null,
    outputSizeBytes: row.outputSize ? Number(row.outputSize) : null,
    outputDurationMs: row.outputDuration ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * Single-user studio mode: this deployment is one person's personal
 * editor, so any valid session token may open any job. The previous strict
 * per-token isolation hid jobs whenever the owner switched browser/device
 * or cleared localStorage (the token lived only there). A token must still
 * be present — anonymous scraping stays blocked.
 */
export async function getOwnedJob(jobId: string, ownerToken: string | null): Promise<JobRow | null> {
  if (!ownerToken) return null
  return db.autoCutJob.findUnique({ where: { id: jobId } })
}

export async function setJobError(jobId: string, code: string, message: string, details?: string) {
  const errorJson = JSON.stringify({ code, message, details })
  await db.autoCutJob.update({
    where: { id: jobId },
    data: { status: 'failed', stage: 'error', stageMessage: message.slice(0, 300), errorJson },
  })
}

export async function updateJob(jobId: string, data: Partial<AutoCutJob>) {
  await db.autoCutJob.update({ where: { id: jobId }, data })
}

export { jobDir }
export type { JobRow }

export function parseSettings(raw: unknown): DetectionSettings | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const num = (v: unknown, min: number, max: number, dflt: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt
  const numOrNull = (v: unknown, min: number, max: number) =>
    v === null || v === undefined ? null : typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null
  return {
    thresholdDb: num(s.thresholdDb, -60, -20, -35),
    minSilenceMs: num(s.minSilenceMs, 100, 60000, 800),
    maxSilenceMs: numOrNull(s.maxSilenceMs, 500, 86400000),
    keepBeforeMs: num(s.keepBeforeMs, 0, 5000, 150),
    keepAfterMs: num(s.keepAfterMs, 0, 5000, 200),
    compressSilence: !!s.compressSilence,
    targetSilenceMs: num(s.targetSilenceMs, 0, 10000, 300),
    maxRemovalMs: numOrNull(s.maxRemovalMs, 100, 600000),
    smartPadding: !!s.smartPadding,
    breathingProtection: s.breathingProtection === undefined ? true : !!s.breathingProtection,
    lowSpeechProtection: s.lowSpeechProtection === undefined ? true : !!s.lowSpeechProtection,
    noiseTolerance: s.noiseTolerance === undefined ? true : !!s.noiseTolerance,
  }
}

export const ALLOWED_MIME = /^(video\/(mp4|quicktime|x-matroska|webm|x-msvideo|avi|mpeg|ogg|3gpp)|application\/(octet-stream|vnd\.apple\.quicktime)|audio\/*)/i
export const ALLOWED_EXT = /^(mp4|mov|mkv|webm|avi|mpg|mpeg|ogv|3gp|m4v|ts|flv|wmv|mp3|m4a|wav)$/i

export function isAcceptedFile(name: string, mime: string, sizeBytes: number): string | null {
  if (sizeBytes <= 0) return 'The file is empty.'
  if (sizeBytes > 32 * 1024 * 1024 * 1024) return 'The file exceeds the 32 GB limit.'
  const ext = fileExt(name)
  if (!ALLOWED_EXT.test(ext) && !ALLOWED_MIME.test(mime || '')) {
    return `Unsupported file type ".${ext}". Supported: MP4, MOV, MKV, WebM, AVI and common audio/video containers.`
  }
  return null
}
