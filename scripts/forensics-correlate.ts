/** DECISIVE: cross-correlate the RMS profile of the EATEN phrase (original
 *  156.32→157.36) against a wide window of the OUTPUT audio. If the phrase
 *  survives anywhere in the output, correlation will spike. Also align the
 *  post-join content to pinpoint the exact join position. */
import fs from 'node:fs'

function rmsProfile(file: string, from: number, dur: number): number[] {
  const out = `/tmp/prof_${Math.random().toString(36).slice(2)}.raw`
  const p = Bun.spawnSync(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-ss', from.toFixed(3), '-t', dur.toFixed(3),
    '-i', file, '-vn', '-ar', '1000', '-ac', '1', '-acodec', 'pcm_s16le', '-f', 's16le', '-y', out])
  if (p.exitCode !== 0) throw new Error(p.stderr.toString().slice(0, 200))
  const buf = fs.readFileSync(out)
  fs.unlinkSync(out)
  const vals: number[] = []
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const v = buf.readInt16LE(i) / 32768
    vals.push(20 * Math.log10(Math.sqrt(v * v) + 1e-10))
  }
  return vals
}

const ORIG = '/home/z/my-project/storage/autocut/d26ef7bc-af52-4d77-8341-d1474b8ff2cb/original.mp4'
const OUT = '/home/z/my-project/storage/autocut/d26ef7bc-af52-4d77-8341-d1474b8ff2cb/output.mp4'

// 1ms-resolution RMS profiles
const eaten = rmsProfile(ORIG, 156.32, 1.04)          // the phrase removed per the plan
const prePause = rmsProfile(ORIG, 155.10, 0.55)       // last speech before the pause
const postJoin = rmsProfile(ORIG, 157.40, 2.0)        // first speech after the removed span
const outWin = rmsProfile(OUT, 117.5, 12.0)           // wide output window around the join

function bestMatch(needle: number[], hay: number[]): { pos: number; score: number } {
  // normalized cross-correlation, coarse step then refine
  const n = needle.length
  const nMean = needle.reduce((a, b) => a + b, 0) / n
  const nSq = Math.sqrt(needle.reduce((a, b) => a + (b - nMean) ** 2, 0))
  let best = { pos: -1, score: -2 }
  for (let off = 0; off + n <= hay.length; off += 25) {
    let sxy = 0, sy = 0, syy = 0
    for (let i = 0; i < n; i++) { const y = hay[off + i]; sxy += (needle[i] - nMean) * y; sy += y; syy += y * y }
    const denom = nSq * Math.sqrt(Math.max(1e-9, syy - (sy * sy) / n))
    const score = sxy / denom
    if (score > best.score) best = { pos: off, score }
  }
  return best
}

const a = bestMatch(eaten, outWin)
console.log(`EATEN phrase (156.32-157.36) best match in output[117.5-129.5]: pos ${a.pos}ms → output t=${(117.5 + a.pos / 1000).toFixed(2)}s, corr=${a.score.toFixed(3)}`)
const b = bestMatch(prePause, outWin)
console.log(`PRE-PAUSE speech (155.10-155.65) best match: output t=${(117.5 + b.pos / 1000).toFixed(2)}s, corr=${b.score.toFixed(3)}`)
const c = bestMatch(postJoin, outWin)
console.log(`POST-JOIN speech (157.40-159.40) best match: output t=${(117.5 + c.pos / 1000).toFixed(2)}s, corr=${c.score.toFixed(3)}`)
console.log(`\nلو الجملة المتآكلة موجودة في المخرج: هيظهر match قوي (corr > 0.7) عند مكانها.`)
console.log(`الفرق المتوقع بين PRE-PAUSE و POST-JOIN في الأصل: ${(157.40 - 155.65).toFixed(2)}s؛ في المخرج المفروض يبقى ~0.2s لو الجملة اتشالت.`)
