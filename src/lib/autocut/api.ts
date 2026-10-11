'use client'

/** Typed API client — attaches the owner token to every request. */
import type { Decisions, DetectResponse, DetectionSettings, JobDTO, SmartInfo, TranscriptFile } from './types'

const TOKEN_KEY = 'autocut-owner-token'

export function getOwnerToken(): string {
  let t: string | null = null
  try {
    t = localStorage.getItem(TOKEN_KEY)
  } catch {
    /* private mode */
  }
  if (!t) {
    t = crypto.randomUUID()
    try {
      localStorage.setItem(TOKEN_KEY, t)
    } catch {
      /* ignore */
    }
  }
  return t
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      'x-owner-token': getOwnerToken(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) {
    const err = (json as any)?.message ?? `Request failed (${res.status})`
    const e: any = new Error(err)
    e.code = (json as any)?.code
    e.status = res.status
    e.data = json
    throw e
  }
  return json as T
}

export const api = {
  health: () => req<any>('GET', '/api/autocut/health'),
  listJobs: () => req<{ jobs: JobDTO[] }>('GET', '/api/autocut/jobs'),
  getJob: (id: string) => req<{ job: JobDTO }>('GET', `/api/autocut/jobs/${id}`),
  initJob: (filename: string, size: number, mime: string, smart = false) =>
    req<{ job: JobDTO; chunkSize: number }>('POST', '/api/autocut/jobs', { filename, size, mime, smart }),
  completeUpload: (id: string) => req<{ job: JobDTO }>('POST', `/api/autocut/jobs/${id}/upload/complete`),
  detect: (id: string, settings: DetectionSettings) =>
    req<DetectResponse>('POST', `/api/autocut/jobs/${id}/detect`, { settings }),
  getDecisions: (id: string) =>
    req<{ settings: DetectionSettings; decisions: Decisions | null; envelope: any; durationMs: number; smart: SmartInfo | null }>(
      'GET',
      `/api/autocut/jobs/${id}/decisions`
    ),
  saveDecisions: (id: string, decisions: Decisions) =>
    req<{ ok: boolean; stats: any; warnings: string[] }>('PUT', `/api/autocut/jobs/${id}/decisions`, { decisions }),
  render: (id: string, render: { fadeMs: number; renderMode: 'precision' | 'fast' }) =>
    req<{ ok: boolean }>('POST', `/api/autocut/jobs/${id}/render`, { render }),
  mediaUrls: (id: string) =>
    req<{ streamUrl: string; outputUrl: string | null; downloadUrl: string | null }>(
      'POST',
      `/api/autocut/jobs/${id}/media-url`
    ),
  cancel: (id: string) => req<{ ok: boolean }>('POST', `/api/autocut/jobs/${id}/cancel`),
  retry: (id: string) => req<{ ok: boolean }>('POST', `/api/autocut/jobs/${id}/retry`),
  deleteJob: (id: string) => req<{ ok: boolean }>('DELETE', `/api/autocut/jobs/${id}`),
  envelope: (id: string, startMs: number, endMs: number, buckets: number) =>
    req<{ startMs: number; endMs: number; frameMs: number; buckets: number; min: number[]; max: number[] }>(
      'GET',
      `/api/autocut/jobs/${id}/envelope?start=${Math.floor(startMs)}&end=${Math.floor(endMs)}&buckets=${buckets}`
    ),
  /** Smart pass (ASR + AI verdicts) on an already-analyzed job — powers the
   *  text-based editor. Resumes from the ASR cache when re-run. */
  triggerSmart: (id: string, utterancePauseMs = 60) =>
    req<{ ok: boolean }>('POST', `/api/autocut/jobs/${id}/smart`, { utterancePauseMs }),
  getTranscript: (id: string) =>
    req<{ available: boolean; utterances?: TranscriptFile['utterances']; suggestOnly?: boolean }>(
      'GET',
      `/api/autocut/jobs/${id}/transcript`
    ),
  thumbsMeta: (id: string) =>
    req<{
      ready: boolean
      generating: boolean
      count: number
      expected: number
      intervalMs: number
      urlTemplate: string
    }>('GET', `/api/autocut/jobs/${id}/thumbs?meta=1`),
}
