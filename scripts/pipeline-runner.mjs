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
  mirroring: 'نحفظ النتيجة على التخزين السحابي…',
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
/** probe the source once — shared by every planning path */
async function probeMeta() {
  const info = await probe(src)
  const v = info.streams.find((s) => s.codec_type === 'video')
  const a = info.streams.find((s) => s.codec_type === 'audio')
  if (!a) throw new Error('NO_AUDIO')
  if (!v) throw new Error('NO_VIDEO')
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
  const [tbNum, tbDen] = (v.time_base || '1/90000').split('/').map(Number)
  const ticksPerFrame = Math.round((tbDen * den) / (tbNum * num))
  const frameGrid = {
    fps, totalFrames, tbNum, tbDen, ticksPerFrame, fpsNum: num, fpsDen: den,
    ticksInt: Math.abs((tbDen * den) / (tbNum * num) - ticksPerFrame) < 1e-9,
  }
  return { meta, frameGrid, duration, fps, totalFrames }
}

/** plan summary that lands in job.json (what the UI displays) */
function planSummary(plan) {
  return {
    settings: plan.settings, durationMs: plan.durationMs, keptMs: plan.keptMs,
    savedMs: plan.savedMs, cutsCount: plan.cutsCount, cuts: plan.cuts,
  }
}

async function scanAndPlan(settings) {
  const { gapMs, thresholdDb } = settings
  const { meta, frameGrid, duration, fps, totalFrames } = await probeMeta()

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
  const { tbNum, tbDen, ticksPerFrame, fpsNum, fpsDen, ticksInt } = frameGrid
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
    settings, fps, sr: meta.sr, ch: meta.ch, totalFrames, tbNum, tbDen, ticksPerFrame,
    fpsNum, fpsDen, ticksInt,
    durationMs: meta.durationMs,
    keptMs: Math.round(keptFrames * 1000 / fps),
    savedMs: Math.round(savedMs),
    cutsCount: cuts.length,
    cuts, windows,
  }
  writeJSON(planFile, plan)
  setPhase('ready', { meta, plan: planSummary(plan) })
  return { plan, meta }
}

/** EXPLICIT montage plan — the browser detected + hand-tuned the cuts on the
 *  audio envelope (dragging boundaries, excluding gaps) and sent the exact
 *  list; the render then matches the live preview 1:1. */
async function planFromCuts(settings) {
  const raw = Array.isArray(settings.cuts) ? settings.cuts : []
  const cuts = []
  for (const c of raw) {
    if (!Array.isArray(c) || c.length < 2) continue
    const s = Math.max(0, Math.round(Number(c[0]) || 0))
    const e = Math.round(Number(c[1]) || 0)
    if (e - s < 20) continue
    const last = cuts[cuts.length - 1]
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e)
    else cuts.push([s, e])
  }
  if (!cuts.length) throw new Error('NO_CUTS')

  const { meta, frameGrid, fps, totalFrames } = await probeMeta()
  const { tbNum, tbDen, ticksPerFrame, fpsNum, fpsDen, ticksInt } = frameGrid
  const windows = []
  let cur = 0
  let savedMs = 0
  for (const [sMs, eMs] of cuts) {
    const keepEndF = Math.floor((sMs / 1000) * fps)
    const resumeF = Math.ceil((eMs / 1000) * fps)
    if (keepEndF - cur > 1) windows.push([cur, keepEndF])
    savedMs += (resumeF - keepEndF) * 1000 / fps
    cur = Math.max(cur, resumeF)
  }
  if (totalFrames - cur > 1) windows.push([cur, totalFrames])
  const keptFrames = windows.reduce((n, [a2, b2]) => n + (b2 - a2), 0)
  const plan = {
    settings, fps, sr: meta.sr, ch: meta.ch, totalFrames, tbNum, tbDen, ticksPerFrame,
    fpsNum, fpsDen, ticksInt,
    durationMs: meta.durationMs,
    keptMs: Math.round(keptFrames * 1000 / fps),
    savedMs: Math.round(savedMs),
    cutsCount: cuts.length,
    cuts, windows,
  }
  writeJSON(planFile, plan)
  // refresh the plan summary in job.json WITHOUT touching the current phase
  const j = JSON.parse(fs.readFileSync(jobFile, 'utf8'))
  j.plan = planSummary(plan)
  writeJSON(jobFile, j)
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

