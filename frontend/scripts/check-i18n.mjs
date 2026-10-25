// Verifies every translation key used in the source exists in both dictionaries.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|ts)$/.test(f) && !p.includes("i18n")) files.push(p);
  }
})("src");

const used = new Set();
const keyRe = /\bt\(\s*"([a-zA-Z0-9_.]+)"/g;
const strRe = /"((?:f|pos|font|perm|confirm|lang|stamp|cmp|preset|wm|err|chk)\.[a-zA-Z0-9_.]+)"/g;
for (const f of files) {
  const s = readFileSync(f, "utf8");
  for (const m of s.matchAll(keyRe)) used.add(m[1]);
  for (const m of s.matchAll(strRe)) used.add(m[1]);
}
// dynamic families
const reg = readFileSync("src/components/tools/registry.tsx", "utf8");
const ids = [...reg.matchAll(/id: "([a-z_]+)", cat:/g)].map((m) => m[1]);
used.add("f.recommended");
for (const id of ids) { used.add(`tool.${id}`); used.add(`desc.${id}`); }
const cats = reg.match(/CATEGORIES = \[([^\]]+)\]/)[1].match(/"([a-z]+)"/g).map((x) => x.replace(/"/g, ""));
for (const c of cats) used.add(`cat.${c}`);
const dyn = {
  annotm: ["select", "highlight", "underline", "strikeout", "squiggly", "note", "freetext", "ink", "line", "arrow", "square", "circle", "stamp"],
  annoth: ["select", "highlight", "underline", "strikeout", "squiggly", "note", "freetext", "ink", "line", "arrow", "square", "circle", "stamp"],
  editm: ["select", "text", "image", "rect", "ellipse", "line", "arrow", "whiteout", "link"],
  edith: ["select", "text", "image", "rect", "ellipse", "line", "arrow", "whiteout", "link"],
  fieldm: ["text", "checkbox", "radio", "dropdown", "date", "signature", "select"],
  "wm.kind": ["watermark", "background", "header"],
  "wm.src": ["pdfaty", "artifact", "layer", "annotation", "text", "fill", "xobject"],
  "wm.srcHelp": ["pdfaty", "artifact", "layer", "annotation", "text", "fill", "xobject"],
  "chk.status": ["pass", "warn", "fail"],
  chk: ["fonts_embedded", "not_encrypted", "no_javascript", "xmp_metadata", "pdfa_identification", "output_intent", "no_transparency_pdfa1",
    "no_embedded_files_pdfa2", "trimbox", "image_resolution", "cmyk_or_managed", "pdfx_identification", "tagged", "language", "title",
    "display_title", "figures_alt", "headings", "text_unicode", "not_scanned"],
  preset: ["email", "phone", "national_id", "iban", "card", "date", "amount"],
  lang: ["ara", "eng", "fra", "deu", "spa", "ita", "tur", "fas", "urd"],
  theme: ["system", "light", "dark"],
  "cmp.t": ["added", "removed", "changed"],
  "cmp.cat": ["amount", "percent", "date", "clause", "number"],
  "batch.st": ["pending", "running", "done", "error"],
  privacy: ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"],
  err: ["generic", "password_required", "wrong_password", "invalid_pdf", "unsupported_file_type", "file_too_large", "total_too_large", "too_many_files",
    "rate_limited", "too_many_active_jobs", "server_busy", "timeout", "out_of_memory", "processing_failed", "unknown_op", "bad_params", "bad_page_range",
    "page_out_of_range", "too_many_pages", "need_two_pdfs", "no_pdf", "image_required", "text_required", "nothing_to_remove", "permission_denied",
    "owner_password_required", "not_encrypted", "password_required_to_set", "password_too_long", "no_areas", "no_terms", "bad_regex", "too_many_terms",
    "no_form", "no_items", "options_required", "no_text_found", "ocr_unavailable", "ocr_language_unavailable", "ocr_failed", "office_unavailable",
    "conversion_failed", "no_tables_found", "no_images_found", "no_attachments", "output_validation_failed", "cannot_delete_all_pages",
    "network_error", "server_unreachable", "server_error", "cancelled", "job_not_found", "empty_file", "bad_url", "no_files", "no_pages",
    "too_many_outputs", "params_too_large", "batch_step_not_pdf", "file_not_found", "not_found", "http_error", "bad_certificate", "certificate_required", "signing_failed"],
  annot: ["Highlight", "Underline", "StrikeOut", "Squiggly", "Text", "FreeText", "Ink", "Line", "Square", "Circle", "Stamp", "FileAttachment", "Polygon", "PolyLine", "Caret", "Sound", "Redact"],
};
for (const [p, list] of Object.entries(dyn)) for (const x of list) used.add(`${p}.${x}`);

const load = (f) => {
  const s = readFileSync(f, "utf8");
  return new Set([...s.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
};
const ar = load("src/i18n/ar.ts"), en = load("src/i18n/en.ts");
const missAr = [...used].filter((k) => !ar.has(k)).sort();
const missEn = [...used].filter((k) => !en.has(k)).sort();
const extraAr = [...ar].filter((k) => !en.has(k));
const extraEn = [...en].filter((k) => !ar.has(k));
if (process.argv.includes("--list")) { console.log([...used].sort().join("\n")); process.exit(0); }
console.log(`keys used: ${used.size}; ar: ${ar.size}; en: ${en.size}`);
if (missAr.length) console.log("missing in ar:", missAr.join(" "));
if (missEn.length) console.log("missing in en:", missEn.join(" "));
if (extraAr.length) console.log("only in ar:", extraAr.join(" "));
if (extraEn.length) console.log("only in en:", extraEn.join(" "));
process.exit(missAr.length || missEn.length || extraAr.length || extraEn.length ? 1 : 0);
