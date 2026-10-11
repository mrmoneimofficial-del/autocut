import { db } from '@/lib/db'
import { ownerTokenFrom } from '@/lib/autocut/auth'
import { getOwnedJob, parseSettings, safeJsonParse } from '@/lib/autocut/job'
import { AutoCutError, ERR } from '@/lib/autocut/errors'
import { buildRenderPlan, validateDecisions } from '@/lib/autocut/planner'
import { DEFAULT_SETTINGS, type SmartInfo } from '@/lib/autocut/types'
import type { Decisions, DetectResponse, VideoMeta } from '@/lib/autocut/types'
import fs from 'node:fs'
import { envelopePath } from '@/lib/autocut/paths'
import { parseEnvelope } from '@/lib/autocut/envelope'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/** GET /api/autocut/jobs/:id/decisions — full review state (regions, settings, envelope info). */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const token = ownerTokenFrom(req)
    const row = await getOwnedJob(id, token)
    if (!row) throw ERR.jobNotFound()
    const settings = safeJsonParse<any>(row.settingsJson) ?? DEFAULT_SETTINGS
    const decisions = safeJsonParse<Decisions>(row.decisionsJson)
    const meta = safeJsonParse<VideoMeta>(row.metaJson)
    let envelope: DetectResponse['envelope'] | null = null
    try {
      if (fs.existsSync(envelopePath(row.id))) {
        const env = parseEnvelope(fs.readFileSync(envelopePath(row.id)))
        const det = safeJsonParse<any>(row.detectionJson)
        envelope = det?.envelope ?? {
          frameMs: env.frameMs,
          frames: env.frames,
          durationMs: env.frames * env.frameMs,
          noiseFloorDb: -100,
          dynamicRangeDb: 0,
        }
      }
    } catch {
      /* envelope optional here */
    }
    return Response.json({
      settings,
      decisions,
      envelope,
      durationMs: meta?.durationMs ?? 0,
      render: decisions?.render ?? { fadeMs: 12, renderMode: 'precision' as const },
      smart: safeJsonParse<SmartInfo>(row.smartJson),
    })
  } catch (e) {
    if (e instanceof AutoCutError) return Response.json(e.toJSON(), { status: e.httpStatus })
    console.error('[autocut] decisions GET error:', e)
    return Response.json(ERR.internal().toJSON(), { status: 500 })
  }
}

/** PUT /api/autocut/jobs/:id/decisions — store the user-reviewed cut list. */
export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const token = ownerTokenFrom(req)
    const row = await getOwnedJob(id, token)
    if (!row) throw ERR.jobNotFound()
    if (!['detected', 'done', 'canceled', 'failed'].includes(row.status)) {
      throw ERR.wrongState(row.status)
    }
    const meta = safeJsonParse<VideoMeta>(row.metaJson)
    const durationMs = meta?.durationMs ?? 0
    const body = await req.json().catch(() => null)
    const decisions = body?.decisions as Decisions | undefined
    if (!decisions) throw new AutoCutError('BAD_REQUEST', 'A decisions object is required.')
    decisions.targetSilenceMs = parseSettings({ targetSilenceMs: decisions.targetSilenceMs })?.targetSilenceMs ?? 300
    const problem = validateDecisions(decisions, durationMs)
    if (problem) throw ERR.invalidDecisions(problem)
    const plan = buildRenderPlan(decisions, durationMs)
    if (plan.fatal) throw new AutoCutError(plan.fatal.code, plan.fatal.message, plan.fatal.details, 422)

    const settings = safeJsonParse<any>(row.settingsJson) ?? DEFAULT_SETTINGS
    settings.targetSilenceMs = decisions.targetSilenceMs
    // smart-cut regions carry expensive ASR+LLM work — never drop them on save
    const smart = safeJsonParse<SmartInfo>(row.smartJson)
    if (smart?.enabled) settings.smartHint = true
    await db.autoCutJob.update({
      where: { id: row.id },
      data: {
        decisionsJson: JSON.stringify(decisions),
        settingsJson: JSON.stringify(settings),
        status: 'detected',
        stage: 'review',
        stageMessage: 'Review detected cuts',
        errorJson: null,
        updatedAt: new Date(),
      },
    })
    return Response.json({ ok: true, stats: plan.stats, warnings: plan.warnings })
  } catch (e) {
    if (e instanceof AutoCutError) return Response.json(e.toJSON(), { status: e.httpStatus })
    console.error('[autocut] decisions PUT error:', e)
    return Response.json(ERR.internal().toJSON(), { status: 500 })
  }
}
