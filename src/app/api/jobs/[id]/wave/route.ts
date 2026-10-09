import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { resolveBins } from '@/lib/cloud'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const ROOT = path.join(process.cwd(), 'storage', 'jobs')
const HZ = 50          // one envelope sample per 20ms
const WIN = 160        // 8kHz × 20ms

type Ctx = { params: Promise<{ id: string }> }

/** in-flight guard — one extraction per job even under parallel polls */
const inflight = new Map<string, Promise<Response>>()

/**
 * GET /api/jobs/:id/wave — audio amplitude envelope for the workbench
 * waveform + instant client-side silence detection.
 *
 * Extracted ONCE per job (mono 8kHz PCM → RMS per 20ms window → dB, uint8
 * quantized as -dB 0..90), cached as wave.json in the job dir. A one-hour
 * video compresses to ~180KB — every later slider change is pure math in
 * the browser, zero server round-trips.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  if (!/^[a-f0-9]{32}$/.test(id)) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })

  const existing = inflight.get(id)
  if (existing) return existing

  const p = (async () => {
    const dir = path.join(ROOT, id)
    const jobFile = path.join(dir, 'job.json')
    let job: Record<string, any> | null = null
    try { job = JSON.parse(fs.readFileSync(jobFile, 'utf8')) } catch { /* missing */ }
    if (!job) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })

    // cached?
    const cacheFile = path.join(dir, 'wave.json')
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (cached && cached.hz === HZ && typeof cached.db === 'string' && cached.db.length > 8) {
        return Response.json(cached)
      }
    } catch { /* no cache yet */ }

    const src = path.join(dir, 'original' + job.ext)
    if (!fs.existsSync(src)) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })

    const bins = resolveBins()
    if (!bins.ok) return Response.json({ error: 'NO_FFMPEG' }, { status: 500 })

    const pcm = await decodeMono8k(bins.ffmpeg, src)

    // RMS per 20ms → dB (0..-90) → uint8 (-dB)
    const n = Math.floor(pcm.length / 2 / WIN)
    const dbBytes = new Uint8Array(n)
    const dbFloat = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let acc = 0
      const base = i * WIN
      for (let j = 0; j < WIN; j++) {
        const v = pcm.readInt16LE((base + j) * 2) / 32768
        acc += v * v
      }
      const rms = Math.sqrt(acc / WIN)
      let db = rms > 1e-7 ? 20 * Math.log10(rms) : -90
      if (db < -90) db = -90
      if (db > 0) db = 0
      dbFloat[i] = db
      dbBytes[i] = Math.round(-db)
    }

    // percentiles → power the smart threshold suggestions
    const sorted = Float32Array.from(dbFloat).sort()
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : -90)
    const r1 = (v: number) => Math.round(v * 10) / 10
    const stats = {
      p5: r1(pct(0.05)), p10: r1(pct(0.10)), p25: r1(pct(0.25)), p50: r1(pct(0.50)),
      p75: r1(pct(0.75)), p90: r1(pct(0.90)), p95: r1(pct(0.95)),
    }

    const payload = {
      hz: HZ,
      n,
      durMs: Math.round((n / HZ) * 1000),
      db: Buffer.from(dbBytes.buffer, dbBytes.byteOffset, dbBytes.byteLength).toString('base64'),
      stats,
    }
    try { fs.writeFileSync(cacheFile + '.tmp', JSON.stringify(payload)); fs.renameSync(cacheFile + '.tmp', cacheFile) } catch { /* non-fatal */ }
    return Response.json(payload)
  })()

  inflight.set(id, p)
  try {
    return await p
  } finally {
    inflight.delete(id)
  }
}

/** decode the audio track to mono 8kHz s16le PCM (fast — audio-only, ~100× realtime) */
function decodeMono8k(ffmpeg: string, src: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-i', src, '-vn', '-ac', '1', '-ar', '8000',
      '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let err = ''
    p.stdout.on('data', (d: Buffer) => chunks.push(d))
    p.stderr.on('data', (d: Buffer) => { if (err.length < 8000) err += d.toString() })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`ffmpeg envelope decode exit ${code}: ${err.slice(-400)}`))
    })
  })
}
