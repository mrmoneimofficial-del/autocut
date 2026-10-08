import { NextResponse } from 'next/server'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  UPLOADS_DIR, CHUNK_SIZE, EXT_OK, sessionDirOf,
  writeMeta, sweepSessions, type SessionMeta,
} from '@/lib/upload-session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/uploads/chunked/init — start a chunked upload session.
 * Body: { fileName, mimeType, fileSize } → { sessionId, chunkSize, totalChunks }
 * (ported from the مستر منعم init route; قصّاص adds the video-only check and
 * the cloud size cap, and drops the admin guard — public tool).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const fileName = typeof body?.fileName === 'string' ? body.fileName.slice(0, 200) : ''
  const mimeType = typeof body?.mimeType === 'string' ? body.mimeType.slice(0, 100) : ''
  const fileSize = Number(body?.fileSize)

  if (!fileName || !Number.isFinite(fileSize) || fileSize <= 0) {
    return NextResponse.json({ error: 'بيانات الملف غير مكتملة' }, { status: 400 })
  }
  const ext = path.extname(fileName).toLowerCase()
  if (!EXT_OK.has(ext)) {
    return NextResponse.json(
      { error: 'قصّاص بيشتغل على ملفات الفيديو بس (MP4 / MOV / MKV / WEBM…)' },
      { status: 400 },
    )
  }
  const maxBytes = Number(process.env.CLOUD_MAX_MB || 200) * 1024 * 1024
  if (fileSize > maxBytes) {
    return NextResponse.json(
      { error: `الفيديو أكبر من ${Math.round(maxBytes / 1024 / 1024)} م.ب — ده الحد الأقصى هنا. للفيديوهات الأكبر شغّل النسخة الكاملة مجانًا (Colab / Codespaces)` },
      { status: 400 },
    )
  }

  await sweepSessions()

  const sessionId = crypto.randomBytes(12).toString('hex')
  const sessionDir = sessionDirOf(sessionId)
  try {
    await fs.mkdir(sessionDir, { recursive: true })
  } catch {
    return NextResponse.json(
      { error: 'التخزين المؤقت مش متاح على السيرفر ده — جرّب تاني أو استخدم النسخة الكاملة' },
      { status: 503 },
    )
  }

  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE)
  const meta: SessionMeta = {
    sessionId,
    fileName,
    mimeType: mimeType || 'application/octet-stream',
    fileSize,
    chunkSize: CHUNK_SIZE,
    totalChunks,
    uploadedChunks: [],
    createdAt: Date.now(),
  }
  await writeMeta(sessionDir, meta)

  return NextResponse.json({ sessionId, chunkSize: CHUNK_SIZE, totalChunks })
}
