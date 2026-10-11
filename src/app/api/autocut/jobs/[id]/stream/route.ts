import { verifyMediaSignature } from '@/lib/autocut/auth'
import { ownerTokenFrom } from '@/lib/autocut/auth'
import { serveMediaFile } from '@/lib/autocut/media'
import { originalPath, fileExt } from '@/lib/autocut/paths'
import { db } from '@/lib/db'
import type { AutoCutJob } from '@prisma/client'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/autocut/jobs/:id/stream — the ORIGINAL uploaded video, with HTTP
 * Range support, behind an expiring signed URL (video elements cannot send
 * auth headers). The browser streams only what it plays — a 4-hour video
 * never sits in RAM.
 */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  const url = new URL(req.url)
  const sigOk = verifyMediaSignature(id, 'stream', Number(url.searchParams.get('exp')), url.searchParams.get('sig'))
  let row: AutoCutJob | null = null
  if (!sigOk) {
    const token = ownerTokenFrom(req)
    if (token) {
      // single-user studio: any session token may reach the media fallback
      row = await db.autoCutJob.findUnique({ where: { id } })
      if (!row) {
        return Response.json({ code: 'FORBIDDEN', message: 'Not the job owner.' }, { status: 403 })
      }
    } else {
      return Response.json({ code: 'BAD_SIGNATURE', message: 'Invalid or expired media link.' }, { status: 403 })
    }
  } else {
    row = await db.autoCutJob.findUnique({ where: { id } })
  }
  if (!row) return Response.json({ code: 'JOB_NOT_FOUND', message: 'Job not found.' }, { status: 404 })
  const path = originalPath(row.id, fileExt(row.filename))
  return serveMediaFile(req, path, row.mime || 'video/mp4')
}
