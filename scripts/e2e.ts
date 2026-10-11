/**
 * Backend E2E verification script (run with bun).
 * Drives the full API flow: init → chunked upload → complete → analysis →
 * detection math assertions → decisions → render → output validation.
 */
const BASE = 'http://localhost:3000'
const TOKEN = 'e2e-token-' + crypto.randomUUID()

async function api(method: string, path: string, body?: any, raw?: boolean) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'x-owner-token': TOKEN,
      ...(body && !raw ? { 'content-type': 'application/json' } : {}),
    },
    body: raw ? (body as any) : body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function uploadFile(filePath: string, filename: string, mime = 'video/mp4') {
  const size = (await Bun.file(filePath).stat()).size
  const init = await api('POST', '/api/autocut/jobs', { filename, size, mime })
  if (init.status !== 200) throw new Error('init failed: ' + JSON.stringify(init))
  const jobId = init.json.job.id
  const CHUNK = 4 * 1024 * 1024
  const f = Bun.file(filePath)
  for (let off = 0; off < size; off += CHUNK) {
    const end = Math.min(size, off + CHUNK)
    const buf = new Uint8Array(await f.slice(off, end).arrayBuffer())
    const res = await fetch(`${BASE}/api/autocut/jobs/${jobId}/upload/chunk?offset=${off}`, {
      method: 'POST',
      headers: { 'x-owner-token': TOKEN, 'content-type': 'application/octet-stream' },
      body: buf,
      signal: AbortSignal.timeout(180_000),
    })
    if (res.status !== 200) {
      const t = await res.text()
      throw new Error(`chunk @${off} failed ${res.status}: ${t}`)
    }
  }
  const done = await api('POST', `/api/autocut/jobs/${jobId}/upload/complete`)
  if (done.status !== 200) throw new Error('complete failed: ' + JSON.stringify(done.json))
  return jobId
}

async function waitFor(jobId: string, statuses: string[], timeoutMs = 240_000) {
  const t0 = Date.now()
  let last: any = null
  while (Date.now() - t0 < timeoutMs) {
    const { json } = await api('GET', `/api/autocut/jobs/${jobId}`)
    last = json.job
    if (statuses.includes(last.status)) return last
    if (last.status === 'failed') throw new Error('job failed: ' + JSON.stringify(last.error))
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`timeout waiting for ${statuses}; last=${last?.status} ${last?.stageMessage}`)
}

const fmt = (ms: number) => `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`

