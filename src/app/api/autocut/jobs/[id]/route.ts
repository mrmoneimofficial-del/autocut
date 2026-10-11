import { db } from '@/lib/db'
import { ownerTokenFrom } from '@/lib/autocut/auth'
import { getOwnedJob, jobToDTO } from '@/lib/autocut/job'
import { AutoCutError, ERR } from '@/lib/autocut/errors'
import { jobDir } from '@/lib/autocut/paths'
import fs from 'node:fs'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

function jsonError(e: unknown): Response {
  if (e instanceof AutoCutError) return Response.json(e.toJSON(), { status: e.httpStatus })
  console.error('[autocut] internal error:', e)
  const fallback = ERR.internal()
  return Response.json(fallback.toJSON(), { status: fallback.httpStatus })
}

/** GET /api/autocut/jobs/:id — status (polled while processing). */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const token = ownerTokenFrom(req)
    const row = await getOwnedJob(id, token)
    if (!row) throw ERR.jobNotFound()
    return Response.json({ job: jobToDTO(row) })
  } catch (e) {
    return jsonError(e)
  }
}

/** DELETE /api/autocut/jobs/:id — remove job + every file. Original is never
 *  touched during processing; deletion is the only destructive op, and it is
 *  explicit. */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const token = ownerTokenFrom(req)
    const row = await getOwnedJob(id, token)
    if (!row) throw ERR.jobNotFound()
    if (['rendering', 'finalizing', 'analyzing'].includes(row.status)) {
      // mark canceled first; worker will stop, cleanup sweep removes files
      await db.autoCutJob.update({
        where: { id },
        data: { status: 'canceled', stage: 'error', stageMessage: 'Canceled by user' },
      })
      return Response.json({ ok: true, pendingCleanup: true })
    }
    await db.autoCutJob.delete({ where: { id } }).catch(() => {})
    fs.rmSync(jobDir(id), { recursive: true, force: true })
    return Response.json({ ok: true })
  } catch (e) {
    return jsonError(e)
  }
}
