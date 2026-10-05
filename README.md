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

> **ملاحظة:** المعالجة تعتمد على `ffmpeg` على السيرفر — المنصة السحابية بدون ffmpeg ستعرض الواجهة فقط دون قدرة على المعالجة. للنشر الكامل على لينك عام، استخدم `Dockerfile` المرفق (شوف قسم Docker بالأسفل).

## ☁️ النشر المجاني الكامل — Hugging Face Spaces (الخيار الأفضل)

**Hugging Face Spaces** بتديك مجانًا حاوية Docker حقيقية: **2 معالج vCPU + 16GB رام** — أقوى من سيرفرات كتير مدفوعة، ومناسبة تمامًا لمحرك القص (نفس سرعة جهازنا: فيديو 110 دقيقة ≈ 9 دقائق).

**الخطوات (5 دقايق):**
1. اعمل حساب مجاني على [huggingface.co](https://huggingface.co)
2. من صفحتك → **New Space** → سمّيه `qattaas` → **Docker** → **CPU Basic (Free)**
3. ارفع ملفات الريبو ده للـ Space (Dockerfile + باقي الملفات) — أوامر git مباشرة:
   ```bash
   git clone https://huggingface.co/spaces/USERNAME/qattaas && cd qattaas
   # انسخ ملفات المشروع هنا ثم:
   git add . && git commit -m "deploy" && git push
   ```
4. عدّل الـ `README.md` بتاع الـ Space وخلّي أول سطوره:
   ```yaml
   ---
   title: Qattaas
   emoji: ✂️
   colorFrom: orange
   colorTo: yellow
   sdk: docker
   app_port: 7860
   ---
   ```
5. استنى البيلد (~3 دقايق) → التطبيق شغال على `https://USERNAME-qattaas.hf.space` 🎉

**حدود الخطة المجانية:** الـ Space بينام بعد 48 ساعة عدم استخدام (أول زيارة تاني بتوقظه في ثواني)، والتخزين مؤقت (بيرجع يفرغ مع إعادة التشغيل) — وده مش مشكلة: الـ jobs أصلاً بتتمسح بعد 24 ساعة، والمستخدم بياخد نتيجته قبلها. لو المعالجة اتقطعت بسبب restart، التطبيق بيكشفها لوحده وبيعرض "إعادة المحاولة".

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

## 🐳 Full deployment (UI + upload + processing) — Docker

Serverless platforms (Vercel…) render the UI only: no persistent disk, a 4.5MB request-body cap, and no ffmpeg. For a fully-working public instance, the repo ships a `Dockerfile` that bundles everything (UI + API + the ffmpeg engine):

```bash
docker build -t autocut .
docker run -p 3000:3000 -v autocut-data:/app/storage autocut
```

Deploys as-is to **Railway · Render · Fly.io · any VPS** — these run Docker with a real disk and real CPU, so uploads and rendering work end-to-end on a public URL.
