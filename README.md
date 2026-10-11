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
- 📤 **رفع مقطّع موثوق (نظام مستر منعم)** — الفيديو بيتقسم قطع 4MB (تحت حد Vercel 4.5MB) وبيترفع قطعة قطعة: تقدم حقيقي بالنسبة + سرعة + وقت متبقٍ، إيقاف مؤقت/استئناف/إلغاء، إعادة محاولة تلقائية (5 محاولات لكل قطعة)، checksum لكل قطعة، واستئناف بعد قفلة الصفحة من نفس القطعة بالظبط — والملف بيهبط على **Bunny Storage** بشكل دائم
- ☁️ **وضع السحابة للاستضافات بدون تخزين (زي Vercel)** — نفس نظام الرفع شغال فوق أي استضافة (القطع تحت 4.5MB)، والقص بيحصل في طلب واحد مبثوث حيًا بنفس محرك FFmpeg — شوف «وضع السحابة» تحت
- 🇸🇦 **عربي بالكامل** — RTL بخط Cairo، تصميم أبيض/برتقالي نظيف
- 🔐 **توصيل موقّع** — كل روابط التنزيل (الأصل + النتائج) بتتوّق HMAC-SHA256 وبتنتهي تلقائيًا — المسارات الحقيقية مش بتظهر في الروابط أبدًا، والبث بيدعم Range (تقديم/تأخير)

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
| الـ API | نظام رفع مقطّع (init/chunk/status/complete) + بث موقّع + مسارات المهام |
| التخزين | ملف JSON لكل job — بدون قاعدة بيانات |

**المحرك في ملف واحد:** [`scripts/pipeline-runner.mjs`](scripts/pipeline-runner.mjs) — مسح ← خطة قص على شبكة الفريمات ← بث الصوت (فك ترميز ← قص بالبايت ← AAC بدون ملفات وسيطة) ← N أجزاء فيديو متوازية ← دمج + تحقق من المدة. كل استدعاء ffmpeg يستخدم `-nostdin` والعملية تعمل detached.

## 🚀 التشغيل محليًا

```bash
# المتطلبات: Node 20+ / Bun، و ffmpeg مثبت على النظام
bun install
bun run dev     # http://localhost:3000
```

> **ملاحظة:** على سيرفر فيه ffmpeg عادي، المسار الكامل شغال (رفع مقطّع + معاينة + قص دقيق). الاستضافات بدون تخزين (زي Vercel) بتدخل وضع السحابة تلقائيًا — شوف القسم اللي تحت.

## ⚡ وضع السحابة — Vercel نفسها بقت ترفع وتقص ☁️

أي نشر على استضافة serverless (قراءة فقط + حد 4.5MB لجسم الطلب) بيدخل **وضع السحابة** تلقائيًا. الرفع نفسه شغال فوق أي استضافة لأنه **نظام مستر منعم المقطّع**: المتصفح بيفتح جلسة رفع، بيبعت الفيديو قطع 4MB واحدة واحدة (كل قطعة طلب مستقل تحت الحد)، السيرفر بيدمجهم على `/tmp`، وبيرفع الأصل على **Bunny Storage**:

1. **الرفع مقطّع من المتصفح للسيرفر** — تقدم حقيقي + سرعة + ETA + إيقاف مؤقت + إلغاء + retry تلقائي، والقطع اللي هبطت بتتحسب من السيرفر (endpoint الـ status) فالاستئناف بعد أي انقطاع أو قفلة صفحة بيكمل من نفس القطعة
2. **القص بيحصل جوه طلب واحد مبثوث**: السيرفر بيجيب الأصل (نسخة دافية من `/tmp` لو موجودة، وإلا بينزّله من Bunny)، بيشغّل نفس محرك القص بالظبط (ثنائيات `ffmpeg-static`/`ffprobe-static` متدمجة مع الدالة عبر `outputFileTracingIncludes`)، وبيرفع النتيجة على **نفس مجلد الجلسة** على Bunny — النتيجة والأصل جنب بعض دايمًا
3. **الأحداث بتبث للمتصفح حيًا** (NDJSON): تنزيل ← مسح ← ترميز بسرعة وETA ← رفع النتيجة
4. **إعادة قص بإعدادات تانية من غير إعادة رفع** — الأصل خلاص محفوظ على Bunny

