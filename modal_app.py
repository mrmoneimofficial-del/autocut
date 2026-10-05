# -*- coding: utf-8 -*-
"""
قصّاص (AutoCut) على Modal — استضافة كاملة مجانية ضمن $30 كريدت شهري

الخطوات (مرة واحدة، ~5 دقايق):
  1) اعمل حساب مجاني على modal.com (تسجيل دخول بـ GitHub — بدون كارت)
  2) نفّذ:
        pip install modal
        modal token new          # يفتح المتصفح لتسجيل الدخول
        modal deploy modal_app.py
  3) خد اللينك اللي هيظهر (شكله: https://<workspace>--qattaas--serve.modal.run)

التفاصيل:
  - نفس صورة الـ Dockerfile الرسمية (Next standalone + ffmpeg + المحرك)
  - 2 vCPU + 4GB RAM — فيديو 110 دقيقة يترندر في ~9 دقائق (مثل الساندبوكس)
  - scale-to-zero: صفر تكلفة وقت الخمول
  - التكلفة الفعلية ~$0.07 للرندر الكامل ← الكريدت المجاني (~$30/شهر) يكفي ~400 رندر
  - تخزين الـ jobs على Modal Volume يفضل بين التشغيلات
  - (اختياري) نسخة خارجية دائمة لكل نتيجة على Bunny Stream — أنشئ سر Modal مرة واحدة:
        modal secret create bunny-stream BUNNY_STREAM_LIBRARY_ID=<رقم المكتبة> BUNNY_STREAM_API_KEY=<المفتاح>
    ثم شيل علامة التعليق عن سطر secrets= في التابع تحت
"""

import subprocess

import modal

app = modal.App("qattaas")

# نفس صورة الإنتاج الرسمية (متعددة المراحل: build ثم runtime بـ ffmpeg)
image = modal.Image.from_dockerfile("Dockerfile")

# تخزين الـ jobs (الرفع/النتيجة) — يفضل بين إعادة التشغيل
storage = modal.Volume.from_name("qattaas-jobs", create_if_missing=True)


@app.function(
    image=image,
    volumes={"/app/storage": storage},
    # secrets=[modal.Secret.from_name("bunny-stream")],  # شيل التعليق بعد إنشاء السر (شوف فوق)
    cpu=2,                 # مثل الساندبوكس — 110 دقيقة فيديو ≈ 9 دقائق رندر
    memory=4096,
    timeout=3600,          # أقصى عمر للحاوية الواحدة (ساعة كاملة)
    scaledown_window=600,  # يفضل مستيقظ 10 دقائق بعد آخر طلب (يحمي الرفعات الطويلة)
    max_containers=1,      # job = ملفات على فوليوم واحد — حاوية واحدة تكفي وتوفر الكريدت
)
@modal.web_server(7860, startup_timeout=300)
def serve():
    # الصورة جاهزة: WORKDIR=/app، USER=node، PORT=7860، HOSTNAME=0.0.0.0
    subprocess.run(["node", "server.js"], cwd="/app", check=True)
