import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

/**
 * قصّاص — أدوات وضع السحابة (Cloud Mode)
 *
 * Uploads reach Bunny Storage through the مستر منعم chunked upload system
 * (/api/uploads/chunked/*), so the cloud cut only has to:
 *   1. bring the original over (warm /tmp copy first, else download from
 *      Bunny Storage — the signed token in the request authorizes the path)
 *   2. run the exact same proven pipeline (scripts/pipeline-runner.mjs),
 *      which mirrors the result back into the SAME session folder on Bunny
 *   3. progress streams to the browser as NDJSON inside one request
 */

/* ----------------------------------------------------- binary resolution */

let binsCache: { ffmpeg: string; ffprobe: string; ok: boolean } | null = null

/**
 * Resolve ffmpeg/ffprobe binaries. Priority:
 *   1. FFMPEG_PATH / FFPROBE_PATH env (explicit override)
 *   2. ffmpeg-static / ffprobe-static packages (bundled via
 *      outputFileTracingIncludes — this is the Vercel path)
 *   3. system PATH fallback (sandbox / Colab / Codespaces)
 */
export function resolveBins(): { ffmpeg: string; ffprobe: string; ok: boolean } {
  if (binsCache) return binsCache
  const req = createRequire(path.join(process.cwd(), 'noop.js'))

  let ffmpeg = process.env.FFMPEG_PATH || ''
  if (!ffmpeg) {
    try {
      const p = req('ffmpeg-static')
      if (typeof p === 'string' && fs.existsSync(p)) ffmpeg = p
    } catch { /* not installed */ }
  }
  let ffprobe = process.env.FFPROBE_PATH || ''
  if (!ffprobe) {
    try {
      const p = req('ffprobe-static')
      if (p?.path && fs.existsSync(p.path)) ffprobe = p.path
    } catch { /* not installed */ }
  }
  if (!ffmpeg) ffmpeg = 'ffmpeg'
  if (!ffprobe) ffprobe = 'ffprobe'

  // a "bare" name only works if it's actually on PATH — verify once and cache
  const ok = (() => {
    try {
      const f = spawnSync(ffmpeg, ['-version'], { timeout: 10_000 })
      const p = spawnSync(ffprobe, ['-version'], { timeout: 10_000 })
      return f.status === 0 && p.status === 0
    } catch { return false }
  })()

  binsCache = { ffmpeg, ffprobe, ok }
  return binsCache
}

/* --------------------------------------------------- download + runner path */

/** stream a URL to disk with a hard size cap + progress callbacks */
export async function downloadToFile(
  url: string,
  dest: string,
  opts: {
    maxBytes: number
    signal?: AbortSignal
    headers?: Record<string, string>
    onProgress?: (got: number, total: number | null) => void
  },
): Promise<number> {
  const res = await fetch(url, { redirect: 'follow', signal: opts.signal, headers: opts.headers || {} })
  if (!res.ok || !res.body) throw new Error(`تنزيل الفيديو من السحابة فشل (${res.status})`)
  const len = res.headers.get('content-length')
  const total = len ? Number(len) : null
  if (total && total > opts.maxBytes) {
    throw new Error('الملف أكبر من الحد المسموح في المسار السحابي — استخدم نسخة كاملة (Colab / Codespaces)')
  }
  const fh = await fs.promises.open(dest, 'w')
  let got = 0
  let lastTick = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (opts.signal?.aborted) throw new Error('اتلغى')
      got += chunk.length
      if (got > opts.maxBytes) {
        throw new Error('الملف أكبر من الحد المسموح في المسار السحابي — استخدم نسخة كاملة (Colab / Codespaces)')
      }
      await fh.write(chunk)
      if (opts.onProgress && (got - lastTick > 1_500_000 || got === total)) {
        lastTick = got
        opts.onProgress(got, total)
      }
    }
  } finally {
    await fh.close().catch(() => { /* already closed */ })
  }
  return got
}

/** locate pipeline-runner.mjs across dev / standalone / serverless layouts */
export function resolveRunnerPath(): string | null {
  const cands = [
    path.join(process.cwd(), 'scripts', 'pipeline-runner.mjs'),
    path.join(process.cwd(), '..', 'scripts', 'pipeline-runner.mjs'),
    path.join(process.cwd(), '..', '..', 'scripts', 'pipeline-runner.mjs'),
  ]
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c } catch { /* next */ }
  }
  return null
}
