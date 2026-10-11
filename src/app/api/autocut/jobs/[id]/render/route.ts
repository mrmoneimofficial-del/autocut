import { db } from '@/lib/db'
import { ownerTokenFrom } from '@/lib/autocut/auth'
import { getOwnedJob, parseSettings, safeJsonParse } from '@/lib/autocut/job'
import { AutoCutError, ERR } from '@/lib/autocut/errors'
import { buildRenderPlan, validateDecisions } from '@/lib/autocut/planner'
import { STORAGE_ROOT } from '@/lib/autocut/paths'
import { availableDiskBytes } from '@/lib/autocut/disk'
import type { Decisions, VideoMeta } from '@/lib/autocut/types'
import fs from 'node:fs'
import { ensureWorker } from '@/lib/autocut/worker-spawn'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/autocut/jobs/:id/render
 * Validates + stores the final decisions and enqueues the server-side render.
 * The worker picks the job up; progress is reported through the job row.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const token = ownerTokenFrom(req)
    const row = await getOwnedJob(id, token)
    if (!row) throw ERR.jobNotFound()
    if (!['detected', 'done', 'failed', 'canceled'].includes(row.status)) {
      throw ERR.wrongState(row.status)
    }
    const meta = safeJsonParse<VideoMeta>(row.metaJson)
    if (!meta) throw ERR.notDetected()
    const envExists = fs.existsSync(row.id)
    void envExists

    const body = await req.json().catch(() => ({}))
    let decisions = safeJsonParse<Decisions>(row.decisionsJson)
    if (body?.decisions) {
      decisions = body.decisions as Decisions
      decisions.targetSilenceMs =
        parseSettings({ targetSilenceMs: decisions.targetSilenceMs })?.targetSilenceMs ?? 300
    }
    if (!decisions) throw ERR.notDetected()
    if (body?.render) {
      decisions.render = {
        fadeMs: Math.max(0, Math.min(100, Number(body.render.fadeMs ?? 12) || 0)),
        renderMode: body.render.renderMode === 'fast' ? 'fast' : 'precision',
      }
    }
    const problem = validateDecisions(decisions, meta.durationMs)
    if (problem) throw ERR.invalidDecisions(problem)
    const plan = buildRenderPlan(decisions, meta.durationMs)
    if (plan.fatal) throw new AutoCutError(plan.fatal.code, plan.fatal.message, plan.fatal.details, 422)

    // Storage budget for render workspace (segments + output)
    const avail = availableDiskBytes(STORAGE_ROOT)
    const est = Math.min(Number(row.sizeBytes), 8 * 1024 * 1024 * 1024)
    if (avail != null && avail < est * 1.1 + 400 * 1024 * 1024) {
      throw ERR.storageFull(est * 1.1 / 1024 / 1024, avail / 1024 / 1024)
    }

    await db.autoCutJob.update({
      where: { id: row.id },
      data: {
        decisionsJson: JSON.stringify(decisions),
        renderMode: decisions.render.renderMode,
        status: 'queued_render',
        stage: 'render',
        stageMessage: 'Queued for rendering…',
        progress: 0,
        etaSeconds: null,
        errorJson: null,
        outputSize: null,
        outputDuration: null,
        completedAt: null,
        updatedAt: new Date(),
      },
    })
    void ensureWorker()
    return Response.json({ ok: true })
  } catch (e) {
    if (e instanceof AutoCutError) return Response.json(e.toJSON(), { status: e.httpStatus })
    console.error('[autocut] render error:', e)
    return Response.json(ERR.internal().toJSON(), { status: 500 })
  }
}
