import { verifyPathToken } from '@/lib/storage-auth'
import { bunnyStream, mimeFromExt } from '@/lib/bunny-storage'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/uploads/stream?t=<signed-token>[&dl=1]
 *
 * Signed-token delivery for everything in Bunny Storage (originals + results),
 * ported from the مستر منعم stream route: verify the HMAC token → stream from
 * Bunny with Range support (seek works) → force the right content type.
 * قصّاص flips the reference's protection model: ?dl=1 sets an attachment
 * disposition (the user WANTS to download their cut), the default is inline
 * (in-browser preview).
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const token = url.searchParams.get('t')
  const claims = verifyPathToken(token)
  if (!claims) {
    return new Response('الرابط ده انتهى أو مش صالح — قصّ الفيديو تاني عشان تاخد لينك جديد', {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  const upstream = await bunnyStream(claims.path, req.headers.get('range'))
  if (upstream.status === 404) {
    return new Response('الملف مش موجود على التخزين', { status: 404 })
  }

  const headers = new Headers(upstream.headers)
  // sane content type (Bunny sometimes answers octet-stream)
  const ct = headers.get('content-type')
  if (!ct || ct === 'application/octet-stream') {
    headers.set('Content-Type', mimeFromExt(claims.path))
  }
  if (url.searchParams.get('dl') === '1') {
    const base = claims.path.split('/').pop() || 'qattaas.mp4'
    const nice = base.startsWith('result-')
      ? `قصّاص-${base.replace(/^result-/, '').replace(/\.mp4$/i, '')}.mp4`
      : 'قصّاص-الفيديو-الأصلي.mp4'
    headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(nice)}`)
  } else {
    headers.set('Content-Disposition', 'inline')
  }
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Accept-Ranges', 'bytes')

  return new Response(upstream.body, { status: upstream.status, headers })
}
