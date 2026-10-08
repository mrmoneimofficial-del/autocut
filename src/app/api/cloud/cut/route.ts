import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { resolveBins, downloadToFile, resolveRunnerPath } from '@/lib/cloud'
import { bunnyUrl, bunnyReadHeaders } from '@/lib/bunny-storage'
import { signPathToken, verifyPathToken, validRemotePath } from '@/lib/storage-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// Vercel: 300s is the Hobby-plan maximum under Fluid compute (the default
// since mid-2025). The internal deadline stays below it with margin.
export const maxDuration = 300

const CLOUD_ROOT = path.join(os.tmpdir(), 'qattaas-cloud')
const UPLOADS_DIR = '/tmp/uploads'
const EXT_OK = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.webm', '.avi', '.ts'])
const DEADLINE_MS = 265_000
const MAX_CONCURRENT = 2
let active = 0

type Ev = Record<string, unknown> & { stage: string }

/** the client-side asset ref produced by /api/uploads/chunked/complete */
type AssetRef = {
  path: string
  name: string
  size: number
  token: string
}

/**
 * POST /api/cloud/cut — body: { file: AssetRef, settings: {gapMs, thresholdDb, crf} }
 * Streams NDJSON events: download → cut → done|error. All work happens inside
 * this single request (serverless-friendly: no shared state, no background jobs).
 * The original comes from Bunny Storage via the signed token (warm /tmp copies
 * first), and the result lands back in the SAME session folder on Bunny.
 */
