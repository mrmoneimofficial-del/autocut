import { db } from '@/lib/db'
import { ownerTokenFrom } from '@/lib/autocut/auth'
import { getOwnedJob, safeJsonParse } from '@/lib/autocut/job'
import { AutoCutError, ERR } from '@/lib/autocut/errors'
import { ensureWorker } from '@/lib/autocut/worker-spawn'
import type { VideoMeta } from '@/lib/autocut/types'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/autocut/jobs/:id/smart — run the ASR + AI smart pass on an
 * ALREADY analyzed job so the text-based editor (transcript panel) works:
 * speech is split into sentences, transcribed, and each sentence gets an
 * AI verdict (filler / repetition / false start / off-topic) shown in red.
 * Deletions are applied by the user from the text panel — nothing is cut
 * automatically (suggestOnly). Re-running resumes the ASR from its cache.
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

    const body = await req.json().catch(() => ({}))
    // 60 ms pauses give sentence-level granularity even on tight-cut videos
    // (measured on the montage job: 1187 sentences, median 1.76 s).
    const pauseMs = Math.max(40, Math.min(320, Number(body?.utterancePauseMs ?? 60) || 60))

    const smartJson = JSON.stringify({
      enabled: true,
      utterancePauseMs: pauseMs,
      suggestOnly: true,
    })

    await db.autoCutJob.update({
      where: { id: row.id },
      data: {
        smartJson,
        status: 'queued_analyze',
        stage: 'detect',
        stageMessage: 'المونتاج الذكي: في الانتظار…',
        progress: 0,
        etaSeconds: null,
        errorJson: null,
        updatedAt: new Date(),
      },
    })
    void ensureWorker()
    return Response.json({ ok: true })
  } catch (e) {
    if (e instanceof AutoCutError) return Response.json(e.toJSON(), { status: e.httpStatus })
    console.error('[autocut] smart error:', e)
    return Response.json(ERR.internal().toJSON(), { status: 500 })
  }
}
