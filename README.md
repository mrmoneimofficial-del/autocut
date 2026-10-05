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
- ☁️ **نسخة خارجية تلقائية** — بعد كل رندر ناجح، النتيجة بتترفع تلقائيًا على GoFile ولينك خارجي بيعيش حتى بعد ما السيرفر يقفل (مفيد جدًا مع كولاب). تعطيلها: `GOFILE_MIRROR=0`

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

## ☁️ النشر المجاني غير المحلي — الخيارات الحقيقية (أكتوبر 2026)

> ⚠️ **مهم:** Hugging Face غيّرت سياستها منتصف 2025 — حاويات **Docker/Gradio Spaces بقت تتطلب اشتراك PRO ($9/شهر)** حتى على أضعف عتاد. الحساب المجاني بيسمح بـ Static Spaces فقط (بدون سيرفر = بدون ffmpeg) — اتأكدنا من ده بالتجربة الفعلية.

### أ) Google Colab — مجاني 100% وصفر حسابات جديدة ✈️
الريبو فيه نوتبوك جاهز — افتح اللينك واضغط **Run all** وهيظهرلك لينك عام بعد حوالي 3 دقائق:

**[🚀 افتح قصّاص على كولاب بنقرة واحدة](https://colab.research.google.com/github/mrmoneimofficial-del/autocut/blob/main/colab.ipynb)**

- العتاد: 2 vCPU + 12.7GB رام (أقوى من سيرفرات بـ$7 شهريًا!)
- اللينك بيعيش مع الجلسة (~12 ساعة) — مناسب للاستخدام عند الحاجة
- التخزين مؤقت داخل الجلسة — نزّل نتيجتك قبل القفل

### ب) Modal — أقوى حل مجاني دائم 🏆 (الأفضل)
حساب مجاني (تسجيل GitHub، بدون كارت) = **$30 كريدت شهريًا** + حاويات حقيقية scale-to-zero:

```bash
pip install modal
modal token new        # تسجيل دخول مرة واحدة
modal deploy modal_app.py
```

- 2 vCPU + 4GB — فيديو 110 دقيقة ≈ 9 دقائق رندر (نفس سرعة الساندبوكس بالضبط)
- التكلفة الفعلية ~$0.07 للرندر الكامل ← الكريدت المجاني يكفي **~400 رندر شهريًا**
- لينك ثابت + تخزين الـ jobs بيفضل بين التشغيلات

### ج) Oracle Cloud Always Free — لمن يملك كارتًا دوليًا 💪
4 أنوية ARM + 24GB رام + 200GB ديست **مجانًا للأبد** — أقوى عرض سحابي مجاني موجود، لكن التسجيل بيرفض حسابات كتير من مصر. الـ `Dockerfile` الجاهز يشتغل عليه زي الزيوت.

> والدوكرفايل نفسه يشتغل على أي منصة تدعم Docker: Railway · Render · Fly.io · أي VPS.

</div>

---

## AutoCut — English

Blazing-fast video silence cutter with a minimal Arabic RTL UI (white/orange, Cairo font).

- **Engine**: single-file FFmpeg pipeline — `silencedetect` scan → frame-grid-aligned cut plan → streaming sample-accurate audio slicing → N≤8 parallel `libx264 ultrafast` video chunks → concat + single-step mux with duration verification.
- **Stack**: Next.js 16 (App Router) · React 19 · Tailwind CSS 4 · zero-DB (JSON job files).
- **UI**: upload with chunked XHR → smart preview (auto-skip silence + interactive timeline) → 3 essential settings → parallel render with live progress → download + automatic GoFile mirror of the result (survives ephemeral hosts; disable with `GOFILE_MIRROR=0`).

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

**Free non-local options (Oct 2026):** Hugging Face Docker Spaces now require a PRO subscription ($9/mo). The repo ships two free paths: `colab.ipynb` (one-click Google Colab, zero accounts — open in Colab, Run all, get a public URL) and `modal_app.py` (Modal, $30/month free credits, real containers, scale-to-zero). See the Arabic section above for links.
