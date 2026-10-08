import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

/**
 * قصّاص — أدوات وضع السحابة (Cloud Mode)
 *
 * On serverless hosts (Vercel…) the classic flow is impossible: read-only FS,
 * 4.5MB request-body cap, no shared /tmp. Cloud mode flips the architecture:
 *   1. the BROWSER uploads the video directly to GoFile's upload fleet
 *      (CORS-enabled per GoFile API docs) — the host never sees the bytes
 *   2. this server downloads the original from GoFile into ephemeral /tmp,
 *      runs the exact same proven pipeline (scripts/pipeline-runner.mjs),
 *      and mirrors the result back to the SAME guest folder on GoFile
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

/* -------------------------------------------------------- gofile helpers */

export const GOFILE_API = (process.env.GOFILE_API || 'https://api.gofile.io').replace(/\/+$/, '')
export const GOFILE_UPLOAD = (
  process.env.GOFILE_UPLOAD_BASE || 'https://upload.gofile.io/uploadfile'
).replace(/\/+$/, '')

/** everything the browser captured from its direct GoFile upload */
export type GoFileRef = {
  id: string
  name: string
  size?: number
  server?: string
  guestToken?: string
  parentFolder?: string
  downloadPage?: string
}

/** the URL must point at gofile (or localhost — self-test mock) before we fetch it */
function safeGofileUrl(u: string): string | null {
  try {
    const url = new URL(u)
    const gofile = url.protocol === 'https:' && /^([a-z0-9-]+\.)?gofile\.io$/i.test(url.hostname)
    const local = url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(url.hostname)
    if (gofile || local) return u
  } catch { /* invalid */ }
  return null
}

/** classic web-download URL: https://{server}.gofile.io/download/web/{fileId}/{name} */
export function gofileWebDownloadUrl(f: GoFileRef): string {
  const base = (process.env.GOFILE_STORE_BASE || `https://${f.server || 'store-1'}.gofile.io`).replace(/\/+$/, '')
  return `${base}/download/web/${encodeURIComponent(f.id)}/${encodeURIComponent(f.name)}`
}

/**
 * Resolve a working download URL for the ORIGINAL. Tries, in order:
 *   1. owner metadata via the guest token (premium/mock path → pre-authorized `link`)
 *   2. the web-download URL (what gofile.io's own download buttons use)
 */
export async function resolveGofileDownload(f: GoFileRef): Promise<string> {
  if (f.guestToken) {
    try {
      const r = await fetch(`${GOFILE_API}/contents/${encodeURIComponent(f.id)}`, {
        headers: { Authorization: `Bearer ${f.guestToken}` },
        signal: AbortSignal.timeout(20_000),
      })
      const j = await r.json().catch(() => null)
      const link = j && j.status === 'ok' && j.data && typeof j.data.link === 'string' ? j.data.link : null
      if (link) {
        const safe = safeGofileUrl(link)
        if (safe) return safe
      }
    } catch { /* fall through to the web URL */ }
  }
  const web = safeGofileUrl(gofileWebDownloadUrl(f))
  if (!web) throw new Error('رابط التنزيل من GoFile غير صالح')
  return web
}

/** stream a URL to disk with a hard size cap + progress callbacks */
export async function downloadToFile(
  url: string,
  dest: string,
  opts: { maxBytes: number; signal?: AbortSignal; onProgress?: (got: number, total: number | null) => void },
): Promise<number> {
  const res = await fetch(url, { redirect: 'follow', signal: opts.signal })
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
