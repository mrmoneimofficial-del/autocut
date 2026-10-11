/**
 * قصّاص — upload-session helpers shared by the chunked upload routes
 * (init / chunk / status / complete / simple), ported from the مستر منعم
 * system. Session state = one meta.json per /tmp/uploads/<sessionId>/ dir.
 *
 * PROTOCOL v2 (adaptive chunks): the client is free to send chunks of ANY
 * size between MIN_CHUNK_BODY and MAX_CHUNK_BODY — each request declares its
 * byte range explicitly (`start` + `len`), so the chunk size can shrink under
 * hostile networks/proxies (the sandbox preview layer kills big request
 * bodies) and grow back on fast links (Vercel-safe ≤4MB), while the server
 * only tracks which byte RANGES have landed. This is what makes uploads
 * survive proxies that kill large/slow requests — the exact failure the
 * users hit ("the bar reaches ~20% then restarts").
 */
import fs from 'node:fs'
import path from 'node:path'

export const UPLOADS_DIR = '/tmp/uploads'

/**
 * Hard per-request body cap. MUST stay below Vercel's 4.5MB request-body
 * limit (413 above that). The client treats this as its growth ceiling.
 */
export const MAX_CHUNK_BODY = 4 * 1024 * 1024

/** video extensions قصّاص accepts (same set as the pipeline) */
export const EXT_OK = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.webm', '.avi', '.ts'])

/** one landed byte range [start, end) — end exclusive */
export interface ChunkRange {
  start: number
  end: number
}

export interface SessionMeta {
  sessionId: string
  fileName: string
  mimeType: string
  fileSize: number
  /** the EXACT landed ranges; one entry per chunk file `<start>.chunk` */
  uploaded: ChunkRange[]
  createdAt: number
}

export const sessionDirOf = (sessionId: string) => path.join(UPLOADS_DIR, sessionId)

export function validSessionId(sid: string): boolean {
  return /^[a-f0-9]{24}$/.test(sid)
}

export async function readMeta(sessionDir: string): Promise<SessionMeta | null> {
  try {
    const raw = await fs.promises.readFile(path.join(sessionDir, 'meta.json'), 'utf8')
    const meta = JSON.parse(raw) as SessionMeta
    // v1 metas (fixed uploadedChunks[]) have no `uploaded` — treat as empty
    // coverage; the client will simply re-upload from scratch.
    if (!Array.isArray(meta.uploaded)) meta.uploaded = []
    if (!Array.isArray(meta.uploaded)) return null
    return meta
  } catch {
    return null
  }
}

export async function writeMeta(sessionDir: string, meta: SessionMeta) {
  await fs.promises.writeFile(path.join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2))
}

/** how many bytes are banked server-side */
export function bankedBytes(meta: SessionMeta): number {
  let n = 0
  for (const r of meta.uploaded) n += r.end - r.start
  return n
}

/** does the coverage fully contain [start, end)? */
export function isCovered(meta: SessionMeta, start: number, end: number): boolean {
  let s = start
  for (const r of [...meta.uploaded].sort((a, b) => a.start - b.start)) {
    if (r.start > s) break
    if (r.end > s) s = r.end
    if (s >= end) return true
  }
  return s >= end
}

/** does [start, end) overlap ANY landed range? (partial overlap → 409 resync) */
export function overlapsCoverage(meta: SessionMeta, start: number, end: number): boolean {
  for (const r of meta.uploaded) {
    if (r.start < end && start < r.end) return true
  }
  return false
}

/**
 * Is the file fully covered — [0, fileSize) with no holes? This is the
 * gate for /complete (replaces the old uploadedChunks.length === totalChunks).
 */
export function coverageComplete(meta: SessionMeta): boolean {
  if (meta.fileSize <= 0 || meta.uploaded.length === 0) return false
  const sorted = [...meta.uploaded].sort((a, b) => a.start - b.start)
  let cursor = 0
  for (const r of sorted) {
    if (r.start > cursor) return false // hole
    cursor = Math.max(cursor, r.end)
  }
  return cursor >= meta.fileSize
}

/** drop upload sessions idle for over 24h (local servers keep /tmp forever) */
export async function sweepSessions() {
  try {
    const cutoff = Date.now() - 24 * 3600_000
    for (const sid of await fs.promises.readdir(UPLOADS_DIR)) {
      const dir = path.join(UPLOADS_DIR, sid)
      try {
        const st = await fs.promises.stat(path.join(dir, 'meta.json'))
        if (st.mtimeMs < cutoff) await fs.promises.rm(dir, { recursive: true, force: true })
      } catch {
        /* no meta.json — ignore */
      }
    }
  } catch {
    /* /tmp/uploads missing — nothing to sweep */
  }
}

/** same sampled checksum the client computes (quickChecksum in chunked-upload.ts) */
export function verifyChecksum(buf: Buffer): string {
  const len = buf.length
  let h = len
  const sample = (i: number) => buf[i] | 0
  if (len > 0) h = (h * 31 + sample(0)) >>> 0
  if (len > 1) h = (h * 31 + sample(len - 1)) >>> 0
  if (len > 2) h = (h * 31 + sample(len >> 1)) >>> 0
  if (len > 3) h = (h * 31 + sample(len >> 2)) >>> 0
  return h.toString(16)
}
