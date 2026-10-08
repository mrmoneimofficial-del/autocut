import { NextResponse } from 'next/server'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { EXT_OK, CHUNK_SIZE, sessionDirOf, writeMeta, sweepSessions, type SessionMeta } from '@/lib/upload-session'
import { finalizeUpload } from '@/lib/upload-finalize'

export const maxDuration = 120
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/uploads/chunked/simple — single-request upload for files <4MB
 * (the simple branch of the مستر منعم useUpload() hook). The file arrives as
 * FormData field "file", is written straight to a fresh session dir as the
 * merged file, then goes through the exact same finalize step (Bunny upload +
 * optional local job staging + signed asset ref).
 */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File) || file.size <= 0) {
    return NextResponse.json({ error: 'بيانات الملف غير مكتملة' }, { status: 400 })
  }
  if (file.size >= CHUNK_SIZE) {
    return NextResponse.json(
      { error: 'الملف ده حجمه أكبر من المسار البسيط — المفروض يتقطّع تلقائيًا' },
      { status: 400 },
    )
  }

  const ext = path.extname(file.name).toLowerCase()
  if (!EXT_OK.has(ext)) {
    return NextResponse.json(
      { error: 'قصّاص بيشتغل على ملفات الفيديو بس (MP4 / MOV / MKV / WEBM…)' },
      { status: 400 },
    )
  }
  const maxBytes = Number(process.env.CLOUD_MAX_MB || 200) * 1024 * 1024
  if (file.size > maxBytes) {
    return NextResponse.json({ error: 'الفيديو أكبر من الحد المسموح' }, { status: 400 })
  }

  await sweepSessions()

  const sessionId = crypto.randomBytes(12).toString('hex')
  const sessionDir = sessionDirOf(sessionId)
  try {
    await fs.mkdir(sessionDir, { recursive: true })
  } catch {
    return NextResponse.json({ error: 'التخزين المؤقت مش متاح على السيرفر ده' }, { status: 503 })
  }

  const meta: SessionMeta = {
    sessionId,
    fileName: file.name.slice(0, 200),
    mimeType: file.type || 'application/octet-stream',
    fileSize: file.size,
    chunkSize: CHUNK_SIZE,
    totalChunks: 1,
    uploadedChunks: [0],
    createdAt: Date.now(),
  }
  await writeMeta(sessionDir, meta)
  const mergedPath = path.join(sessionDir, 'merged.bin')
  await fs.writeFile(mergedPath, Buffer.from(await file.arrayBuffer()))

  let result
  try {
    result = await finalizeUpload(meta, mergedPath)
  } catch (e) {
    return NextResponse.json(
      { error: `فشل إتمام الرفع: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  }

  // same cleanup policy as the chunked complete route
  try {
    if (result.bunnyOK) {
      await fs.rm(sessionDir, { recursive: true, force: true })
    }
  } catch { /* best-effort */ }

  return NextResponse.json(result)
}
