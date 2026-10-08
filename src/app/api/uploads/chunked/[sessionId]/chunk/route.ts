import { NextResponse } from 'next/server'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  sessionDirOf, validSessionId, readMeta, writeMeta, verifyChecksum,
} from '@/lib/upload-session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/uploads/chunked/:sessionId/chunk?index=N&c=checksum
 * Body = the RAW chunk bytes. Idempotent (duplicate chunks are ignored →
 * safe with retries + resume), verifies expected byte size + the same sampled
 * checksum the client computes. Ported verbatim from the مستر منعم system.
 */
export async function POST(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params
  if (!validSessionId(sessionId)) {
    return NextResponse.json({ error: 'جلسة الرفع غير موجودة أو منتهية' }, { status: 404 })
  }
  const sessionDir = sessionDirOf(sessionId)

  const meta = await readMeta(sessionDir)
  if (!meta) {
    return NextResponse.json({ error: 'جلسة الرفع غير موجودة أو منتهية' }, { status: 404 })
  }

  // Chunk index comes from the query; the body is the raw chunk bytes.
  const url = new URL(req.url)
  const index = parseInt(url.searchParams.get('index') || '', 10)
  if (!Number.isFinite(index) || index < 0 || index >= meta.totalChunks) {
    return NextResponse.json({ error: 'رقم الجزء غير صالح' }, { status: 400 })
  }

  // Already uploaded? Skip (idempotent — supports resume).
  if (meta.uploadedChunks.includes(index)) {
    return NextResponse.json({
      ok: true, uploaded: meta.uploadedChunks.length, total: meta.totalChunks, skipped: true,
    })
  }

  // Read the chunk body and write it to disk. Each chunk is at most 4MB, so
  // holding one in memory is fine.
  const chunkBuf = Buffer.from(await req.arrayBuffer())
  const expectedSize = Math.min(meta.chunkSize, meta.fileSize - index * meta.chunkSize)
  if (chunkBuf.length !== expectedSize) {
    return NextResponse.json(
      { error: `حجم الجزء غير متطابق (متوقع ${expectedSize}، مستلم ${chunkBuf.length})` },
      { status: 400 },
    )
  }

  // Verify integrity with the same lightweight sampled checksum the client
  // uses — fast and sufficient for transport integrity.
  const checksum = verifyChecksum(chunkBuf)
  const clientChecksum = url.searchParams.get('c')
  if (clientChecksum && clientChecksum !== checksum) {
    return NextResponse.json({ error: 'فشل التحقق من سلامة الجزء — أعد الإرسال' }, { status: 422 })
  }

  await fs.writeFile(path.join(sessionDir, `${index}.chunk`), chunkBuf)
  meta.uploadedChunks.push(index)
  meta.uploadedChunks.sort((a, b) => a - b)
  await writeMeta(sessionDir, meta)

  return NextResponse.json({
    ok: true,
    uploaded: meta.uploadedChunks.length,
    total: meta.totalChunks,
  })
}