الحدود: `CLOUD_MAX_MB` (200 افترائيًا) و300 ثانية للطلب (أقصى خطة Hobby مع Fluid Compute).

### 🔑 متغيرات البيئة المطلوبة (الوضع السحابي)

```
BUNNY_STORAGE_ZONE=<اسم زون التخزين>          # مثال: qattaas
BUNNY_STORAGE_PASSWORD=<مفتاح الكتابة (AccessKey)>
BUNNY_STORAGE_READ_PASSWORD=<مفتاح القراءة>   # اختياري — بيقع على مفتاح الكتابة
ADMIN_SESSION_SECRET=<سر قوي>                 # توقيع روابط التنزيل (HMAC-SHA256)
```

متغيرات اختيارية: `CLOUD_MAX_MB` (حد الحجم)، `BUNNY_STORAGE_HOST` (تبديل نقطة النهاية للاختبار الذاتي/الاستضافة الخاصة)، `QATTAAS_TOKEN_TTL_MS` (عمر روابط التنزيل — 7 أيام افترائيًا).

> 🧪 **للاختبار المحلي بدون حساب Bunny:** الريبو فيه `mini-services/bunny-mock` — محاكي كامل لـ API تخزين Bunny على بورت 3041 — وجّه `BUNNY_STORAGE_HOST=http://localhost:3041` واختبر السلسلة كلها.

**فحص ذاتي:** افتح `/api/cloud/diag` على أي نشر — بيقولك بالظبط إيه اللي شغال: `/tmp` قابل للكتابة؟ Bunny متظبط وقابل للوصول والكتابة من شبكة الاستضافة؟ ffmpeg شغال؟

## ☁️ النشر المجاني غير المحلي — الخيارات الحقيقية (أكتوبر 2026)

> ⚠️ **مهم:** Hugging Face غيّرت سياستها منتصف 2025 — حاويات **Docker/Gradio Spaces بقت تتطلب اشتراك PRO ($9/شهر)** حتى على أضعف عتاد. الحساب المجاني بيسمح بـ Static Spaces فقط (بدون سيرفر = بدون ffmpeg) — اتأكدنا من ده بالتجربة الفعلية.

### أ) Google Colab — مجاني 100% وصفر حسابات جديدة ✈️
الريبو فيه نوتبوك جاهز — افتح اللينك واضغط **Run all** وهيظهرلك لينك عام بعد حوالي 3 دقائق:

