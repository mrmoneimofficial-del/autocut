/**
 * قصّاص — shared "finalize" step of an upload session (used by both the
 * chunked /complete route and the /simple route): merge → verify → Bunny
 * Storage upload → (server mode) stage a local job → signed asset ref.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { bunnyUpload, StoragePaths, mimeFromExt } from '@/lib/bunny-storage'
import { signPathToken } from '@/lib/storage-auth'
import type { SessionMeta } from '@/lib/upload-session'

const JOBS_ROOT = path.join(process.cwd(), 'storage', 'jobs')
const EXT_OK = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.webm', '.avi', '.ts'])

export interface FinalizeResult {
  asset: {
    path: string
    name: string
    size: number
    mimeType: string
    token: string
    /** signed inline stream URL for the original */
    url: string
  }
  server?: { jobId: string }
  bunnyOK: boolean
  warning?: string
}

/**
 * @param meta        the session meta (all chunks must be on disk already)
 * @param mergedPath  path to the fully-merged file inside the session dir
 */
export async function finalizeUpload(meta: SessionMeta, mergedPath: string): Promise<FinalizeResult> {
  const warnings: string[] = []

  // ---- resolve type + a safe storage name ----
  const ext = path.extname(meta.fileName).toLowerCase()
  const safeExt = EXT_OK.has(ext) ? ext : '.mp4'
  const safeName = `original${safeExt}`

  // ---- 1. upload the original to Bunny Storage (the system's core) ----
  let bunnyOK = false
  const remotePath = StoragePaths.original(meta.sessionId, safeName)
  if (process.env.BUNNY_STORAGE_PASSWORD) {
    try {
      const buf = await fs.promises.readFile(mergedPath)
      await bunnyUpload(remotePath, buf)
      bunnyOK = true
    } catch (e) {
      warnings.push(`تعذر حفظ الأصل على التخزين السحابي: ${e instanceof Error ? e.message : String(e)}`)
    }
  } else {
    warnings.push('التخزين السحابي (Bunny) مش متظبط على السيرفر ده — BUNNY_STORAGE_PASSWORD ناقص')
  }

  // ---- 2. server mode: stage a local job for the classic pipeline ----
  let server: { jobId: string } | undefined
  let storageWritable = false
  try {
    fs.mkdirSync(JOBS_ROOT, { recursive: true })
    const probe = path.join(JOBS_ROOT, `.probe-${Date.now().toString(36)}`)
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
    storageWritable = true
  } catch { /* read-only serverless FS → cloud mode */ }

  if (storageWritable) {
    const jobId = crypto.randomBytes(16).toString('hex')
    const dir = path.join(JOBS_ROOT, jobId)
    fs.mkdirSync(dir)
    await fs.promises.copyFile(mergedPath, path.join(dir, `original${safeExt}`))
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
      id: jobId, name: meta.fileName, size: meta.fileSize, ext: safeExt,
      phase: 'uploaded', uploaded: meta.fileSize, createdAt: Date.now(),
      asset: { path: remotePath, bunnyOK },
    }))
    server = { jobId }
  }

  const token = signPathToken(remotePath)
  return {
    asset: {
      path: remotePath,
      name: meta.fileName,
      size: meta.fileSize,
      mimeType: meta.mimeType && meta.mimeType !== 'application/octet-stream'
        ? meta.mimeType
        : mimeFromExt(meta.fileName),
      token,
      url: `/api/uploads/stream?t=${token}`,
    },
    ...(server ? { server } : {}),
    bunnyOK,
    ...(warnings.length ? { warning: warnings.join(' · ') } : {}),
  }
}
