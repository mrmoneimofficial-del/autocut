#!/usr/bin/env bun
/**
 * قصّاص — محرك قص الصمت السريع
 * Fast silence-removal pipeline (the proven approach):
 *   1. silencedetect scan (audio-only decode, ~400x realtime)
 *   2. frame-grid cut plan (keep `gap` of every silence > gap)
 *   3. audio: decode | byte-slice | AAC encode  (streaming, sample-accurate)
 *   4. video: N chunks × select-filter + libx264 ultrafast (2 lanes on 2 cores)
 *   5. concat + mux (+faststart) + verify
 * All ffmpeg calls use -nostdin. Run detached; progress in progress.json.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// QATTAAS_JOBS_ROOT — cloud mode (api/cloud/cut) points the runner at an
// ephemeral /tmp job dir instead of the persistent ./storage/jobs tree.
const ROOT = process.env.QATTAAS_JOBS_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'jobs')

// FFMPEG_PATH / FFPROBE_PATH — serverless hosts (Vercel…) have no system
// ffmpeg; the API route resolves ffmpeg-static/ffprobe-static and passes the
// absolute binary paths here.
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe'

const AR = {
  scanning: 'نمسح الصمت ونحدد الفجوات…',
  audio: 'نجهّز الصوت (قص عالي الدقة)…',
  video: (i, n) => `نرمّز الفيديو — الجزء ${i} من ${n}…`,
  muxing: 'نجمّع الملف النهائي…',
  verifying: 'نتأكد من الملف النهائي…',
  cleanup: 'ننظف الملفات المؤقتة…',
  mirroring: 'نحفظ نسخة خارجية من النتيجة…',
  done: 'خلصنا! 🎉',
}

function die(msg) { console.error('[runner] FATAL:', msg); process.exit(1) }

const [jobId, action, settingsArg] = process.argv.slice(2)
if (!jobId || !jobId.match(/^[a-f0-9]{32}$/) || !['analyze', 'render'].includes(action)) {
  die('usage: runner <jobId> <analyze|render> [settingsJson]')
}
const dir = path.join(ROOT, jobId)
const jobFile = path.join(dir, 'job.json')
const progFile = path.join(dir, 'progress.json')
const planFile = path.join(dir, 'plan.json')
const logFile = path.join(dir, 'run.log')

const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'))
const src = path.join(dir, 'original' + job.ext)

if (!fs.existsSync(src)) die('source file missing')

const log = fs.openSync(logFile, 'a')
const logStd = (s) => fs.writeSync(log, s + '\n')
const t0 = Date.now()
logStd(`\n=== ${action} ${new Date().toISOString()} ===`)

function writeJSON(file, obj) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj))
  fs.renameSync(tmp, file)
}
function setPhase(phase, extra = {}) {
  job.phase = phase
  Object.assign(job, extra) // keep memory & disk in sync — later writes must not lose earlier extras
  writeJSON(jobFile, job)
}
function progress(p) {
  writeJSON(progFile, { ...p, at: Date.now(), elapsedMs: Date.now() - t0 })
}

/** run ffmpeg, capture stderr, resolve on exit 0 */
function ff(args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-nostdin', '-y', '-hide_banner', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    p.stderr.on('data', (d) => {
      const s = d.toString()
      if (onStderr) onStderr(s)
      if (err.length < 400000) err += s
    })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}\n${err.slice(-3000)}`))))
  })
}

function probe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe failed'))
      try { resolve(JSON.parse(out)) } catch (e) { reject(e) }
    })
    p.on('error', reject)
  })
}

// ---------------------------------------------------------------- scan + plan
async function scanAndPlan(settings) {
  const { gapMs, thresholdDb } = settings
  const info = await probe(src)
  const v = info.streams.find((s) => s.codec_type === 'video')
  const a = info.streams.find((s) => s.codec_type === 'audio')
  if (!a) throw new Error('NO_AUDIO')
  const [num, den] = v.r_frame_rate.split('/').map(Number)
  const fps = num / (den || 1)
  const duration = parseFloat(info.format.duration)
  const sr = parseInt(a.sample_rate, 10)
  const ch = a.channels
  const totalFrames = Math.max(1, Math.round(duration * fps))

  const meta = {
    durationMs: Math.round(duration * 1000),
    fps: Math.round(fps * 1000) / 1000,
    width: v.width, height: v.height,
    vcodec: v.codec_name, acodec: a.codec_name,
    sr, ch, size: parseInt(info.format.size, 10),
  }

  // -- silencedetect (audio-only, min duration = gap) --
  let stderr = ''
  await ff(['-i', src, '-vn', '-af', `silencedetect=noise=${thresholdDb}dB:d=${gapMs / 1000}`, '-f', 'null', '-'], {
    onStderr: (s) => { stderr += s },
  })
  const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => parseFloat(m[1]))
  const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => parseFloat(m[1]))

  // pair in order; trailing unpaired start runs to EOF
  const pairs = []
  let ei = 0
  for (const s of starts) {
    while (ei < ends.length && ends[ei] < s - 0.05) ei++
    if (ei < ends.length) { pairs.push([s, ends[ei]]); ei++ }
    else pairs.push([s, duration])
  }

  // -- frame-grid plan: keep `gap` of every silence longer than gap --
  const keepSec = gapMs / 1000
  const [tbNum, tbDen] = (v.time_base || '1/90000').split('/').map(Number)
  const [fpsNum, fpsDen] = [num, den]
  // ticks per frame in the source timebase (integer for all sane files)
  const ticksPerFrame = Math.round((tbDen * fpsDen) / (tbNum * fpsNum))
  const windows = []   // [fa, fb) frame indices kept
  const cuts = []      // [ms, ms] removed spans (original timeline, for preview)
  let cur = 0
  let savedMs = 0
  for (const [s, e] of pairs) {
    if (e - s <= keepSec + 0.0005) continue
    const keepEndF = Math.floor((s + keepSec) * fps)
    const resumeF = Math.ceil(e * fps)
    if (keepEndF - cur > 1) windows.push([cur, keepEndF])
    cuts.push([Math.round((s + keepSec) * 1000), Math.round(e * 1000)])
    savedMs += (resumeF - keepEndF) * 1000 / fps
    cur = Math.max(cur, resumeF)
  }
  if (totalFrames - cur > 1) windows.push([cur, totalFrames])

  const keptFrames = windows.reduce((n, [a2, b2]) => n + (b2 - a2), 0)
  const plan = {
    settings, fps, sr, ch, totalFrames, tbNum, tbDen, ticksPerFrame,
    fpsNum, fpsDen,
    ticksInt: Math.abs((tbDen * fpsDen) / (tbNum * fpsNum) - ticksPerFrame) < 1e-9,
    durationMs: meta.durationMs,
    keptMs: Math.round(keptFrames * 1000 / fps),
    savedMs: Math.round(savedMs),
    cutsCount: cuts.length,
    cuts, windows,
  }
  writeJSON(planFile, plan)
  setPhase('ready', { meta, plan: {
    settings, durationMs: meta.durationMs, keptMs: plan.keptMs, savedMs: plan.savedMs,
    cutsCount: cuts.length, cuts,
  } })
  return { plan, meta }
}

async function getPlan(settings) {
  if (fs.existsSync(planFile)) {
    const p = JSON.parse(fs.readFileSync(planFile, 'utf8'))
    if (p.settings.gapMs === settings.gapMs && p.settings.thresholdDb === settings.thresholdDb) {
      // refresh the plan summary in job.json WITHOUT touching the current phase
      const j = JSON.parse(fs.readFileSync(jobFile, 'utf8'))
      j.plan = {
        settings, durationMs: p.durationMs, keptMs: p.keptMs, savedMs: p.savedMs,
        cutsCount: p.cutsCount, cuts: p.cuts,
      }
      writeJSON(jobFile, j)
      return { plan: p, meta: j.meta }
    }
  }
  return scanAndPlan(settings)
}

// ---------------------------------------------------------------- audio
/** Stream: decode PCM | slice keep-ranges | AAC encode. Sample-accurate, zero temp. */
async function buildAudio(plan, onByte) {
  const { windows, fps, sr, ch } = plan
  const frameSize = ch * 2
  // byte ranges in the decoded PCM stream
  const ranges = windows.map(([fa, fb]) => [
    Math.round((fa * sr) / fps) * frameSize,
    Math.round((fb * sr) / fps) * frameSize,
  ])
  const totalOut = ranges.reduce((n, [a2, b2]) => n + (b2 - a2), 0)
  onByte(0, totalOut) // initial tick so callers learn the target size immediately

  const dec = spawn(FFMPEG, ['-nostdin', '-hide_banner', '-i', src, '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] })
  const enc = spawn(FFMPEG, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(sr), '-ac', String(ch), '-i', 'pipe:0', '-c:a', 'aac', '-b:a', '96k', path.join(dir, 'audio.m4a')], { stdio: ['pipe', 'ignore', 'pipe'] })

  let encErr = ''
  enc.stderr.on('data', (d) => (encErr += d.toString()))

  let pos = 0        // absolute byte position in decoded stream
  let ri = 0         // current range index
  let written = 0
  let failed = null
  let lastTick = 0
  dec.on('error', (e) => { failed = e; enc.stdin.end() })
  enc.on('error', (e) => { failed = e; dec.kill() })
  // backpressure: pause the decoder whenever the AAC encoder can't keep up
  enc.stdin.on('drain', () => { if (!failed) dec.stdout.resume() })

  await new Promise((resolve, reject) => {
    dec.stdout.on('data', (chunk) => {
      if (failed) return
      const absStart = pos, absEnd = pos + chunk.length
      let canAccept = true
      while (ri < ranges.length) {
        const [rs, re] = ranges[ri]
        if (absEnd <= rs) break                     // wait for more data
        if (absStart >= re) { ri++; continue }      // range passed
        const from = Math.max(rs, absStart) - absStart
        const to = Math.min(re, absEnd) - absStart
        if (to > from) {
          canAccept = enc.stdin.write(chunk.subarray(from, to))
          written += to - from
        }
        if (absEnd >= re) ri++
        else break
      }
      pos = absEnd
      if (onByte && written - lastTick > 4000000) { lastTick = written; onByte(written, totalOut) }
      if (!canAccept && !failed) dec.stdout.pause()
    })
    dec.stdout.on('end', () => enc.stdin.end())
    dec.on('close', (code) => { if (code !== 0 && !failed) { failed = new Error('audio decode exit ' + code); enc.stdin.end() } })
    enc.on('close', (code) => {
      if (failed || code !== 0) reject(failed || new Error('aac encode exit ' + code + ' ' + encErr))
      else resolve()
    })
    dec.on('error', reject); enc.on('error', reject)
  })
  return { written, totalOut }
}

// ---------------------------------------------------------------- gofile mirror
/**
 * Best-effort mirror of the final file to GoFile (free file host) so the
 * download link survives ephemeral hosts (Colab session end, container
 * restarts). Never throws — returns { url } on success, null otherwise.
 * Disable with env GOFILE_MIRROR=0.
 */
async function mirrorToGoFile(file, name) {
  if (process.env.GOFILE_MIRROR === '0') return null
  // GOFILE_API (advanced): point the mirror at another GoFile-compatible API —
  // used for testing/self-hosting. Server entries containing ':' are treated as
  // absolute origins (e.g. http://localhost:9876); plain names get .gofile.io.
  const API_BASE = process.env.GOFILE_API || 'https://api.gofile.io'
  const cacheFile = path.join(ROOT, '..', '.gofile.json')
  const jGet = async (url, opts) => {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(30_000) })
    const j = await r.json().catch(() => null)
    if (!j || j.status !== 'ok') throw new Error(`gofile api ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
    return j.data
  }
  try {
    let { token, server } = (() => {
      try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) } catch { return {} }
    })()
    // GOFILE_TOKEN / GOFILE_FOLDER_ID — cloud mode passes the browser-created
    // guest account so the result lands next to the original in the SAME public
    // folder (one download page shows both files).
    const extToken = process.env.GOFILE_TOKEN
    const extFolder = process.env.GOFILE_FOLDER_ID
    if (extToken) token = extToken
    if (!token) {
      const acc = await jGet(`${API_BASE}/accounts`, { method: 'POST' })
      token = acc.token
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!server) {
        const d = await jGet(`${API_BASE}/servers`)
        const servers = (d.servers || []).map((s) => s.name).filter(Boolean)
        if (!servers.length) throw new Error('no gofile servers available')
        server = servers[Math.floor(Math.random() * servers.length)]
      }
      try {
        // stream from disk when the runtime supports it; fall back to a buffer
        let blob
        try { blob = await fs.promises.openAsBlob(file) }
        catch { blob = new Blob([await fs.promises.readFile(file)]) }
        const fd = new FormData()
        fd.append('file', blob, name)
        fd.append('token', token)
        if (extFolder) fd.append('folderId', extFolder)
        const origin = /^[a-z0-9.-]+$/i.test(server) ? `https://${server}.gofile.io` : `http://${server}`
        const r = await fetch(`${origin}/contents/uploadfile`, {
          method: 'POST', body: fd, signal: AbortSignal.timeout(30 * 60_000),
        })
        const j = await r.json().catch(() => null)
        if (!j || j.status !== 'ok') throw new Error(`upload failed ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
        if (!extToken) { try { fs.writeFileSync(cacheFile, JSON.stringify({ token, server })) } catch { /* cache is best-effort */ } }
        logStd(`gofile: mirrored to ${j.data.downloadPage} (${server})`)
        return { url: j.data.downloadPage }
      } catch (e) {
        logStd(`gofile attempt ${attempt + 1} on ${server} failed: ${e.message}`)
        server = null
        // token may be stale → fresh guest account for the retry
        if (attempt === 0) {
          try {
            const acc = await jGet(`${API_BASE}/accounts`, { method: 'POST' })
            token = acc.token
          } catch (e2) { logStd(`gofile token refresh failed: ${e2.message}`) }
        }
      }
    }
    return null
  } catch (e) {
    logStd(`gofile mirror skipped: ${e.message}`)
    return null
  }
}

// ---------------------------------------------------------------- bunny stream mirror
/** best direct-MP4 URL for a Bunny video (needs BUNNY_CDN_HOST + resolutions) */
function bunnyBestMp4(guid, resos) {
  const cdn = String(process.env.BUNNY_CDN_HOST || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (!cdn || !resos) return null
  const best = String(resos).split(',').map((r) => parseInt(r, 10)).filter((n) => n > 0).sort((a, b) => b - a)[0]
  return best ? `https://${cdn}/${guid}/play_${best}p.mp4` : null
}
/** Stream zones block referer-less requests — verify with the embed page as referer */
async function bunnyMp4Works(mp4, referer) {
  try {
    const h = await fetch(mp4, { method: 'HEAD', headers: { referer }, signal: AbortSignal.timeout(20_000) })
    if (h.ok) return true
    logStd(`bunny: mp4 HEAD ${h.status} — dropping direct link`)
  } catch { /* network hiccup → treat as unavailable */ }
  return false
}

/**
 * Best-effort mirror of the final file to Bunny Stream (paid CDN, survives
 * everything, gives a hosted player page). Preferred over GoFile when
 * configured. Needs:
 *   BUNNY_STREAM_LIBRARY_ID — the numeric library id (Stream → library → API)
 *   BUNNY_STREAM_API_KEY    — the library API key (UUID)
 *   BUNNY_STREAM_API_KEY_ALT — optional second key to try (same library)
 *   BUNNY_CDN_HOST — optional library CDN host (e.g. vz-xxx.b-cdn.net): enables a
 *     direct MP4 link (best encoded resolution). Note: Stream zones block
 *     referer-less requests, so that link is meant to be CLICKED from a page
 *     (e.g. our UI) — the embed player link always works everywhere.
 *   BUNNY_API_BASE / BUNNY_EMBED_BASE — overrides for testing/self-hosting
 * Never throws — returns { url, guid, mp4? } on success, null otherwise.
 */
async function mirrorToBunnyStream(file, name) {
  const libId = String(process.env.BUNNY_STREAM_LIBRARY_ID || '').trim()
  if (!libId || !/^\d+$/.test(libId)) return null
  const keys = [process.env.BUNNY_STREAM_API_KEY, process.env.BUNNY_STREAM_API_KEY_ALT]
    .map((k) => String(k || '').trim()).filter(Boolean)
  if (!keys.length) return null

  const API = (process.env.BUNNY_API_BASE || 'https://video.bunnycdn.com').replace(/\/$/, '')
  const EMBED = (process.env.BUNNY_EMBED_BASE || 'https://iframe.mediadelivery.net/embed').replace(/\/$/, '')

  const jReq = async (path, key, opts = {}) => {
    const r = await fetch(`${API}/library/${libId}${path}`, {
      ...opts,
      headers: { AccessKey: key, accept: 'application/json', ...(opts.headers || {}) },
      signal: opts.signal || AbortSignal.timeout(60_000),
    })
    const j = await r.json().catch(() => null)
    if (!r.ok) throw new Error(`bunny ${path.split('?')[0]} ${r.status} ${JSON.stringify(j).slice(0, 160)}`)
    return j
  }

  try {
    // 1. create the video entry (try each configured key)
    let key = null
    let created = null
    let lastErr = null
    for (const k of keys) {
      try {
        created = await jReq('/videos', k, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: name }) })
        key = k
        break
      } catch (e) { lastErr = e }
    }
    if (!created) throw lastErr || new Error('bunny create failed')
    const guid = created.guid || created.videoGuid || created.id || (created.data && (created.data.guid || created.data.id))
    if (!guid || typeof guid !== 'string') throw new Error(`bunny create returned no guid: ${JSON.stringify(created).slice(0, 160)}`)

    // 2. upload the bytes (stream from disk when possible)
    let blob
    try { blob = await fs.promises.openAsBlob(file) }
    catch { blob = new Blob([await fs.promises.readFile(file)]) }
    const up = await fetch(`${API}/library/${libId}/videos/${guid}`, {
      method: 'PUT',
      headers: { AccessKey: key, 'content-type': 'application/octet-stream' },
      body: blob,
      signal: AbortSignal.timeout(60 * 60_000),
    })
    if (!up.ok) throw new Error(`bunny upload ${up.status} ${(await up.text().catch(() => '')).slice(0, 160)}`)

    // 3. short encode poll — status 4 = finished, availableResolutions = MP4s
    //    ready. If the encode queue is slow we don't block `done`: the embed
    //    link works on its own and a post-done catch-up adds the MP4 link later.
    let status = -1
    let resos = null
    let last = null
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 4000 : 12000))
      try {
        last = await jReq(`/videos/${guid}`, key)
        status = Number(last.status ?? -1)
        resos = last.availableResolutions || null
        const ep = Math.round(Number(last.encodeProgress ?? 0))
        if (ep > 0 && ep < 100) {
          mirrorStageText = `${AR.mirroring} (ترميز Bunny ${ep}%)`
          progress({ phase: 'mirroring', stage: mirrorStageText, pct: 99 })
        }
        if (status === 4 || resos) break
        if (status === 5 || status === 6) throw new Error(`bunny encode status ${status}`)
      } catch (e) {
        if (String(e.message).includes('status 5') || String(e.message).includes('status 6')) throw e
        // transient poll failure → keep waiting
      }
    }
    const embed = last && last.iframeSrc ? `https:${last.iframeSrc}` : `${EMBED}/${libId}/${guid}`
    let mp4 = bunnyBestMp4(guid, resos)
    if (mp4 && !(await bunnyMp4Works(mp4, embed))) mp4 = null
    logStd(`bunny: mirrored ${guid} (encode status ${status}${mp4 ? ', mp4 ready' : ''})`)
    return { url: embed, guid, ...(mp4 ? { mp4 } : {}) }
  } catch (e) {
    logStd(`bunny mirror failed: ${e.message}`)
    return null
  }
}

