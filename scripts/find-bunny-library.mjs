#!/usr/bin/env bun
/**
 * قصّاص — أداة اكتشاف رقم مكتبة Bunny Stream
 *
 * مفتاح مكتبة Bunny Stream (UUID) لوحده مش كفاية — لازم معاه رقم المكتبة
 * (Library ID). لو عندك المفتاح وناسي الرقم، الأداة دي بتمسح نطاق أرقام
 * وتوقف عند أول مطابقة.
 *
 * الاستخدام:
 *   BUNNY_STREAM_API_KEY=xxx bun scripts/find-bunny-library.mjs --from 400000 --to 500000
 *   # مفاتيح متعددة (بيجربهم بالترتيب):
 *   BUNNY_STREAM_API_KEY=xxx BUNNY_STREAM_API_KEY_ALT=yyy bun scripts/find-bunny-library.mjs
 *   # API مختلف (اختبار):
 *   BUNNY_API_BASE=http://localhost:9877 bun scripts/find-bunny-library.mjs --from 1 --to 10
 *
 * الرقم بيظهر في لوحة bunny: Stream → المكتبة → API → "Video Library ID"
 */
const args = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}

const FROM = Number(argOf('--from', 400000))
const TO = Number(argOf('--to', 500000))
const CONCURRENCY = Math.min(64, Number(argOf('--c', 40)))

const API = (process.env.BUNNY_API_BASE || 'https://video.bunnycdn.com').replace(/\/$/, '')
const KEYS = [process.env.BUNNY_STREAM_API_KEY, process.env.BUNNY_STREAM_API_KEY_ALT]
  .map((k) => String(k || '').trim()).filter(Boolean)

if (!KEYS.length) {
  console.error('مفيش مفاتيح — شغّل الأمر بمتغير BUNNY_STREAM_API_KEY (وشوف أعلى الملف)')
  process.exit(1)
}
if (!(FROM >= 1 && TO >= FROM)) {
  console.error('نطاق غير صالح')
  process.exit(1)
}

const total = (TO - FROM + 1) * KEYS.length
console.log(`نمسح ${total.toLocaleString('en')} طلب على المكتبات ${FROM}..${TO} بـ${CONCURRENCY} مسارات متوازية…`)
if (API.includes('localhost')) console.log(`(وضع الاختبار: ${API})`)

const t0 = Date.now()
let done = 0
let found = null

async function check(id, keyIdx) {
  if (found) return
  const key = KEYS[keyIdx]
  try {
    const r = await fetch(`${API}/library/${id}/videos?page=1&itemsPerPage=1`, {
      headers: { AccessKey: key, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (r.ok) {
      found = { id, keyIdx }
      console.log(`\n★ وجدناها! Library ID = ${id} (المفتاح رقم ${keyIdx + 1})`)
      process.exit(0)
    }
  } catch { /* network hiccup → skip this id */ }
  done++
  if (done % 2000 === 0) {
    const rate = done / ((Date.now() - t0) / 1000)
    const left = (total - done) / Math.max(0.1, rate)
    process.stdout.write(`\r${done.toLocaleString('en')}/${total.toLocaleString('en')} — ${rate.toFixed(0)}/ث — باقي ~${Math.ceil(left / 60)} دقيقة   `)
  }
}

const work = []
let cursor = FROM
let keyCursor = 0
async function lane() {
  while (!found) {
    if (cursor > TO) return
    const id = cursor++
    for (let k = 0; k < KEYS.length && !found; k++) await check(id, k)
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => lane()))

if (found) process.exit(0)
const mins = ((Date.now() - t0) / 60000).toFixed(1)
console.log(`\nخلصنا المسح (${mins} دقيقة) — مفيش مطابقة في النطاق ${FROM}..${TO}`)
console.log('جرّب نطاق مختلف: --from N --to M (أو شوف الرقم مباشرة من لوحة bunny: Stream → API)')
process.exit(1)
