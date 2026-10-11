import { NextResponse } from 'next/server'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  sessionDirOf, validSessionId, readMeta, writeMeta, verifyChecksum,
  bankedBytes, isCovered, overlapsCoverage, MAX_CHUNK_BODY,
} from '@/lib/upload-session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * POST /api/uploads/chunked/:sessionId/chunk?start=S&len=L&c=checksum
 * Body = the RAW chunk bytes for the byte range [S, S+L).
 *
 * PROTOCOL v2 — adaptive chunks: S and L are chosen by the client at runtime
 * (it shrinks L when a proxy kills big/slow requests and grows it back on
 * fast links). The server is size-agnostic: it only records which byte
 * ranges have landed, which makes uploads immune to the "one chunk then
 * restart" failure (whatever lands is banked forever; the client resumes
 * from the exact first missing byte).
 *
 * Idempotent: a fully-covered range is skipped (safe with retries + resume).
 * Partial overlap → 409 + current coverage (the client resyncs and sends
 * only the uncovered remainder).
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

  const url = new URL(req.url)
  const start = Number(url.searchParams.get('start'))
  const len = Number(url.searchParams.get('len'))
  if (!Number.isFinite(start) || !Number.isFinite(len) || start < 0 || len <= 0) {
    return NextResponse.json({ error: 'نطاق الجزء غير صالح' }, { status: 400 })
  }
  if (len > MAX_CHUNK_BODY) {
    return NextResponse.json(
      { error: `حجم الجزء أكبر من الحد (${MAX_CHUNK_BODY} بايت) — صغّر القطع` },
      { status: 400 },
    )
  }
  if (start + len > meta.fileSize) {
    return NextResponse.json(
      { error: `النطاق برة الملف (الملف ${meta.fileSize} بايت)` },
      { status: 400 },
    )
  }

  // Fully landed already? Skip (idempotent — supports resume + retries).
  if (isCovered(meta, start, start + len)) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      bankedBytes: bankedBytes(meta),
      coverage: meta.uploaded,
    })
  }

  // Partial overlap (client resync needed — it should send only the gap)
  if (overlapsCoverage(meta, start, start + len)) {
    return NextResponse.json(
      {
        error: 'النطاق بيتقاطع مع أجزاء اترفعت خلاص — زامن التغطية وابعت الفاضل بس',
        coverage: meta.uploaded,
      },
      { status: 409 },
    )
  }

  // Read the chunk body and write it to disk. Capped at MAX_CHUNK_BODY, so
  // holding one in memory is fine.
  const chunkBuf = Buffer.from(await req.arrayBuffer())
  if (chunkBuf.length !== len) {
    return NextResponse.json(
      { error: `حجم الجزء غير متطابق (متوقع ${len}، مستلم ${chunkBuf.length})` },
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

  // Bank the range: one chunk file per landed range, named by its start.
  await fs.writeFile(path.join(sessionDir, `${start}.chunk`), chunkBuf)
  meta.uploaded.push({ start, end: start + len })
  await writeMeta(sessionDir, meta)

  return NextResponse.json({
    ok: true,
    bankedBytes: bankedBytes(meta),
    coverage: meta.uploaded,
  })
}
