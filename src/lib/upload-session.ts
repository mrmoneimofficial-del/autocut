/**
 * قصّاص — upload-session helpers shared by the chunked upload routes
 * (init / chunk / status / complete / simple), ported from the مستر منعم
 * system. Session state = one meta.json per /tmp/uploads/<sessionId>/ dir.
 */
import fs from 'node:fs'
import path from 'node:path'

export const UPLOADS_DIR = '/tmp/uploads'

/** 4MB — MUST stay below Vercel's 4.5MB request-body limit (413 above it)
 *  and MUST match SERVER_CHUNK_SIZE in src/lib/chunked-upload.ts. */
export const CHUNK_SIZE = 4 * 1024 * 1024

/** video extensions قصّاص accepts (same set as the pipeline) */
export const EXT_OK = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.webm', '.avi', '.ts'])

export interface SessionMeta {
  sessionId: string
  fileName: string
  mimeType: string
  fileSize: number
  chunkSize: number
  totalChunks: number
  uploadedChunks: number[]
  createdAt: number
}

export const sessionDirOf = (sessionId: string) => path.join(UPLOADS_DIR, sessionId)

export function validSessionId(sid: string): boolean {
  return /^[a-f0-9]{24}$/.test(sid)
}

export async function readMeta(sessionDir: string): Promise<SessionMeta | null> {
  try {
    const raw = await fs.promises.readFile(path.join(sessionDir, 'meta.json'), 'utf8')
    return JSON.parse(raw) as SessionMeta
  } catch {
    return null
  }
}

export async function writeMeta(sessionDir: string, meta: SessionMeta) {
  await fs.promises.writeFile(path.join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2))
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