/** after `done`: if the encode queue was slow, keep polling for the finished
 *  encode and return the direct MP4 link (bounded ~8 min, never throws). */
async function catchUpBunnyMp4(bunny) {
  try {
    const libId = String(process.env.BUNNY_STREAM_LIBRARY_ID || '').trim()
    const key = String(process.env.BUNNY_STREAM_API_KEY || process.env.BUNNY_STREAM_API_KEY_ALT || '').trim()
    if (!libId || !/^\d+$/.test(libId) || !key || !bunny.guid) return null
    const API = (process.env.BUNNY_API_BASE || 'https://video.bunnycdn.com').replace(/\/$/, '')
    let headFails = 0
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 12_000))
      try {
        const r = await fetch(`${API}/library/${libId}/videos/${bunny.guid}`, {
          headers: { AccessKey: key, accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        })
        if (!r.ok) continue
        const v = await r.json().catch(() => null)
        const mp4 = bunnyBestMp4(bunny.guid, v && v.availableResolutions)
        if (!mp4) continue
        // the MP4 file can lag a few seconds behind the resolutions metadata
        // (transient 404 on the edge) → keep polling instead of giving up
        if (await bunnyMp4Works(mp4, bunny.url)) return mp4
        if (++headFails >= 5) return null // MP4 access genuinely unavailable
      } catch { /* transient → keep waiting */ }
    }
    return null
  } catch { return null }
}

