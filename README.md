<div dir="rtl">

# ✂️ قصّاص

**قص الصمت من الفيديو بأقصى سرعة ممكنة** — واجهة عربية بسيطة، محرّك FFmpeg فائق السرعة، وتزامن صوت/صورة بدقة الفريم الواحد.

> فيديو 110 دقيقة ⇐ يترندر في **~9 دقائق** على معالجين فقط (13× الوقت الحقيقي)

---

## ✨ المميزات

- 🚀 **سرعة قصوى** — 8 أجزاء متوازية × `libx264 ultrafast` مع قص صوت sample-accurate
- 🎯 **دقة فريم-بفريم** — نقاط القص محاذاة على شبكة فريمات الفيديو، والصوت مقصوص بالعينة = تزامن A/V رياضي 100%
- 🧠 **بريفيو ذكي** — شاهد الفيديو مع تخطي الصمت تلقائيًا قبل الرندر، وتايم لاين تفاعلي (الكلام رمادي / الصمت برتقالي)
- 🎛️ **3 إعدادات فقط** — طول الفجوة المتبقية، حساسية الكشف، الجودة
- 📤 **رفع مقطّع موثوق** — قطع 8MB مع تتبع التقدم والسرعة وETA، واستكمال تلقائي بعد الانقطاع
- 🇸🇦 **عربي بالكامل** — RTL بخط Cairo، تصميم أبيض/برتقالي نظيف

## 🔄 سير العمل

1. **ارفع** الفيديو (سحب وإفلات)
2. **تحليل** — مسح الصمت بـ `silencedetect` وبناء خطة القص
3. **النتيجة المتوقعة** فورًا — كم وقت هيتوفر وعدد السكتات
4. **بريفيو ذكي** — جرّب النتيجة قبل الرندر بتخطي الصمت أثناء المشاهدة
5. **رندر** — أجزاء متوازية × ultrafast ثم دمج في خطوة واحدة
6. **تحميل** النتيجة النهائية

## 🛠️ البنية التقنية

| الطبقة | التقنية |
|--------|---------|
| الواجهة | Next.js 16 · React 19 · Tailwind CSS 4 |
| المحرّك | FFmpeg 7 — `silencedetect` + `select` + concat demuxer |
| الـ API | 3 مسارات فقط: إنشاء / حالة / رفع ملف |
| التخزين | ملف JSON لكل job — بدون قاعدة بيانات |

**المحرك في ملف واحد:** [`scripts/pipeline-runner.mjs`](scripts/pipeline-runner.mjs) — مسح ← خطة قص على شبكة الفريمات ← بث الصوت (فك ترميز ← قص بالبايت ← AAC بدون ملفات وسيطة) ← N أجزاء فيديو متوازية ← دمج + تحقق من المدة. كل استدعاء ffmpeg يستخدم `-nostdin` والعملية تعمل detached.

## 🚀 التشغيل محليًا

```bash
# المتطلبات: Node 20+ / Bun، و ffmpeg مثبت على النظام
bun install
bun run dev     # http://localhost:3000
```

> **ملاحظة:** المعالجة تعتمد على `ffmpeg` على السيرفر — المنصة السحابية بدون ffmpeg ستعرض الواجهة فقط دون قدرة على المعالجة.

</div>

---

## AutoCut — English

Blazing-fast video silence cutter with a minimal Arabic RTL UI (white/orange, Cairo font).

- **Engine**: single-file FFmpeg pipeline — `silencedetect` scan → frame-grid-aligned cut plan → streaming sample-accurate audio slicing → N≤8 parallel `libx264 ultrafast` video chunks → concat + single-step mux with duration verification.
- **Stack**: Next.js 16 (App Router) · React 19 · Tailwind CSS 4 · zero-DB (JSON job files).
- **UI**: upload with chunked XHR → smart preview (auto-skip silence + interactive timeline) → 3 essential settings → parallel render with live progress → download.

```bash
bun install && bun run dev   # requires ffmpeg on the host
```
