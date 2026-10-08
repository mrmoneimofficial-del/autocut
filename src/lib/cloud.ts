import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

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
 *
 * GoFile's current anti-abuse model (verified against the v1.8.3 gofile-dl,
 * Sep 2026): the old static website token is a decoy — the real
 * X-Website-Token is sha256(UA::lang::accountToken::window4h::salt) computed
 * per request, and /contents needs Bearer + that token + browser-like
 * headers. Store downloads need the accountToken cookie + Referer.
 * NOTE: gofile's API edge resets connections from many datacenter IPs.
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

/** browser identity the wt hash and the request headers must agree on */
const GF_UA = process.env.GOFILE_USER_AGENT
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const GF_LANG = process.env.GOFILE_LANGUAGE || 'en-US'
const GF_SALT = process.env.GOFILE_WT_SALT || '12af056dacea0b'
const WT_WINDOW_SEC = 14400 // 4-hour rotating window

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

/** X-Website-Token = sha256(UA::lang::accountToken::window4h::salt) */
function websiteToken(accountToken: string, windowOffset = 0): string {
  const win = Math.floor(Date.now() / 1000 / WT_WINDOW_SEC) + windowOffset
  const raw = `${GF_UA}::${GF_LANG}::${accountToken}::${win}::${GF_SALT}`
  return crypto.createHash('sha256').update(raw).digest('hex')
}

/** server-side guest account (cached 1h) — listing public content needs one */
let accountCache: { token: string; at: number } | null = null
export async function gofileGuestAccount(): Promise<string> {
  if (accountCache && Date.now() - accountCache.at < 3600_000) return accountCache.token
  const r = await fetch(`${GOFILE_API}/accounts`, {
    method: 'POST',
    headers: { 'User-Agent': GF_UA, Origin: 'https://gofile.io' },
    signal: AbortSignal.timeout(15_000),
  })
  const j = await r.json().catch(() => null)
  if (!r.ok || j?.status !== 'ok' || !j?.data?.token) {
    throw new Error(`تعذر إنشاء حساب GoFile مؤقت (${j?.status || r.status})`)
  }
  accountCache = { token: String(j.data.token), at: Date.now() }
  return accountCache.token
}

/** GET /contents/{id} with the full current header set (retries the previous
 *  4h window near bucket boundaries). Returns the `data` payload. */
async function gofileContent(id: string, accountToken: string): Promise<Record<string, any>> {
  let lastErr = 'unknown'
  for (const offset of [0, -1]) {
    try {
      const r = await fetch(
        `${GOFILE_API}/contents/${encodeURIComponent(id)}?contentFilter=&page=1&pageSize=1000&sortField=createTime&sortDirection=-1`,
        {
          headers: {
            Authorization: `Bearer ${accountToken}`,
            'X-Website-Token': websiteToken(accountToken, offset),
            'X-BL': GF_LANG,
            'User-Agent': GF_UA,
            Accept: '*/*',
            Origin: 'https://gofile.io',
            Referer: 'https://gofile.io/',
          },
          signal: AbortSignal.timeout(20_000),
        },
      )
      const j = await r.json().catch(() => null)
      if (j?.status === 'ok' && j.data) return j.data
      lastErr = String(j?.status || r.status)
      // error-token → wrong window → try the other offset; other errors → keep trying too
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }
  throw new Error(`GoFile رفض قراءة بيانات الملف (${lastErr})`)
}

/** classic web-download URL: https://{server}.gofile.io/download/web/{fileId}/{name} */
export function gofileWebDownloadUrl(f: GoFileRef): string {
  const base = (process.env.GOFILE_STORE_BASE || `https://${f.server || 'store-1'}.gofile.io`).replace(/\/+$/, '')
  return `${base}/download/web/${encodeURIComponent(f.id)}/${encodeURIComponent(f.name)}`
}

export type GoFileDownload = { url: string; headers: Record<string, string>; via: 'server-account-link' | 'browser-token-link' | 'web-url' }

/**
 * Resolve a working download URL (+ the headers it needs). Order:
 *   1. our guest account + computed X-Website-Token → data.link (the current
 *      official guest path, verified against gofile-dl v1.8.3)
 *   2. the browser's guest token via the same listing (fallback)
 *   3. the classic web-download URL (with account cookie)
 */
export async function resolveGofileDownload(f: GoFileRef): Promise<GoFileDownload> {
  // 1. our own server-side guest account
  try {
    const token = await gofileGuestAccount()
    const data = await gofileContent(f.id, token)
    const link = typeof data.link === 'string' ? data.link : null
    if (link) {
      const safe = safeGofileUrl(link)
      if (safe) {
        return { url: safe, headers: { Cookie: `accountToken=${token}`, 'User-Agent': GF_UA, Referer: 'https://gofile.io/' }, via: 'server-account-link' }
      }
    }
  } catch { /* fall through */ }

  // 2. the browser's guest token
  if (f.guestToken) {
    try {
      const data = await gofileContent(f.id, f.guestToken)
      const link = typeof data.link === 'string' ? data.link : null
      if (link) {
        const safe = safeGofileUrl(link)
        if (safe) {
          return { url: safe, headers: { Cookie: `accountToken=${f.guestToken}`, 'User-Agent': GF_UA, Referer: 'https://gofile.io/' }, via: 'browser-token-link' }
        }
      }
    } catch { /* fall through */ }
  }

  // 3. classic web URL + whichever account token we have
  const web = safeGofileUrl(gofileWebDownloadUrl(f))
  if (!web) throw new Error('رابط التنزيل من GoFile غير صالح')
  let cookieToken = f.guestToken || ''
  if (!cookieToken) {
    try { cookieToken = await gofileGuestAccount() } catch { /* anonymous attempt */ }
  }
  return {
    url: web,
    via: 'web-url',
    headers: {
      ...(cookieToken ? { Cookie: `accountToken=${cookieToken}` } : {}),
      'User-Agent': GF_UA,
      Referer: 'https://gofile.io/',
    },
  }
}

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