export async function POST(req: Request) {
  if (active >= MAX_CONCURRENT) {
    return Response.json(
      { error: 'فيه معالجة سحابية تانية شغالة دلوقتي — استنى ثواني وجرّب تاني' },
      { status: 429 },
    )
  }

  const body = await req.json().catch(() => null)
  const f = body?.file as AssetRef | undefined
  const s = body?.settings || {}

  // ---- validation: signed token must cover the exact requested path ----
  const claims = f?.token ? verifyPathToken(String(f.token)) : null
  if (!f || !validRemotePath(f.path) || !claims || claims.path !== f.path) {
    return Response.json({ error: 'بيانات الملف السحابي غير صحيحة أو انتهت صلاحيتها — ارفع الفيديو من جديد' }, { status: 401 })
  }
  const nameOk = typeof f.name === 'string' && f.name.length > 0 && f.name.length <= 200
  if (!nameOk) {
    return Response.json({ error: 'بيانات الملف السحابي غير صحيحة' }, { status: 400 })
  }
  const extRaw = path.extname(f.name).toLowerCase()
  const ext = EXT_OK.has(extRaw) ? extRaw : '.mp4'
  const name = f.name.replace(/[/\\:*?"<>|]+/g, '_').slice(0, 120) || 'video'
  const settings = {
    gapMs: [100, 200, 300].includes(Number(s.gapMs)) ? Number(s.gapMs) : 200,
    thresholdDb: [-40, -35, -30].includes(Number(s.thresholdDb)) ? Number(s.thresholdDb) : -35,
    crf: [28, 32, 36].includes(Number(s.crf)) ? Number(s.crf) : 32,
  }
  const maxBytes = Number(process.env.CLOUD_MAX_MB || 200) * 1024 * 1024
  const declaredSize = Number(f.size || 0)
  if (declaredSize && declaredSize > maxBytes) {
    return Response.json(
      { error: `الفيديو أكبر من ${Math.round(maxBytes / 1024 / 1024)} م.ب — ده الحد الأقصى للمسار السحابي. للفيديوهات الكبيرة شغّل نسخة كاملة مجانًا (Colab / Codespaces)` },
      { status: 400 },
    )
  }

  const bins = resolveBins()
  if (!bins.ok) {
    return Response.json(
      { error: 'المعالجة مش متاحة على الاستضافة دي — الرفع شغال، لكن القص محتاج نسخة كاملة (Colab / Codespaces)' },
      { status: 501 },
    )
  }
  const RUNNER = resolveRunnerPath()
  if (!RUNNER) {
    return Response.json({ error: 'محرك المعالجة مش موجود على السيرفر ده' }, { status: 500 })
  }

  // session folder on Bunny = uploads/<sid>/… ; result goes to the same one
  const sessionId = f.path.split('/')[1] || 'unknown'
  const jobId = crypto.createHash('sha256').update(f.path).digest('hex').slice(0, 32)
  const dir = path.join(CLOUD_ROOT, jobId)

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      let closed = false
      const send = (ev: Ev) => {
        if (closed) return
        try { controller.enqueue(encoder.encode(JSON.stringify(ev) + '\n')) } catch { closed = true }
      }

      let child: ChildProcess | null = null
      const killChild = () => { try { child?.kill('SIGKILL') } catch { /* already gone */ } }
      const onClientAbort = () => killChild()
      req.signal.addEventListener('abort', onClientAbort)

      active++
      try {
        sweepCloudRoot()
        fs.mkdirSync(dir, { recursive: true })
        const src = path.join(dir, 'original' + ext)
        const jobFile = path.join(dir, 'job.json')
        const progFile = path.join(dir, 'progress.json')

        // ---- 1. bring the original over ----
        // tier 1: warm copy from a previous cut of the same file
        // tier 2: the upload session's merged.bin (same instance as complete)
        // tier 3: download from Bunny Storage (signed path + read key)
        const have = fs.existsSync(src) && (!declaredSize || fs.statSync(src).size === declaredSize)
        if (!have) {
          const sessionMerged = path.join(UPLOADS_DIR, sessionId, 'merged.bin')
          let staged = false
          if (fs.existsSync(sessionMerged)) {
            try {
              await fs.promises.copyFile(sessionMerged, src)
              staged = fs.statSync(src).size > 1000
                && (!declaredSize || fs.statSync(src).size === declaredSize)
            } catch { /* fall through to download */ }
          }
          if (!staged) {
            send({ stage: 'download', pct: 0, text: 'بننزّل الفيديو من التخزين السحابي…' })
            const abort = AbortSignal.any([req.signal, AbortSignal.timeout(DEADLINE_MS)])
            const got = await downloadToFile(bunnyUrl(f.path), src, {
              maxBytes,
              signal: abort,
              headers: bunnyReadHeaders(),
              onProgress: (gotBytes, total) => {
                const pct = total ? Math.min(99, Math.round((gotBytes / total) * 100)) : 0
                send({ stage: 'download', pct, text: 'بننزّل الفيديو من التخزين السحابي…' })
              },
            })
            if (got < 1000) throw new Error('الملف اللي اتنزّل من التخزين فاضي أو بايظ')
          }
        }

        // ---- 2. job.json for the runner ----
        const size = fs.statSync(src).size
        fs.writeFileSync(jobFile, JSON.stringify({
          id: jobId, name, size, ext, phase: 'uploaded', uploaded: size, createdAt: Date.now(),
          asset: { path: f.path },
        }))

        // ---- 3. run the exact same proven pipeline (scan + plan + cut + mirror) ----
        send({ stage: 'cut', pct: 1, text: 'بنجهّز المعالجة…' })
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          QATTAAS_JOBS_ROOT: CLOUD_ROOT,
          FFMPEG_PATH: bins.ffmpeg,
          FFPROBE_PATH: bins.ffprobe,
          QATTAAS_CLOUD: '1',
          QATTAAS_RESULT_DIR: `uploads/${sessionId}`,
        }
        child = spawn(
          process.execPath,
          [RUNNER, jobId, 'render', JSON.stringify(settings)],
          { cwd: path.dirname(RUNNER), stdio: ['ignore', 'pipe', 'pipe'], env },
        )
        let childLog = ''
        child.stdout?.on('data', (d) => { childLog += d.toString() })
        child.stderr?.on('data', (d) => { if (childLog.length < 8000) childLog += d.toString() })

        // poll progress.json and forward changes as they happen
        const exitCode = await new Promise<number>((resolve) => {
          const t0 = Date.now()
          let lastProg = ''
          const iv = setInterval(() => {
            if (req.signal.aborted) { killChild(); clearInterval(iv); resolve(-1); return }
            if (Date.now() - t0 > DEADLINE_MS) {
              killChild(); clearInterval(iv)
              send({
                stage: 'error',
                error: 'المعالجة اتأخرت أكتر من المسموح على المسار السحابي — جرّب فيديو أقصر/أصغر، أو شغّل النسخة الكاملة مجانًا من Colab / Codespaces',
              })
              closed = true // the error is definitive; stop streaming
              resolve(-2)
              return
            }
            try {
              const p = fs.readFileSync(progFile, 'utf8')
              if (p !== lastProg) {
                lastProg = p
                const prog = JSON.parse(p)
                if (prog.phase === 'rendering' || prog.phase === 'mirroring') {
                  send({
                    stage: 'cut',
                    pct: Math.max(1, Math.min(99, Math.round(prog.pct || 1))),
                    text: prog.stage || 'بنقصّ الفيديو…',
                    ...(prog.speedX != null ? { speedX: prog.speedX } : {}),
                    ...(prog.etaSec != null ? { etaSec: prog.etaSec } : {}),
                  })
                }
              }
            } catch { /* not written yet */ }
          }, 400)
          child!.on('close', (code) => { clearInterval(iv); resolve(code ?? -1) })
          child!.on('error', () => { clearInterval(iv); resolve(-1) })
        })

        if (exitCode === -2) { /* deadline error already sent */ }
        else {
          const job = readJSON(jobFile)
          if (job && job.phase === 'done') {
            const storage = job.storage || null
            send({
              stage: 'done',
              result: {
                original: `/api/uploads/stream?t=${signPathToken(f.path)}`,
                resultUrl: storage?.path
                  ? `/api/uploads/stream?t=${signPathToken(storage.path)}&dl=1`
                  : null,
                storage,
                output: job.output || null,
                plan: job.plan || null,
                meta: job.meta || null,
              },
            })
          } else {
            const detail = job && job.error ? String(job.error) : `المعالجة فشلت (${exitCode})`
            send({ stage: 'error', error: detail, ...(childLog ? { log: childLog.slice(-600) } : {}) })
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        send({ stage: 'error', error: msg === 'اتلغى' ? 'اتلغى الطلب' : msg })
      } finally {
        active--
        req.signal.removeEventListener('abort', onClientAbort)
        killChild()
        try { controller.close() } catch { /* already closed */ }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}

function readJSON<T = Record<string, any>>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch { return null }
}

/** drop cloud job dirs older than 30 min (re-cut cache + crashed leftovers) */
function sweepCloudRoot() {
  try {
    if (!fs.existsSync(CLOUD_ROOT)) return
    const cutoff = Date.now() - 30 * 60_000
    for (const id of fs.readdirSync(CLOUD_ROOT)) {
      const dir = path.join(CLOUD_ROOT, id)
      try {
        if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true })
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
