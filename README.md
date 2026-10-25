# PDFATY — محرر PDF عربي مجاني على الويب

تطبيق ويب كامل لتحرير وإدارة ملفات PDF بواجهة عربية (مع الإنجليزية): عرض وبحث، تحرير
النصوص والصور، دمج وتقسيم وتنظيم الصفحات، تحويل من وإلى Word/Excel/PowerPoint/صور،
OCR عربي وإنجليزي، تعليقات ومراجعة، توقيع (صورة أو رقمي بشهادة)، مقارنة نسختين مع وضع
خاص بالعقود، حماية وحجب نهائي، علامات مائية وخلفيات، ضغط، نماذج، فحص متقدم، ومعالجة جماعية.

- بدون حساب، بدون اشتراك، وبدون أي API مدفوع — كل المكتبات مجانية ومرخّصة (THIRD_PARTY_NOTICES).
- الخصوصية: العرض والبحث داخل المتصفح؛ العمليات الأخرى على خادم الموقع نفسه، والملفات تُحذف فور التنزيل أو خلال 15 دقيقة (SECURITY.md).
- قائمة الوظائف وحالتها بدقة: FEATURES.md.

## البنية

```
frontend/   React 18 + TypeScript + Vite + PDF.js 5   (الواجهة، العارض، الأدوات التفاعلية)
backend/    FastAPI + عمليات PDF في عملية فرعية معزولة لكل مهمة
            pikepdf/qpdf, PDFium (pypdfium2), pdfplumber, reportlab, Tesseract, LibreOffice, pyHanko
Dockerfile  صورة واحدة تبني الواجهة وتشغّل الخادم على المنفذ 7860
```

كل عملية على الخادم: رفع ← طابور ← عملية فرعية بحد زمني وحد ذاكرة ← تنزيل النتيجة ← حذف فوري.

## التشغيل محليًا

### 1) الطريقة الأسهل: Docker
```bash
docker compose up --build
# افتح http://localhost:7860
```

### 2) بدون Docker (Linux/macOS)
المتطلبات: Python 3.12+، Node 20+، `tesseract-ocr` مع `tesseract-ocr-ara` و`tesseract-ocr-eng`، و`libreoffice`.
```bash
# Ubuntu/Debian:
sudo apt install tesseract-ocr tesseract-ocr-ara tesseract-ocr-eng libreoffice-writer libreoffice-calc libreoffice-impress fonts-noto-core

./scripts/start.sh            # يبني الواجهة ويشغل الخادم على http://localhost:8000
```

### 3) وضع التطوير (إعادة تحميل تلقائي)
```bash
cd backend && pip install -r requirements-dev.txt && cd ..
cd frontend && npm ci && cd ..
./scripts/dev.sh              # API على 8000 + واجهة Vite على http://localhost:5173
```

## الاختبارات
```bash
./scripts/test.sh
```
يشغّل:
- `backend`: ‏65 اختبار (كل العمليات + API + حدود الرفع + الأمان) — `python3 -m pytest -q`
- `frontend`: فحص الترجمة (`npm run i18n`)، اختبارات الوحدات (`npm test`)، فحص الأنواع والبناء (`npm run build`)
- اختبارات متصفح حقيقية (Playwright): ‏21 سيناريو — `npx playwright test`

## النشر العام
راجع **DEPLOYMENT.md** (Hugging Face Spaces مجانًا، أو Render، أو أي خادم Docker).

## الإعدادات
كل الإعدادات اختيارية عبر متغيرات البيئة — انظر `.env.example` (حدود الحجم والوقت والطابور ومعدل الطلبات والاحتفاظ).

## هيكل الكود المختصر
| المسار | المحتوى |
|---|---|
| `backend/app/main.py` | واجهة HTTP، فحص نوع الملف، الحدود، رؤوس الأمان، خدمة الواجهة |
| `backend/app/jobs.py` | طابور المهام، العملية الفرعية، المهلة، الحذف التلقائي |
| `backend/app/worker.py` | تنفيذ عملية واحدة بحد ذاكرة |
| `backend/app/ops/*.py` | العمليات: pages, stamps, layers, ocr, convert, security, compress, forms, annots, compare, inspect, signing, extract |
| `frontend/src/components/Viewer.tsx` | العارض (رسم كسول، طبقة نص، روابط، طبقات الأدوات) |
| `frontend/src/components/tools/` | الأدوات التفاعلية وسجل الأدوات |
| `frontend/src/views/` | الصفحة الرئيسية، مساحة العمل، الأدوات المستقلة (دمج، تحويل، مقارنة، دفعات) |
| `frontend/src/i18n/` | الترجمة العربية والإنجليزية |
