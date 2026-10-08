import { NextResponse } from 'next/server'
import { sessionDirOf, validSessionId, readMeta, bankedBytes, coverageComplete } from '@/lib/upload-session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/uploads/chunked/:sessionId/status — which BYTES already landed?
 * The client asks right after init/resume (and after any failed chunk) so it
 * continues from the exact first missing byte — banked bytes are never
 * re-sent (ported from the مستر منعم status endpoint, v2 range-based).
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
    fileSize: meta.fileSize,
    bankedBytes: bankedBytes(meta),
    coverage: meta.uploaded,
    complete: coverageComplete(meta),
  })
}
