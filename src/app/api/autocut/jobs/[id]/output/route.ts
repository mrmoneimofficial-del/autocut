import { verifyMediaSignature } from '@/lib/autocut/auth'
import { ownerTokenFrom } from '@/lib/autocut/auth'
import { serveMediaFile } from '@/lib/autocut/media'
import { outputPath } from '@/lib/autocut/paths'
import { db } from '@/lib/db'
import type { AutoCutJob } from '@prisma/client'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/autocut/jobs/:id/output — the FINAL rendered video.
 * `?download=1` switches to an attachment download with a friendly name.
 */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  const url = new URL(req.url)
  const download = url.searchParams.get('download') === '1'
  const sigOk = verifyMediaSignature(id, 'output', Number(url.searchParams.get('exp')), url.searchParams.get('sig'))
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
  if (row.status !== 'done') {
    return Response.json(
      { code: 'NOT_READY', message: 'The final video is not ready yet.' },
      { status: 409 }
    )
  }
  const base = row.filename.replace(/\.[^.]+$/, '')
  const name = download ? `${base} (auto-cut).mp4` : undefined
  return serveMediaFile(req, outputPath(row.id), 'video/mp4', name)
}
