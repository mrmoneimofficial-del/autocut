import { db } from '@/lib/db'
import { ownerTokenFrom } from '@/lib/autocut/auth'
import { getOwnedJob } from '@/lib/autocut/job'
import { AutoCutError, ERR } from '@/lib/autocut/errors'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/autocut/jobs/:id/cancel
 * The worker watches the job row while processing and kills FFmpeg within a
 * second of cancellation. Finished segments are kept for a later retry.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const token = ownerTokenFrom(req)
    const row = await getOwnedJob(id, token)
    if (!row) throw ERR.jobNotFound()
    if (!['queued_analyze', 'analyzing', 'queued_render', 'rendering', 'finalizing'].includes(row.status)) {
      throw ERR.wrongState(row.status)
    }
    await db.autoCutJob.update({
      where: { id: row.id },
      data: {
        status: 'canceled',
        stage: 'error',
        stageMessage: 'Canceled — you can retry at any time',
        etaSeconds: null,
      },
    })
    return Response.json({ ok: true })
  } catch (e) {
    if (e instanceof AutoCutError) return Response.json(e.toJSON(), { status: e.httpStatus })
    console.error('[autocut] cancel error:', e)
    return Response.json(ERR.internal().toJSON(), { status: 500 })
  }
}
