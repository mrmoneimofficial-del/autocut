import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  resolveBins, resolveGofileDownload, downloadToFile, resolveRunnerPath, type GoFileRef,
} from '@/lib/cloud'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// Vercel: 300s is the Hobby-plan maximum under Fluid compute (the default
// since mid-2025). The internal deadline stays below it with margin.
export const maxDuration = 300

const CLOUD_ROOT = path.join(os.tmpdir(), 'qattaas-cloud')
const EXT_OK = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.webm', '.avi', '.ts'])
const DEADLINE_MS = 265_000
const MAX_CONCURRENT = 2
let active = 0

type Ev = Record<string, unknown> & { stage: string }

/** POST /api/cloud/cut — body: { file: GoFileRef, settings: {gapMs, thresholdDb, crf} }
 *  Streams NDJSON events: download → cut → done|error. All work happens inside
 *  this single request (serverless-friendly: no shared state, no background jobs). */
export async function POST(req: Request) {
  if (active >= MAX_CONCURRENT) {
    return Response.json(
      { error: 'فيه معالجة سحابية تانية شغالة دلوقتي — استنى ثواني وجرّب تاني' },
      { status: 429 },
    )
  }

  const body = await req.json().catch(() => null)
  const f = body?.file as GoFileRef | undefined
  const s = body?.settings || {}

  // ---- validation ----
  const nameOk = typeof f?.name === 'string' && f.name.length > 0 && f.name.length <= 200
  if (!f || typeof f.id !== 'string' || !/^[A-Za-z0-9-]{6,64}$/.test(f.id) || !nameOk) {
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
  if (f.guestToken !== undefined && (typeof f.guestToken !== 'string' || f.guestToken.length > 4000)) {
    return Response.json({ error: 'بيانات الملف السحابي غير صحيحة' }, { status: 400 })
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

  const jobId = crypto.createHash('sha256').update(`${f.id}:${f.name}`).digest('hex').slice(0, 32)
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

        // ---- 1. bring the original over (skip if a warm /tmp copy matches) ----
        const have = fs.existsSync(src) && (!declaredSize || fs.statSync(src).size === declaredSize)
        if (!have) {
          send({ stage: 'download', pct: 0, text: 'بننزّل الفيديو من السحابة…' })
          const url = await resolveGofileDownload({ ...f, name })
          const abort = AbortSignal.any([req.signal, AbortSignal.timeout(DEADLINE_MS)])
          const got = await downloadToFile(url, src, {
            maxBytes,
            signal: abort,
            onProgress: (gotBytes, total) => {
              const pct = total ? Math.min(99, Math.round((gotBytes / total) * 100)) : 0
              send({ stage: 'download', pct, text: 'بننزّل الفيديو من السحابة…' })
            },
          })
          if (got < 1000) throw new Error('الملف اللي اتنزّل من السحابة فاضي أو بايظ')
        }

        // ---- 2. job.json for the runner ----
        const size = fs.statSync(src).size
        fs.writeFileSync(jobFile, JSON.stringify({
          id: jobId, name, size, ext, phase: 'uploaded', uploaded: size, createdAt: Date.now(),
        }))

        // ---- 3. run the exact same proven pipeline (scan + plan + cut + mirror) ----
        send({ stage: 'cut', pct: 1, text: 'بنجهّز المعالجة…' })
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          QATTAAS_JOBS_ROOT: CLOUD_ROOT,
          FFMPEG_PATH: bins.ffmpeg,
          FFPROBE_PATH: bins.ffprobe,
          QATTAAS_CLOUD: '1',
          ...(f.guestToken ? { GOFILE_TOKEN: f.guestToken } : {}),
          ...(f.parentFolder ? { GOFILE_FOLDER_ID: f.parentFolder } : {}),
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
            send({
              stage: 'done',
              result: {
                original: f.downloadPage || null,
                resultUrl: job.gofile?.url || job.bunny?.url || null,
                bunny: job.bunny || null,
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