/** output is on disk → mirror it externally → finish. Download stays available
 *  during the mirror (the UI shows the button from phase 'mirroring'). */
let mirrorStageText = null // live stage text while a mirror uploads/polls

async function finish(outPath, output) {
  // drop stale mirror links from a previous render of the same job
  setPhase('mirroring', { output, gofile: undefined, bunny: undefined })
  mirrorStageText = null
  progress({ phase: 'mirroring', stage: AR.mirroring, pct: 99 })
  // heartbeat so the API stall-detector (10 min) never kills a long upload
  const hb = setInterval(() => {
    try { progress({ phase: 'mirroring', stage: mirrorStageText || AR.mirroring, pct: 99 }) } catch { /* shutting down */ }
  }, 15_000)
  const base = String(job.name || 'video').replace(/\.[^.]+$/, '') || 'video'
  const outName = `${base}-qattaas.mp4`
  // cloud runs are bounded by the request budget — skip Bunny entirely (its
  // encode queue can take minutes) and mirror straight to GoFile
  const cloudRun = process.env.QATTAAS_CLOUD === '1'
  let ext = cloudRun ? null : await mirrorToBunnyStream(outPath, outName)
  let extField = ext ? { bunny: ext } : null
  if (!ext) {
    ext = await mirrorToGoFile(outPath, outName)
    extField = ext ? { gofile: ext } : null
  }
  clearInterval(hb)
  setPhase('done', extField || {})
  progress({ phase: 'done', stage: AR.done, pct: 100 })
  // post-done catch-up: slow Bunny encode queue → add the direct MP4 link when
  // it appears; the UI picks it up on its next status poll (it keeps polling
  // at `done`). Only writes if this guid is still the live one (re-render safe).
  if (extField && extField.bunny && !extField.bunny.mp4) {
    const mp4 = await catchUpBunnyMp4(extField.bunny)
    if (mp4) {
      try {
        const j = JSON.parse(fs.readFileSync(jobFile, 'utf8'))
        if (j.phase === 'done' && j.bunny && j.bunny.guid === extField.bunny.guid) {
          j.bunny.mp4 = mp4
          writeJSON(jobFile, j)
          logStd(`bunny: mp4 link added post-done (${mp4})`)
        }
      } catch { /* best-effort */ }
    } else {
      logStd('bunny: mp4 catch-up ended without a link (encode too slow or blocked)')
    }
  }
}

