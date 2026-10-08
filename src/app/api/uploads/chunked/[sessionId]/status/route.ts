import { NextResponse } from 'next/server'
import { sessionDirOf, validSessionId, readMeta } from '@/lib/upload-session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/uploads/chunked/:sessionId/status — which chunks already landed?
 * The client asks right after init/resume so it continues from where a
 * previous attempt stopped (ported verbatim from the مستر منعم system).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params
  if (!validSessionId(sessionId)) {
    return NextResponse.json({ error: 'جلسة الرفع غير موجودة' }, { status: 404 })
  }
  const meta = await readMeta(sessionDirOf(sessionId))
  if (!meta) {
    return NextResponse.json({ error: 'جلسة الرفع غير موجودة' }, { status: 404 })
  }
  return NextResponse.json({
    sessionId: meta.sessionId,
    totalChunks: meta.totalChunks,
    uploadedChunks: meta.uploadedChunks,
    fileSize: meta.fileSize,
    complete: meta.uploadedChunks.length === meta.totalChunks,
  })
}
