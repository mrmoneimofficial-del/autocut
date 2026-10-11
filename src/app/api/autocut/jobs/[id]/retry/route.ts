import { db } from '@/lib/db'
import { ownerTokenFrom } from '@/lib/autocut/auth'
import { getOwnedJob } from '@/lib/autocut/job'
import { AutoCutError, ERR } from '@/lib/autocut/errors'
import fs from 'node:fs'
import { ensureWorker } from '@/lib/autocut/worker-spawn'
import { envelopePath } from '@/lib/autocut/paths'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/autocut/jobs/:id/retry
 * Re-enqueue a failed job. Renders resume from completed segments; analysis
 * restarts only if the loudness envelope is missing.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const token = ownerTokenFrom(req)
    const row = await getOwnedJob(id, token)
    if (!row) throw ERR.jobNotFound()
    if (!['failed', 'canceled'].includes(row.status)) throw ERR.wrongState(row.status)

    const hasEnvelope = fs.existsSync(envelopePath(row.id))
    const data = hasEnvelope
      ? {
          status: 'queued_render',
          stage: 'render',
          stageMessage: 'Retrying render…',
          progress: 0,
          errorJson: null,
          etaSeconds: null,
        }
      : {
          status: 'queued_analyze',
          stage: 'probe',
          stageMessage: 'Retrying analysis…',
          progress: 0,
          errorJson: null,
          etaSeconds: null,
        }
    await db.autoCutJob.update({ where: { id: row.id }, data })
    void ensureWorker()
    return Response.json({ ok: true })
  } catch (e) {
    if (e instanceof AutoCutError) return Response.json(e.toJSON(), { status: e.httpStatus })
    console.error('[autocut] retry error:', e)
    return Response.json(ERR.internal().toJSON(), { status: 500 })
  }
}