// ---------------------------------------------------------------- video chunks
function balanced(terms) {
  if (terms.length === 1) return terms[0]
  const mid = Math.floor(terms.length / 2)
  return `(${balanced(terms.slice(0, mid))}+${balanced(terms.slice(mid))})`
}

function chunkCommands(plan, crf) {
  const { windows, fps, totalFrames } = plan
  const keptFrames = windows.reduce((n, [a2, b2]) => n + (b2 - a2), 0)
  const n = Math.min(8, Math.max(1, Math.ceil(keptFrames / fps / 110)))
  // split windows into n groups with roughly equal kept frames
  const target = keptFrames / n
  const groups = [[]]
  let acc = 0
  for (const w of windows) {
    groups[groups.length - 1].push(w)
    acc += w[1] - w[0]
    if (acc >= target && groups.length < n) { groups.push([]); acc = 0 }
  }
  const partsDir = path.join(dir, 'parts')
  fs.mkdirSync(partsDir, { recursive: true })
  const listFile = path.join(partsDir, 'list.txt')

  const cmds = groups.filter((g) => g.length).map((g, i) => {
    const X = Math.max(0, g[0][0] / fps - 0.5)
    const Y = Math.min(plan.durationMs / 1000 + 0.5, g[g.length - 1][1] / fps + 0.5)
    const rel = g.map(([fa, fb]) => [fa / fps - X, fb / fps - X])
    // full-precision boundaries (+ rounding guard): a 3-decimal toFixed here
    // used to drop up to one boundary frame per window — with many cuts that
    // drifted the video shorter than the sample-exact audio track and failed
    // the A/V duration check. The 5e-4 guard covers double ULP noise and the
    // 3-decimal rounding of the -ss seek point.
    const expr = balanced(rel.map(([a2, b2]) => `gte(t,${(a2 - 5e-4).toPrecision(12)})*lt(t,${(b2 - 5e-4).toPrecision(12)})`))
    // bulletproof re-timing:
    //   settb  = lock the tick unit to the source timebase
    //   setpts = integer ticks per frame (float-free, no drift)
    //   fps    = regenerate frame durations (setpts zeroes them; without this the
    //            mp4 muxer writes the last sample with duration 0 = phantom frame)
    const fpsStr = `${plan.fpsNum}/${plan.fpsDen}`
    const vf = plan.ticksInt
      ? `select='${expr}',settb=1/${plan.tbDen},setpts=N*${plan.ticksPerFrame},fps=${fpsStr}`
      : `select='${expr}',setpts=N/(${plan.fps}*TB),fps=${fpsStr}`
    const out = path.join(partsDir, `p${i}.mp4`)
    const args = ['-ss', X.toFixed(3), '-to', Y.toFixed(3), '-i', src,
      '-vf', vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(crf),
      '-pix_fmt', 'yuv420p', '-level', '4.2', '-an', out]
    const frames = g.reduce((m, [a2, b2]) => m + (b2 - a2), 0)
    return { i, out, args, frames }
  })
  fs.writeFileSync(listFile, cmds.map((c) => `file '${c.out}'`).join('\n') + '\n')
  return { cmds, partsDir, listFile }
}

