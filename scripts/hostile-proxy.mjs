#!/usr/bin/env node
/**
 * hostile-proxy — a test double for the sandbox preview gateway.
 *
 * WHY: the real preview layer in front of the app (browser → Z.ai gateway →
 * Caddy :81 → Next :3000) KILLS upload requests it considers too big/slow —
 * the user's 4MB chunk POSTs never once reached the app ("the bar reaches
 * ~20% then restarts"). The exact external limit can't be probed from inside
 * the sandbox, so this proxy reproduces the failure classes locally to prove
 * the adaptive-chunk uploader survives them:
 *
 *   CAP_BYTES=1048576   → any request body over 1MB gets its connection
 *                         destroyed (emulates a body-size cap)
 *   THROTTLE_BPS=102400 → the body is relayed at 100KB/s (emulates a slow
 *                         uplink; combined with KILL_AFTER_MS it reproduces
 *                         duration-based kills)
 *   KILL_AFTER_MS=30000 → any request still in flight after 30s is destroyed
 *
 * Usage:
 *   CAP_BYTES=1048576 node scripts/hostile-proxy.mjs        # :3050 → :3000
 *   THROTTLE_BPS=102400 KILL_AFTER_MS=30000 node scripts/hostile-proxy.mjs
 */
import http from 'node:http'

const PORT = Number(process.env.PORT || 3050)
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || '127.0.0.1'
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT || 3000)
const CAP_BYTES = Number(process.env.CAP_BYTES || 0)          // 0 = off
const THROTTLE_BPS = Number(process.env.THROTTLE_BPS || 0)    // 0 = off
const KILL_AFTER_MS = Number(process.env.KILL_AFTER_MS || 0)  // 0 = off

const server = http.createServer((req, res) => {
  const contentLength = Number(req.headers['content-length'] || 0)

  // socket errors after we destroy a connection must never crash the proxy
  req.on('error', () => {})
  res.on('error', () => {})

  // Mode A — body-size cap: destroy the connection outright (the browser sees
  // a network error, status 0 — exactly like the real preview layer).
  if (CAP_BYTES > 0 && contentLength > CAP_BYTES) {
    console.log(`[hostile] KILL size=${contentLength} > cap=${CAP_BYTES} ${req.method} ${req.url}`)
    // let the client start sending, then cut the connection mid-body
    let seen = 0
    let dead = false
    const kill = () => {
      if (dead) return
      dead = true
      try { req.destroy() } catch { /* already gone */ }
      try { res.destroy() } catch { /* already gone */ }
    }
    req.on('data', (c) => {
      seen += c.length
      if (seen > CAP_BYTES) kill()
    })
    req.on('end', kill) // body fully swallowed without a reply → still dead
    setTimeout(kill, 1500)
    return
  }

  // Relay to upstream with optional throttle + duration kill.
  const started = Date.now()
  const upstream = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` },
    },
    (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers)
      ur.pipe(res)
    },
  )
  upstream.on('error', () => { try { res.destroy() } catch { /* gone */ } })

  let bytes = 0
  let killed = false
  const maybeKill = () => {
    if (killed) return
    if (KILL_AFTER_MS > 0 && Date.now() - started > KILL_AFTER_MS) {
      killed = true
      console.log(`[hostile] KILL duration>${KILL_AFTER_MS}ms ${req.method} ${req.url}`)
      req.destroy()
      upstream.destroy()
      res.destroy()
    }
  }
  if (KILL_AFTER_MS > 0) {
    const timer = setInterval(maybeKill, 500)
    upstream.on('close', () => clearInterval(timer))
    res.on('close', () => clearInterval(timer))
  }

  if (THROTTLE_BPS > 0 && contentLength > 0) {
    // relay the body at THROTTLE_BPS with 8KB slices
    const CHUNK = 8 * 1024
    const interval = (CHUNK / THROTTLE_BPS) * 1000
    req.pause()
    const pump = () => {
      if (killed) return
      maybeKill()
      const c = req.read(CHUNK)
      if (c) {
        bytes += c.length
        upstream.write(c)
        if (bytes < contentLength) setTimeout(pump, interval)
        else upstream.end()
      } else {
        // no data buffered yet — wait for readability
        req.once('readable', pump)
      }
    }
    req.on('readable', pump)
    pump()
  } else {
    req.pipe(upstream)
  }
})

server.on('clientError', (err, socket) => {
  try { socket.destroy() } catch { /* gone */ }
})

server.listen(PORT, () => {
  console.log(
    `[hostile] listening on :${PORT} → ${UPSTREAM_HOST}:${UPSTREAM_PORT}` +
    ` (CAP_BYTES=${CAP_BYTES || 'off'}, THROTTLE_BPS=${THROTTLE_BPS || 'off'}, KILL_AFTER_MS=${KILL_AFTER_MS || 'off'})`,
  )
})