**[🚀 افتح قصّاص على كولاب بنقرة واحدة](https://colab.research.google.com/github/mrmoneimofficial-del/autocut/blob/main/colab.ipynb)**

- العتاد: 2 vCPU + 12.7GB رام (أقوى من سيرفرات بـ$7 شهريًا!)
- اللينك بيعيش مع الجلسة (~12 ساعة) — مناسب للاستخدام عند الحاجة
- التخزين مؤقت داخل الجلسة — نزّل نتيجتك قبل القفل

### ب) GitHub Codespaces — بحساب GitHub اللي عندك بالفعل 🧑‍💻
**120 ساعة معالجة مجانية شهريًا** (≈60 ساعة تشغيل على الجهاز 2-core) + 15GB تخزين — من غير أي حساب جديد:

**[🧑‍💻 شغّل قصّاص على Codespaces بنقرة واحدة](https://codespaces.new/mrmoneimofficial-del/autocut)**

- الريبو فيه `.devcontainer` جاهز: أول تشغيل بيبني نفس صورة الإنتاج بالظبط (UI + API + ffmpeg) ويشغّل السيرفر تلقائيًا على بورت 7860
- من تبويب **Ports** بالأسفل: كليك يمين على 7860 ← **Port Visibility ← Public** ← انسخ اللينك وشاركه مع أي حد
- (اختياري) لتفعيل الحفظ الدائم على Bunny: **GitHub ← Settings ← Codespaces ← Secrets** — ضيف `BUNNY_STORAGE_ZONE` و `BUNNY_STORAGE_PASSWORD` و `ADMIN_SESSION_SECRET` وحدد الريبو ده
- الكودسبيس بينام بعد 30 دقيقة خمول (اللينك بيرجع أول ما تشغّله تاني من github.com/codespaces) — مناسب للاستخدام عند الحاجة

### ج) Modal — أقوى حل مجاني دائم 🏆 (الأفضل لحل عام ثابت)
حساب مجاني (تسجيل GitHub، بدون كارت) = **$30 كريدت شهريًا** + حاويات حقيقية scale-to-zero:

```bash
pip install modal
modal token new        # تسجيل دخول مرة واحدة
modal deploy modal_app.py
```

- 2 vCPU + 4GB — فيديو 110 دقيقة ≈ 9 دقائق رندر (نفس سرعة الساندبوكس بالضبط)
- التكلفة الفعلية ~$0.07 للرندر الكامل ← الكريدت المجاني يكفي **~400 رندر شهريًا**
- لينك ثابت + تخزين الـ jobs بيفضل بين التشغيلات

### د) Oracle Cloud Always Free — لمن يملك كارتًا دوليًا 💪
4 أنوية ARM + 24GB رام + 200GB ديست **مجانًا للأبد** — أقوى عرض سحابي مجاني موجود، لكن التسجيل بيرفض حسابات كتير من مصر. الـ `Dockerfile` الجاهز يشتغل عليه زي الزيوت.

> والدوكرفايل نفسه يشتغل على أي منصة تدعم Docker: Railway · Render · Fly.io · أي VPS.

</div>

---

## AutoCut — English

Blazing-fast video silence cutter with a minimal Arabic RTL UI (white/orange, Cairo font).

- **Engine**: single-file FFmpeg pipeline — `silencedetect` scan → frame-grid-aligned cut plan → streaming sample-accurate audio slicing → N≤8 parallel `libx264 ultrafast` video chunks → concat + single-step mux with duration verification.
- **Stack**: Next.js 16 (App Router) · React 19 · Tailwind CSS 4 · zero-DB (JSON job files).
- **UI**: chunked upload (4MB, the مستر منعم system: real %, speed, ETA, pause/resume/cancel, auto-retry, resume-after-reload) → smart preview (auto-skip silence + interactive timeline) → 3 essential settings → parallel render with live progress → download + permanent Bunny Storage link (signed HMAC tokens, Range-capable streaming) for both the original and the result.

```bash
bun install && bun run dev   # requires ffmpeg on the host
```

## 🐳 Full deployment (UI + upload + processing) — Docker

Serverless platforms (Vercel…) automatically switch to **cloud mode**: the browser uploads through the chunked system (4MB pieces, each request under the 4.5MB body cap) to the server, which merges on `/tmp` and stores the original on **Bunny Storage** (`BUNNY_STORAGE_ZONE`/`BUNNY_STORAGE_PASSWORD` env). A single streamed request then fetches the original (warm `/tmp` copy first, else Bunny), runs the same bundled ffmpeg engine (`ffmpeg-static` traced into the function), and puts the result back into the same session folder — live NDJSON progress, re-cut without re-upload, signed token links, `CLOUD_MAX_MB` (default 200) + 300s budget. `/api/cloud/diag` self-reports what works from the host's network. For unlimited sizes / fully-local processing, use the `Dockerfile`:

```bash
docker build -t autocut .
docker run -p 3000:3000 -v autocut-data:/app/storage autocut
```

Deploys as-is to **Railway · Render · Fly.io · any VPS** — these run Docker with a real disk and real CPU, so uploads and rendering work end-to-end on a public URL.

**Free non-local options (Oct 2026):** Hugging Face Docker Spaces now require a PRO subscription ($9/mo). The repo ships three free paths: `colab.ipynb` (one-click Google Colab, zero accounts), `.devcontainer` (one-click GitHub Codespaces — [codespaces.new/mrmoneimofficial-del/autocut](https://codespaces.new/mrmoneimofficial-del/autocut), 120 free core-hours/month with a personal GitHub account), and `modal_app.py` (Modal, $30/month free credits, real containers, scale-to-zero). See the Arabic section above for details.