/** run chunk commands with `lanes` parallel lanes */
async function runChunks(cmds, lanes, onChunkDone) {
  let next = 0
  async function lane() {
    while (true) {
      const idx = next++
      if (idx >= cmds.length) return
      const c = cmds[idx]
      await ff(c.args)
      onChunkDone(c)
    }
  }
  const n = Math.max(1, Math.min(lanes, cmds.length))
  const errors = []
  await Promise.all(Array.from({ length: n }, async () => {
    try { await lane() } catch (e) { errors.push(e) }
  }))
  if (errors.length) throw errors[0]
}

// ---------------------------------------------------------------- render
async function render(settings) {
  const { gapMs, thresholdDb, crf } = settings
  setPhase('rendering')
  progress({ phase: 'rendering', stage: AR.scanning, pct: 2 })

  const { plan } = await getPlan({ gapMs, thresholdDb })
  logStd(`plan: cuts=${plan.cutsCount} kept=${plan.keptMs}ms saved=${plan.savedMs}ms`)

  const outPath = path.join(dir, 'out.mp4')

  // nothing to cut → just faststart-copy the original
  if (plan.cutsCount === 0) {
    progress({ phase: 'rendering', stage: AR.muxing, pct: 50 })
    await ff(['-i', src, '-c', 'copy', '-movflags', '+faststart', outPath])
    await finish(outPath, { size: fs.statSync(outPath).size, durationMs: plan.durationMs, cutsCount: 0 })
    logStd('done (no cuts, stream copy)')
    return
  }

  // -- 1. audio (streaming, 8%→16%) --
  progress({ phase: 'rendering', stage: AR.audio, pct: 8 })
  const audioT0 = Date.now()
  const { written, totalOut } = await buildAudio(plan, (w, tot) => {
    const pct = 8 + Math.min(1, w / Math.max(1, tot)) * 8
    progress({ phase: 'rendering', stage: AR.audio, pct })
  })
  logStd(`audio: wrote ${written} / ${totalOut} bytes in ${((Date.now() - audioT0) / 1000).toFixed(1)}s`)
  if (Math.abs(written - totalOut) > 48000) throw new Error(`audio slice mismatch ${written}!=${totalOut}`)

  // -- 2. video chunks (16%→88%) --
  const { cmds, partsDir, listFile } = chunkCommands(plan, crf)
  const totalChunkFrames = cmds.reduce((m, c) => m + c.frames, 0)
  let doneFrames = 0
  let doneCount = 0
  const videoT0 = Date.now()
  await runChunks(cmds, 2, (c) => {
    doneFrames += c.frames
    doneCount += 1
    const pct = 16 + (doneFrames / totalChunkFrames) * 72
    const elapsed = (Date.now() - videoT0) / 1000
    const keptSec = totalChunkFrames / plan.fps
    const speed = pct > 20 ? (keptSec * ((pct - 16) / 72)) / Math.max(0.1, elapsed) : null
    const etaSec = pct > 20 ? (elapsed / (pct - 16)) * (88 - pct) : null
    progress({
      phase: 'rendering', pct,
      stage: AR.video(doneCount, cmds.length),
      speedX: speed ? Math.round(speed * 10) / 10 : null,
      etaSec: etaSec ? Math.round(etaSec) : null,
    })
  })
  logStd(`video: ${cmds.length} chunks in ${((Date.now() - videoT0) / 1000).toFixed(1)}s`)

  // -- 3. concat + mux (88%→93%) --
  progress({ phase: 'rendering', stage: AR.muxing, pct: 88 })
  await ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-i', path.join(dir, 'audio.m4a'),
    '-map', '0:v', '-map', '1:a', '-c', 'copy', '-movflags', '+faststart', outPath])

  // -- 4. verify (93%→97%) --
  progress({ phase: 'rendering', stage: AR.verifying, pct: 93 })
  const info = await probe(outPath)
  const vd = parseFloat(info.streams.find((s) => s.codec_type === 'video').duration)
  const ad = parseFloat(info.streams.find((s) => s.codec_type === 'audio').duration)
  const expected = plan.keptMs / 1000
  logStd(`verify: video=${vd}s audio=${ad}s expected=${expected.toFixed(3)}s size=${info.format.size}`)
  if (Math.abs(vd - ad) > 0.1) throw new Error(`A/V duration mismatch: ${vd.toFixed(3)} vs ${ad.toFixed(3)}`)
  if (Math.abs(vd - expected) > 0.15) throw new Error(`unexpected output duration: ${vd.toFixed(3)} vs ${expected.toFixed(3)}`)

  // -- 5. cleanup temp (97%→100%) --
  progress({ phase: 'rendering', stage: AR.cleanup, pct: 97 })
  fs.rmSync(partsDir, { recursive: true, force: true })
  fs.rmSync(path.join(dir, 'audio.m4a'), { force: true })

  await finish(outPath, { size: parseInt(info.format.size, 10), durationMs: Math.round(vd * 1000), cutsCount: plan.cutsCount })
  logStd(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

// ---------------------------------------------------------------- main
try {
  if (action === 'analyze') {
    setPhase('analyzing')
    progress({ phase: 'analyzing', stage: AR.scanning, pct: 30 })
    await scanAndPlan({ gapMs: 200, thresholdDb: -35 })
    progress({ phase: 'ready', pct: 100 })
    logStd('analyze done')
  } else {
    const s = JSON.parse(settingsArg || '{}')
    const settings = {
      gapMs: [100, 200, 300].includes(s.gapMs) ? s.gapMs : 200,
      thresholdDb: [-40, -35, -30].includes(s.thresholdDb) ? s.thresholdDb : -35,
      crf: [28, 32, 36].includes(s.crf) ? s.crf : 32,
    }
    await render(settings)
  }
  process.exit(0)
} catch (e) {
  logStd('ERROR: ' + (e && e.stack || e))
  setPhase('error', { error: e.message === 'NO_AUDIO' ? 'الفيديو مش فيه مسار صوت' : String(e.message || e).slice(0, 300) })
  progress({ phase: 'error', error: String(e.message || e).slice(0, 300) })
  process.exit(1)
}
