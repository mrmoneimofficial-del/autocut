import { NextResponse } from 'next/server'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import {
  sessionDirOf, validSessionId, readMeta, type SessionMeta,
} from '@/lib/upload-session'
import { finalizeUpload } from '@/lib/upload-finalize'

// merging a large file + uploading it to Bunny can legitimately take a while
// on big videos — Fluid compute allows 300s.
export const maxDuration = 300
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/uploads/chunked/:sessionId/complete — verify all chunks → merge
 * streamed to /tmp → byte-exact size check → Bunny Storage upload → (server
 * mode) stage a local job → signed asset ref.
 * Ported from the مستر منعم complete route (asset record + Bunny upload),
 * adapted to قصّاص: no DB, video-only, signed delivery token in the response.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params
  if (!validSessionId(sessionId)) {
    return NextResponse.json({ error: 'جلسة الرفع غير موجودة أو منتهية' }, { status: 404 })
  }
  const sessionDir = sessionDirOf(sessionId)

  let meta: SessionMeta
  try {
    const m = await readMeta(sessionDir)
    if (!m) throw new Error('missing')
    meta = m
  } catch {
    return NextResponse.json({ error: 'جلسة الرفع غير موجودة أو منتهية' }, { status: 404 })
  }

  // Verify all chunks present
  if (meta.uploadedChunks.length !== meta.totalChunks) {
    return NextResponse.json(
      {
        error: `ناقص ${meta.totalChunks - meta.uploadedChunks.length} جزء — اكتمل الرفع أولاً`,
        missing: meta.totalChunks - meta.uploadedChunks.length,
      },
      { status: 400 },
    )
  }

  // Merge chunks into one file (streamed to /tmp — never in RAM).
  const tmpMergedPath = path.join(sessionDir, 'merged.bin')
  const writeStream = createWriteStream(tmpMergedPath)
  let totalWritten = 0
  try {
    for (let i = 0; i < meta.totalChunks; i++) {
      const chunkBuf = await fs.readFile(path.join(sessionDir, `${i}.chunk`))
      totalWritten += chunkBuf.length
      await new Promise<void>((resolve, reject) => {
        writeStream.write(chunkBuf, (err) => (err ? reject(err) : resolve()))
      })
    }
    await new Promise<void>((resolve, reject) => {
      writeStream.end((err: Error | null) => (err ? reject(err) : resolve()))
    })
  } catch (e) {
    try { await fs.rm(sessionDir, { recursive: true, force: true }) } catch { /* ignore */ }
    return NextResponse.json(
      { error: `فشل دمج أجزاء الملف: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  }

  // Integrity check: final size must match expected, byte-exact.
  if (totalWritten !== meta.fileSize) {
    try { await fs.rm(sessionDir, { recursive: true, force: true }) } catch { /* ignore */ }
    return NextResponse.json(
      {
        error: `فشل التحقق من السلامة: الحجم المتوقع ${meta.fileSize}، الفعلي ${totalWritten}`,
      },
      { status: 500 },
    )
  }

  // Bunny upload + (server mode) local job staging + signed asset ref
  let result
  try {
    result = await finalizeUpload(meta, tmpMergedPath)
  } catch (e) {
    return NextResponse.json(
      { error: `فشل إتمام الرفع: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  }

  // Cleanup: drop the per-chunk files. Keep merged.bin ONLY when Bunny failed
  // (it then serves as the warm fallback source for the cut on this instance).
  try {
    if (result.bunnyOK) {
      await fs.rm(sessionDir, { recursive: true, force: true })
    } else {
      for (let i = 0; i < meta.totalChunks; i++) {
        await fs.rm(path.join(sessionDir, `${i}.chunk`), { force: true })
      }
    }
  } catch { /* best-effort */ }

  return NextResponse.json(result)
}
