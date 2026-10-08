import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { signPathToken } from '@/lib/storage-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ROOT = path.join(process.cwd(), 'storage', 'jobs')
const RUNNER = path.join(process.cwd(), 'scripts', 'pipeline-runner.mjs')
const ACTIVE = new Set(['analyzing', 'rendering', 'mirroring'])

type Ctx = { params: Promise<{ id: string }> }

function readJSON<T = Record<string, unknown>>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch { return null }
}

function jobDirOf(id: string) { return path.join(ROOT, id) }

function statusOf(id: string) {
  const job = readJSON<Record<string, any>>(path.join(ROOT, id, 'job.json'))
  if (!job) return null
  const prog = readJSON(path.join(ROOT, id, 'progress.json'))
  const st: Record<string, any> = { ...job, progress: prog && ACTIVE.has(String(prog.phase)) ? prog : null }

  // permanent download link for the finished result (Bunny Storage + signed
  // token) — minted fresh on every poll so a restored tab keeps working
  if (st.phase === 'done' && st.storage?.path) {
    st.resultUrl = `/api/uploads/stream?t=${signPathToken(String(st.storage.path))}&dl=1`
  }
  if (st.phase === 'done' && st.asset?.path) {
    st.originalUrl = `/api/uploads/stream?t=${signPathToken(String(st.asset.path))}`
  }

  // stall recovery — server/container restarts (e.g. host reboot, Space wake) kill the
  // detached runner and the job would spin forever. If an active phase went quiet for
  // 10+ minutes, flip to error so the user can hit "إعادة المحاولة".
  if (ACTIVE.has(String(st.phase))) {
    const mark = path.join(ROOT, id, 'progress.json')
    let mtime = 0
    try { mtime = fs.statSync(fs.existsSync(mark) ? mark : path.join(ROOT, id, 'job.json')).mtimeMs } catch { /* ignore */ }
    if (mtime && Date.now() - mtime > 10 * 60_000) {
      st.phase = 'error'
      st.error = 'المعالجة اتوقفت فجأة (السيرفر اتعمل له ريستارت) — اضغط "إعادة المحاولة" وهنكمّل من عندها'
      st.progress = null
      const jobFile = path.join(ROOT, id, 'job.json')
      try {
        fs.writeFileSync(jobFile, JSON.stringify({ ...job, phase: 'error', error: st.error }))
      } catch { /* concurrent write — next poll retries */ }
    }
  }
  return st
}

/** GET /api/jobs/:id — full status (polled by the UI). */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  if (!/^[a-f0-9]{32}$/.test(id)) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  const st = statusOf(id)
  if (!st) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  return Response.json(st)
}

/** POST /api/jobs/:id — { action: 'analyze' } |
 *  { action:'render', gapMs, thresholdDb, crf, cuts?: [start,end][] }
 *  (jobs are staged as phase 'uploaded' by /api/uploads/chunked/complete.
 *   `cuts` = the EXPLICIT montage plan computed (and hand-tuned) in the browser
 *   from the audio envelope — the render then matches the preview exactly.) */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  if (!/^[a-f0-9]{32}$/.test(id)) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  const dir = jobDirOf(id)
  const jobFile = path.join(dir, 'job.json')
  const job = readJSON<Record<string, any>>(jobFile)
  if (!job) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })

  const body = await req.json().catch(() => null)
  const action = body?.action

  if (action === 'analyze') {
    if (job.phase !== 'uploaded' && job.phase !== 'error') {
      return Response.json({ error: 'الحالة الحالية مش صالحة للتحليل' }, { status: 409 })
    }
    job.phase = 'analyzing'
    job.error = undefined
    fs.writeFileSync(jobFile, JSON.stringify(job))
    spawnRunner(id, 'analyze')
    return Response.json({ ok: true })
  }

  if (action === 'render') {
    // 'done' too → re-cut with tweaked settings without re-uploading
    if (job.phase !== 'ready' && job.phase !== 'error' && job.phase !== 'done') {
      return Response.json({ error: 'الفيديو مش جاهز للقص بعد' }, { status: 409 })
    }
    const clamp = (v: unknown, lo: number, hi: number, d: number) => {
      const n = Number(v)
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d
    }
    const settings: Record<string, unknown> = {
      gapMs: clamp(body?.gapMs, 0, 1000, 200),
      thresholdDb: clamp(body?.thresholdDb, -70, -5, -35),
      crf: clamp(body?.crf, 18, 40, 32),
    }

    // explicit montage cuts from the browser (validated + sanitized here,
    // re-validated in the runner — both sides must agree on the plan)
    if (Array.isArray(body?.cuts)) {
      const durMs = Number(job?.meta?.durationMs || 0)
      const maxEnd = durMs > 0 ? durMs + 2000 : Number.MAX_SAFE_INTEGER
      const raw = (body.cuts as unknown[])
        .filter((c): c is [number, number] => Array.isArray(c) && c.length >= 2
          && Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1])))
        .map((c) => [Math.max(0, Math.round(Number(c[0]))), Math.round(Number(c[1]))] as [number, number])
        .filter(([s, e]) => e - s >= 20 && s < maxEnd)
        .sort((a, b) => a[0] - b[0])
      const merged: Array<[number, number]> = []
      for (const [s, e] of raw) {
        const last = merged[merged.length - 1]
        if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e)
        else merged.push([s, e])
      }
      if (!merged.length) return Response.json({ error: 'مفيش فجوات مختارة — عدّل الإعدادات الأول' }, { status: 400 })
      settings.cuts = merged.slice(0, 2000)
    }

    job.phase = 'rendering'
    job.error = undefined
    job.renderSettings = settings
    fs.writeFileSync(jobFile, JSON.stringify(job))
    // results go to the upload session folder on Bunny Storage
    const resultDir = job.asset?.path ? `uploads/${String(job.asset.path).split('/')[1]}` : `uploads/${id}`
    spawnRunner(id, 'render', JSON.stringify(settings), resultDir)
    return Response.json({ ok: true })
  }

  return Response.json({ error: 'action غير معروف' }, { status: 400 })
}

/** Spawn the pipeline runner detached — it survives request end & HMR reloads. */
function spawnRunner(id: string, action: string, settings?: string, resultDir?: string) {
  const dir = jobDirOf(id)
  const logFd = fs.openSync(path.join(dir, 'spawn.log'), 'a')
  const child = spawn(process.execPath, [RUNNER, id, action, ...(settings ? [settings] : [])], {
    cwd: path.join(process.cwd(), 'scripts'),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, ...(resultDir ? { QATTAAS_RESULT_DIR: resultDir } : {}) },
  })
  child.unref()
  setTimeout(() => { try { fs.closeSync(logFd) } catch { /* already closed */ } }, 10_000)
}