// --------------------------------------------------------- bunny storage mirror
/**
 * Upload the final file to Bunny Storage (the مستر منعم upload system's
 * storage layer) so the result survives ephemeral hosts. The file lands in
 * the SAME session folder as the original (uploads/<sid>/result-<stamp>.mp4)
 * and the API route signs a delivery token for it. Never throws —
 * returns { path, size } on success, null otherwise.
 * Env: BUNNY_STORAGE_ZONE, BUNNY_STORAGE_PASSWORD (+ optional
 * BUNNY_STORAGE_HOST override for self-hosted/test setups),
 * QATTAAS_RESULT_DIR (cloud mode passes the original's session folder).
 */
async function mirrorToBunnyStorage(file) {
  const zone = String(process.env.BUNNY_STORAGE_ZONE || 'qattaas').trim()
  const password = String(process.env.BUNNY_STORAGE_PASSWORD || '').trim()
  if (!password) {
    logStd('storage: skipped (BUNNY_STORAGE_PASSWORD not configured)')
    return null
  }
  const dirBase = String(process.env.QATTAAS_RESULT_DIR || `uploads/${jobId}`).replace(/\/+$/, '')
  const remotePath = `${dirBase}/result-${Date.now().toString(36)}.mp4`
  const hostRaw = String(process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com').replace(/\/+$/, '')
  const base = hostRaw.startsWith('http') ? `${hostRaw}/${zone}` : `https://${hostRaw}/${zone}`
  try {
    mirrorStageText = `${AR.mirroring}`
    progress({ phase: 'mirroring', stage: mirrorStageText, pct: 99 })
    // stream from disk when the runtime supports it; fall back to a buffer
    let body
    try { body = await fs.promises.openAsBlob(file) }
    catch { body = new Blob([await fs.promises.readFile(file)]) }
    const r = await fetch(`${base}/${remotePath}`, {
      method: 'PUT',
      headers: { AccessKey: password, 'Content-Type': 'application/octet-stream' },
      body,
      signal: AbortSignal.timeout(30 * 60_000),
    })
    if (!r.ok) throw new Error(`PUT ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`)
    const size = fs.statSync(file).size
    logStd(`storage: result saved at ${remotePath} (${size} bytes)`)
    return { path: remotePath, size }
  } catch (e) {
    logStd(`storage mirror failed: ${e.message}`)
    return null
  }
}

/** output is on disk → upload it to Bunny Storage → finish. Download stays
 *  available during the upload (the UI shows the button from phase 'mirroring'). */
let mirrorStageText = null // live stage text while the storage upload runs

async function finish(outPath, output) {
  // drop stale storage links from a previous render of the same job
  setPhase('mirroring', { output, storage: undefined })
  mirrorStageText = null
  progress({ phase: 'mirroring', stage: AR.mirroring, pct: 99 })
  // heartbeat so the API stall-detector (10 min) never kills a long upload
  const hb = setInterval(() => {
    try { progress({ phase: 'mirroring', stage: mirrorStageText || AR.mirroring, pct: 99 }) } catch { /* shutting down */ }
  }, 15_000)
  const ext = await mirrorToBunnyStorage(outPath)
  clearInterval(hb)
  setPhase('done', ext ? { storage: ext } : {})
  progress({ phase: 'done', stage: AR.done, pct: 100 })
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

  const { plan } = settings.cuts
    ? await planFromCuts(settings)
    : await getPlan({ gapMs, thresholdDb })
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
    const clamp = (v, lo, hi, d) => {
      const n = Number(v)
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d
    }
    const settings = {
      gapMs: clamp(s.gapMs, 0, 1000, 200),
      thresholdDb: clamp(s.thresholdDb, -70, -5, -35),
      crf: clamp(s.crf, 18, 40, 32),
    }
    if (Array.isArray(s.cuts) && s.cuts.length) settings.cuts = s.cuts
    await render(settings)
  }
  process.exit(0)
} catch (e) {
  logStd('ERROR: ' + (e && e.stack || e))
  setPhase('error', { error: e.message === 'NO_AUDIO' ? 'الفيديو مش فيه مسار صوت' : String(e.message || e).slice(0, 300) })
  progress({ phase: 'error', error: String(e.message || e).slice(0, 300) })
  process.exit(1)
}
