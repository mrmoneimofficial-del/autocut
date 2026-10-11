import { db } from '@/lib/db'
import { ownerTokenFrom } from '@/lib/autocut/auth'
import { getOwnedJob, parseSettings, safeJsonParse } from '@/lib/autocut/job'
import { AutoCutError, ERR } from '@/lib/autocut/errors'
import { envelopePath } from '@/lib/autocut/paths'
import { parseEnvelope } from '@/lib/autocut/envelope'
import { detectSilences } from '@/lib/autocut/engine'
import { buildRenderPlan } from '@/lib/autocut/planner'
import { DEFAULT_SETTINGS, isSmartKind } from '@/lib/autocut/types'
import type { CutRegion, Decisions, DetectResponse, VideoMeta } from '@/lib/autocut/types'
import fs from 'node:fs'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/autocut/jobs/:id/detect
 * Re-runs the detection engine over the cached loudness envelope with the
 * submitted settings (milliseconds even for 4-hour videos) and resets the
 * decision set to the engine defaults. Manual per-cut edits made against the
 * previous detection are replaced — the UI warns about this.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const token = ownerTokenFrom(req)
    const row = await getOwnedJob(id, token)
    if (!row) throw ERR.jobNotFound()
    if (!['detected', 'done', 'canceled', 'failed', 'queued_render'].includes(row.status)) {
      throw ERR.wrongState(row.status)
    }
    const envPath = envelopePath(row.id)
    if (!fs.existsSync(envPath)) {
      throw new AutoCutError('NO_DETECTION', 'The loudness map for this job is missing. Retry analysis first.', undefined, 409)
    }
    const body = await req.json().catch(() => ({}))
    const settings = parseSettings((body as any)?.settings) ?? safeJsonParse<any>(row.settingsJson) ?? DEFAULT_SETTINGS

    const env = parseEnvelope(fs.readFileSync(envPath))
    const started = Date.now()
    const result = detectSilences(env, settings)
    const meta = safeJsonParse<VideoMeta>(row.metaJson)
    const durationMs = meta?.durationMs ?? result.envelope.durationMs

    const decisions: Decisions = {
      regions: result.regions,
      targetSilenceMs: settings.targetSilenceMs,
      render: safeJsonParse<Decisions>(row.decisionsJson)?.render ?? { fadeMs: 12, renderMode: 'precision' },
    }
    // preserve expensive smart-cut regions across re-detection — they live in
    // speech (not silence), so fresh silence regions never invalidate them
    const priorRegions = safeJsonParse<Decisions>(row.decisionsJson)?.regions ?? []
    const smartRegions: CutRegion[] = priorRegions.filter((r) => isSmartKind(r.kind))
    if (smartRegions.length > 0) {
      decisions.regions = [...result.regions, ...smartRegions].sort((a, b) => a.startMs - b.startMs)
    }
    const plan = buildRenderPlan(decisions, durationMs)

    const warnings = [...plan.warnings]
    if (result.effectiveThresholdDb > settings.thresholdDb + 0.5) {
      warnings.push(
        `Background noise measured at ${result.envelope.noiseFloorDb} dB — the effective threshold was raised to ` +
          `${Math.round(result.effectiveThresholdDb)} dB to stay above the room tone.`
      )
    }

    const payload: DetectResponse = {
      settings,
      regions: decisions.regions,
      stats: plan.stats,
      warnings,
      envelope: result.envelope,
    }

    await db.autoCutJob.update({
      where: { id: row.id },
      data: {
        status: 'detected',
        stage: 'review',
        stageMessage: 'Review detected cuts',
        progress: 100,
        etaSeconds: null,
        errorJson: null,
        settingsJson: JSON.stringify(settings),
        detectionJson: JSON.stringify({ regions: result.regions, envelope: result.envelope, effectiveThresholdDb: result.effectiveThresholdDb }),
        decisionsJson: JSON.stringify(decisions),
        analysisMs: Date.now() - started,
        updatedAt: new Date(),
      },
    })

    return Response.json(payload)
  } catch (e) {
    if (e instanceof AutoCutError) return Response.json(e.toJSON(), { status: e.httpStatus })
    console.error('[autocut] detect error:', e)
    return Response.json(ERR.internal().toJSON(), { status: 500 })
  }
}
