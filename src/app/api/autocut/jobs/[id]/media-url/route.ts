import { ownerTokenFrom, signMediaUrl } from '@/lib/autocut/auth'
import { getOwnedJob } from '@/lib/autocut/job'
import { ERR, AutoCutError } from '@/lib/autocut/errors'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/autocut/jobs/:id/media-url
 * Issues expiring signed URLs for the original stream and (when ready) the
 * rendered output. Signed URLs exist because <video> elements cannot attach
 * authorization headers (requirement 28).
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const token = ownerTokenFrom(req)
    const row = await getOwnedJob(id, token)
    if (!row) throw ERR.jobNotFound()
    const streamUrl = signMediaUrl(row.id, 'stream')
    const outputUrl = row.status === 'done' ? signMediaUrl(row.id, 'output') : null
    const downloadUrl = row.status === 'done' ? signMediaUrl(row.id, 'output') + '&download=1' : null
    return Response.json({ streamUrl, outputUrl, downloadUrl })
  } catch (e) {
    if (e instanceof AutoCutError) return Response.json(e.toJSON(), { status: e.httpStatus })
    console.error('[autocut] media-url error:', e)
    return Response.json(ERR.internal().toJSON(), { status: 500 })
  }
}
