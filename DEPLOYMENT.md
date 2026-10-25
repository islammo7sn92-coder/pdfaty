# النشر العام لـ PDFATY

التطبيق صورة Docker واحدة (الواجهة + الخادم + Tesseract + LibreOffice). يحتاج تقريبًا:
**2 vCPU و 2–4 GB RAM** لتشغيل OCR والتحويل براحة، ومساحة مؤقتة ~2 GB. لا يحتاج قاعدة بيانات
ولا أسرار ولا مفاتيح API.

> ملاحظة مهمة: شغّل عملية uvicorn **واحدة** فقط (`--workers 1`)، لأن طابور المهام في الذاكرة.
> التوازي داخل العملية يتحكم فيه `PDFATY_MAX_CONCURRENT_JOBS`.

---

## الخيار 1 (موصى به ومجاني): Hugging Face Spaces — Docker
مجاني (CPU basic: ‏2 vCPU و16 GB RAM)، رابط HTTPS عام تلقائيًا بالشكل
`https://<username>-pdfaty.hf.space`.

### الخطوات (مرة واحدة)
1. أنشئ حسابًا مجانيًا على https://huggingface.co
2. أنشئ Token بصلاحية **Write** من https://huggingface.co/settings/tokens
3. من جذر المشروع على جهاز به `git` و`rsync` و`curl`:
   ```bash
   HF_TOKEN=hf_xxxxxxxx HF_SPACE=<username>/pdfaty ./deploy/huggingface/deploy.sh
   ```
   السكربت ينشئ Space من نوع Docker، يرفع الكود مع ملف التعريف `deploy/huggingface/README.md`
   (المنفذ 7860)، وHugging Face يبني الصورة تلقائيًا (~10 دقائق في المرة الأولى).
4. افتح `https://<username>-pdfaty.hf.space` وتأكد من `/api/health`.

بديل يدوي: أنشئ Space جديد (SDK = Docker)، ارفع محتويات المشروع، واستبدل `README.md` في الـ Space
بمحتوى `deploy/huggingface/README.md`.

قيود الخطة المجانية: الـ Space "ينام" بعد فترة بدون زيارات ويستيقظ عند أول زيارة (~30 ثانية).

---

## الخيار 1-ب (مجاني): Cloudflare Tunnel من جهازك
Cloudflare المجاني لا يستطيع تشغيل Python وOCR وLibreOffice بنفسه (Workers/Pages للواجهة فقط،
وCloudflare Containers تحتاج خطة مدفوعة 5$ شهريًا). الحل المجاني: يشتغل التطبيق على جهازك أو خادمك
بـ Docker، وCloudflare Tunnel يعطيه رابط HTTPS عام بدون فتح منافذ وبدون IP ثابت.

1. ثبّت Docker و`cloudflared`.
2. رابط سريع مؤقت (بدون حساب):
   ```bash
   ./scripts/cloudflare-tunnel.sh
   ```
   سيظهر رابط مثل `https://xxxx.trycloudflare.com` — يتغير مع كل تشغيل، ويعمل طالما الجهاز شغال.
3. رابط ثابت على دومين خاص (حساب Cloudflare مجاني + دومين مضاف إليه):
   Cloudflare Dashboard → Zero Trust → Networks → Tunnels → Create tunnel → انسخ الـ Token،
   وأضف Public Hostname (مثل `pdf.example.com`) يشير إلى `http://localhost:7860`، ثم:
   ```bash
   TUNNEL_TOKEN=xxxx ./scripts/cloudflare-tunnel.sh
   ```
   ارفع حد حجم الرفع في الخطة المجانية: Cloudflare يقبل طلبات حتى 100 MB.

---

## الخيار 2: Render.com
`render.yaml` جاهز (Blueprint). الخطة المجانية 512 MB RAM فقط: العرض والأدوات الخفيفة تعمل،
لكن LibreOffice وOCR للملفات الكبيرة قد يفشلان لنفاد الذاكرة. خطة Starter مدفوعة إن احتجت.
1. ارفع المشروع إلى مستودع GitHub.
2. في Render: New → Blueprint → اختر المستودع → Apply.

---

## الخيار 3: أي خادم Linux (VPS) أو جهازك
```bash
docker build -t pdfaty .
docker run -d --name pdfaty -p 7860:7860 --read-only --tmpfs /tmp:size=4g \
  --security-opt no-new-privileges --memory 4g --restart unless-stopped pdfaty
```
ثم ضع أمامه Reverse Proxy بـ HTTPS (مثال Caddy — يصدر شهادة Let's Encrypt مجانًا تلقائيًا):
```
pdf.example.com {
    reverse_proxy 127.0.0.1:7860
    request_body {
        max_size 260MB
    }
}
```

---

## متغيرات البيئة
كلها اختيارية — انظر `.env.example`. أهمها:
| المتغير | الافتراضي | المعنى |
|---|---|---|
| `PORT` | 7860 | منفذ الخادم |
| `PDFATY_MAX_UPLOAD_MB` | 100 | أقصى حجم للملف الواحد |
| `PDFATY_MAX_TOTAL_MB` | 250 | أقصى حجم للطلب |
| `PDFATY_JOB_TIMEOUT` / `PDFATY_OCR_TIMEOUT` | 300 / 1800 | المهلة بالثواني |
| `PDFATY_MAX_CONCURRENT_JOBS` | 2 | مهام متوازية |
| `PDFATY_RATE_LIMIT_PER_MIN` | 40 | مهام جديدة لكل IP في الدقيقة |
| `PDFATY_RESULT_TTL` | 900 | أقصى مدة بقاء النتائج على الخادم |
| `PDFATY_WORKER_MEMORY_MB` | 3072 | حد ذاكرة كل عملية معالجة |
| `PDFATY_TRUST_PROXY` | 1 | قراءة IP العميل من `X-Forwarded-For` (آخر قيمة) خلف منصة الاستضافة |

## فحوصات الصحة
- `GET /api/health` → `{"status":"ok"}` (مستخدم في `HEALTHCHECK` داخل Dockerfile وفي render.yaml)
- `GET /api/capabilities` → اللغات المتاحة لـ OCR وتوفر LibreOffice والحدود

## HTTPS
توفره منصة الاستضافة (Hugging Face / Render) تلقائيًا. التطبيق يرسل `Strict-Transport-Security`
عند الطلب عبر HTTPS، ورؤوس `Content-Security-Policy` و`X-Frame-Options` وغيرها دائمًا.

## التحقق بعد النشر
```bash
curl -s https://<your-host>/api/health
curl -s https://<your-host>/api/capabilities
```
ثم افتح الموقع، ارفع ملف PDF، جرّب: دمج، OCR، تحويل Word، ونزّل النتيجة.