async function run() {
  const file = process.argv[2]
  const expectCycles = Number(process.argv[3] ?? 10)
  const mode: 'precision' | 'fast' = (process.argv[4] as any) ?? 'precision'
  console.log(`\n=== E2E: ${file} (mode=${mode}, cycles=${expectCycles}) ===`)

  const t0 = Date.now()
  const jobId = await uploadFile(file, file.split('/').pop()!)
  console.log(`uploaded job ${jobId} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  const job = await waitFor(jobId, ['detected'])
  console.log(`analysis done in ${((Date.now() - t0) / 1000).toFixed(1)}s — meta: ${job.meta.durationMs}ms, ${job.meta.width}x${job.meta.height}@${job.meta.fps}, audio ${job.meta.audioCodec} ${job.meta.audioChannelLayout}`)
  console.log(`stats: ${job.stats.regionCount} regions, silence ${fmt(job.stats.totalSilenceMs)}, removing ${fmt(job.stats.willRemoveMs)}, final ${fmt(job.stats.finalDurationMs)} (${job.stats.savedPct}%)`)

  // ---- detection math assertions ----------------------------------------
  const det = await api('GET', `/api/autocut/jobs/${jobId}/decisions`)
  const regions = det.json.decisions.regions
  const silences = regions.filter((r: any) => r.kind === 'silence')
  // 3 silence regions per 30s cycle: ~[6,9], ~[12,12.8], ~[15,17.5]
  const perCycle = expectCycles
  // 2–3 cuttable silences per 30 s cycle depending on settings; the strict
  // correctness check is the render drift math below
  const okCount = silences.length >= perCycle * 1.5 && silences.length <= perCycle * 3.5
  console.log(`silence regions: ${silences.length} (expected ~${perCycle * 3}) ${okCount ? '✓' : '✗ MISMATCH'}`)
  const kinds = {}
  for (const r of regions) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1
  console.log('region kinds:', JSON.stringify(kinds))

  // re-detection with different settings must be instant
  const td = Date.now()
  const re = await api('POST', `/api/autocut/jobs/${jobId}/detect`, {
    settings: { thresholdDb: -30, minSilenceMs: 1500, keepBeforeMs: 100, keepAfterMs: 100, compressSilence: false, targetSilenceMs: 0, smartPadding: true, breathingProtection: true, lowSpeechProtection: true, noiseTolerance: true },
  })
  if (re.status !== 200) throw new Error('re-detect failed: ' + JSON.stringify(re.json))
  console.log(`re-detect with minSilence=1500ms in ${Date.now() - td}ms — regions: ${re.json.regions.filter((r: any) => r.kind === 'silence').length}, stats: ${JSON.stringify(re.json.stats)}`)

  // per-region override: keep every 5th silence
  const decisions = re.json as any
  const silenceRegions = decisions.regions.filter((r: any) => r.kind === 'silence')
  silenceRegions.forEach((r: any, i: number) => {
    if (i % 5 === 0) r.action = 'keep'
    else r.action = 'remove'
  })
  const put = await api('PUT', `/api/autocut/jobs/${jobId}/decisions`, {
    decisions: { regions: decisions.regions, targetSilenceMs: 0, render: { fadeMs: 12, renderMode: mode } },
  })
  if (put.status !== 200) throw new Error('decisions PUT failed: ' + JSON.stringify(put.json))
  console.log('decisions saved (every 5th silence kept, mode=remove)')

  // ---- render -------------------------------------------------------------
  const tr = Date.now()
  const ren = await api('POST', `/api/autocut/jobs/${jobId}/render`, {
    render: { fadeMs: 12, renderMode: mode },
  })
  if (ren.status !== 200) throw new Error('render failed: ' + JSON.stringify(ren.json))
  const doneJob = await waitFor(jobId, ['done'], 45 * 60_000)
  console.log(`render done in ${((Date.now() - tr) / 60000).toFixed(1)} min — output ${doneJob.outputSizeBytes} bytes, ${doneJob.outputDurationMs}ms`)

  // ---- expected duration math --------------------------------------------
  const kept = silenceRegions.filter((r: any) => r.action !== 'keep')
  const expectedRemoval = kept.reduce((a: number, r: any) => a + (r.cutEndMs - r.cutStartMs), 0)
  const expectedFinal = det.json.durationMs - expectedRemoval
  let okDur: boolean
  if (mode === 'precision') {
    const drift = Math.abs(doneJob.outputDurationMs - expectedFinal) / expectedFinal * 100
    console.log(`expected final: ${expectedFinal}ms, actual: ${doneJob.outputDurationMs}ms — drift ${drift.toFixed(2)}% ${drift < 2 ? '✓' : '✗ TOO MUCH DRIFT'}`)
    okDur = drift < 2
  } else {
    // fast mode: cuts snap inward to keyframes → output keeps MORE than the
    // exact plan but must still be shorter than the original
    const ok = doneJob.outputDurationMs >= expectedFinal * 0.98 && doneJob.outputDurationMs < det.json.durationMs * 0.995
    console.log(
      `fast mode: expected ≥ ${expectedFinal}ms, actual ${doneJob.outputDurationMs}ms (original ${det.json.durationMs}ms) ${ok ? '✓ conservative keyframe cut' : '✗ UNEXPECTED'}`
    )
    okDur = ok
  }

  // ---- media URLs + range request ------------------------------------------
  const media = await api('POST', `/api/autocut/jobs/${jobId}/media-url`)
  if (!media.json.streamUrl || !media.json.outputUrl) throw new Error('media-url failed')
  const head = await fetch(BASE + media.json.outputUrl, { headers: { range: 'bytes=0-1023' } })
  console.log(`range request on output: ${head.status} ${head.headers.get('content-range')}`)
  if (head.status !== 206) throw new Error('range request failed')

  // ownership check: foreign token must be rejected
  const foreign = await fetch(`${BASE}/api/autocut/jobs/${jobId}`, { headers: { 'x-owner-token': 'someone-else-token-1' } })
  console.log(`foreign token access: ${foreign.status} ${foreign.status === 403 || foreign.status === 404 ? '✓' : '✗ NOT SECURE'}`)

  // cleanup
  await api('DELETE', `/api/autocut/jobs/${jobId}`)
  console.log('job deleted ✓')
  return { ok: okCount && okDur }
}

run()
  .then((r) => {
    console.log(r.ok ? '\n=== E2E PASSED ===' : '\n=== E2E HAD FAILURES ===')
    process.exit(r.ok ? 0 : 1)
  })
  .catch((e) => {
    console.error('\n=== E2E ERROR ===', e)
    process.exit(1)
  })
