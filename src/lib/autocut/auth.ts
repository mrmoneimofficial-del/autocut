import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { STORAGE_ROOT } from './paths'

/**
 * Authorization model:
 *  - Each browser session generates an owner token (uuid) kept in
 *    localStorage; every job is bound to it. API requests carry it in the
 *    `x-owner-token` header.
 *  - The <video> element cannot send custom headers, so media endpoints
 *    accept short-lived HMAC-signed URLs issued to the owner (requirement 28).
 * Raw storage paths are never exposed — media flows through the API.
 */

let cachedSecret: string | null = null

export function getSecret(): string {
  if (cachedSecret) return cachedSecret
  const env = process.env.AUTOCUT_SECRET
  if (env && env.length >= 16) {
    cachedSecret = env
    return cachedSecret
  }
  const file = path.join(STORAGE_ROOT, '.auth-secret')
  fs.mkdirSync(STORAGE_ROOT, { recursive: true })
  if (fs.existsSync(file)) {
    cachedSecret = fs.readFileSync(file, 'utf8').trim()
    if (cachedSecret.length >= 16) return cachedSecret
  }
  cachedSecret = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(file, cachedSecret, { mode: 0o600 })
  return cachedSecret
}

export function hmac(payload: string): string {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('hex')
}

/** Signed, expiring media URL for the <video> element (and thumbnail <img>). */
export function signMediaUrl(jobId: string, kind: 'stream' | 'output' | 'thumbs', ttlMs = 12 * 3600 * 1000): string {
  const exp = Date.now() + ttlMs
  const sig = hmac(`${jobId}:${kind}:${exp}`)
  return `/api/autocut/jobs/${jobId}/${kind}?exp=${exp}&sig=${sig}`
}

export function verifyMediaSignature(jobId: string, kind: 'stream' | 'output' | 'thumbs', exp: unknown, sig: unknown): boolean {
  if (typeof exp !== 'number' || typeof sig !== 'string') return false
  if (!Number.isFinite(exp) || exp < Date.now() || exp > Date.now() + 48 * 3600 * 1000) return false
  const expected = hmac(`${jobId}:${kind}:${exp}`)
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function newToken(): string {
  return crypto.randomUUID()
}

export function newJobId(): string {
  return crypto.randomUUID()
}

/** Extract owner token from a request (header or query fallback for fetch-less contexts). */
export function ownerTokenFrom(req: Request): string | null {
  const h = req.headers.get('x-owner-token')
  if (h && h.length >= 8) return h
  const url = new URL(req.url)
  const q = url.searchParams.get('token')
  if (q && q.length >= 8) return q
  return null
}
