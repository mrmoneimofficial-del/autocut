/**
 * قصّاص — signed, expiring storage tokens (adapted from the مستر منعم
 * lesson-auth.ts stream-token model).
 *
 * The reference platform binds tokens to (student, lesson, asset) rows in
 * Prisma. قصّاص is a public tool with no database, so the token instead
 * carries the Bunny remote path itself, HMAC-signed by the server — a valid
 * token is the ONLY way to stream or re-cut a file, and real storage paths
 * never leak into URLs.
 *
 *   signPathToken("uploads/abc/original.mp4", ttl) → base64url blob
 *   verifyPathToken(token)                          → { path, exp } | null
 *
 * Stream links live ~7 days so a done-screen restored from localStorage
 * keeps working; the server re-mints fresh ones any time it needs to.
 */
import crypto from 'node:crypto'

/** link lifetime — long enough for localStorage restore, short enough to expire */
export const TOKEN_TTL_MS = Number(process.env.QATTAAS_TOKEN_TTL_MS || 7 * 24 * 3600 * 1000)
const SECRET = process.env.ADMIN_SESSION_SECRET
  || process.env.QATTAAS_SECRET
  || 'fallback-dev-secret-change-me'

function sign(payload: string): string {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
}

/** Only `uploads/<session-token>/<safe-file>` shapes are ever signable. */
export function validRemotePath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length > 300) return false
  return /^uploads\/[A-Za-z0-9_-]{6,64}\/[A-Za-z0-9._-]{1,150}$/.test(p)
}

/** Create a signed token bound to one Bunny remote path.
 *  Format (base64url): remotePath|exp|signature — `|` never appears in a
 *  valid remote path, so the 3 parts split unambiguously (unlike `.` which
 *  filenames contain). */
export function signPathToken(remotePath: string, ttlMs = TOKEN_TTL_MS): string {
  const exp = Date.now() + ttlMs
  const payload = `${remotePath}|${exp}`
  const sig = sign(payload)
  return Buffer.from(`${payload}|${sig}`).toString('base64url')
}

/** Verify a storage token. Returns the bound path if valid + not expired. */
export function verifyPathToken(token: string | null | undefined): { path: string; exp: number } | null {
  if (!token || token.length > 1200) return null
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8')
    const parts = decoded.split('|')
    if (parts.length !== 3) return null
    const [remotePath, expStr, givenSig] = parts
    if (!validRemotePath(remotePath)) return null
    const exp = Number(expStr)
    if (!Number.isFinite(exp) || exp < Date.now()) return null
    const payload = `${remotePath}|${exp}`
    const expectedSig = sign(payload)
    if (givenSig.length !== expectedSig.length) return null
    if (!crypto.timingSafeEqual(Buffer.from(givenSig), Buffer.from(expectedSig))) return null
    return { path: remotePath, exp }
  } catch {
    return null
  }
}
