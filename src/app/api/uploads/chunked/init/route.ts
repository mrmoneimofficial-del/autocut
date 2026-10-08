import { NextResponse } from 'next/server'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  EXT_OK, sessionDirOf, writeMeta, sweepSessions, type SessionMeta,
} from '@/lib/upload-session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/uploads/chunked/init — start a chunked upload session.
 * Body: { fileName, mimeType, fileSize }
 * → { sessionId, maxChunkSize, initialChunkSize }
 * (ported from the مستر منعم init route; قصّاص adds the video-only check and
 * the cloud size cap, and drops the admin guard — public tool).
 *
 * v2: no fixed chunkSize/totalChunks anymore — the client adapts the chunk
 * size to the network (grows on success, shrinks when a proxy kills the
 * request) and declares each chunk's byte range explicitly.
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

  const meta: SessionMeta = {
    sessionId,
    fileName,
    mimeType: mimeType || 'application/octet-stream',
    fileSize,
    uploaded: [],
    createdAt: Date.now(),
  }
  await writeMeta(sessionDir, meta)

  return NextResponse.json({
    sessionId,
    maxChunkSize: 4 * 1024 * 1024,
    initialChunkSize: 256 * 1024,
  })
}
