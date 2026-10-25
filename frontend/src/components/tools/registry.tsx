import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BadgeCheck, BookMarked, Bookmark, FileCheck2, ClipboardCheck, Columns2, Combine, Eraser, FileCog, FileImage, FileInput, FilePlus2,
  FileSearch, FileSpreadsheet, FileText, FileType2, FormInput, Image, Images, Info, Layers,
  LayoutGrid, Lock, MessageSquarePlus, Minimize2, PaintBucket, Paperclip, PenLine, PenTool, Presentation, RotateCw,
  ScanText, Scissors, Search, ShieldCheck, SquareStack, Stamp, Table, TextCursorInput, Trash2, Type, Unlock,
  Workflow, Droplets, FileX2, ListOrdered, PanelTop,
} from "lucide-react";

export type FieldDef = {
  k: string;
  label: string;
  type: "text" | "textarea" | "password" | "number" | "range" | "select" | "checkbox" | "color" | "pages" | "image" | "langs" | "note";
  def?: any;
  min?: number;
  max?: number;
  step?: number;
  options?: [string, string][];
  help?: string;
  placeholder?: string;
  showIf?: (v: Record<string, any>) => boolean;
  unit?: string;
};

export interface ToolDef {
  id: string;
  cat: string;
  icon: LucideIcon;
  op?: string;
  kind: "schema" | "custom" | "standalone" | "sidebar";
  needsDoc: boolean;
  fields?: FieldDef[];
  result?: "replace" | "download" | "info";
  preview?: boolean;
  confirm?: string;
  presets?: string;
  serverSide?: boolean;
  batch?: boolean;
  /** convert form values to API params */
  params?: (v: Record<string, any>) => Record<string, any>;
  resultView?: (r: Record<string, any>, t: (k: string, v?: any) => string) => ReactNode;
  successText?: (r: Record<string, any>, t: (k: string, v?: any) => string) => string;
}

export const CATEGORIES = ["view", "edit", "convert", "organize", "ocr", "review", "compare", "protect", "watermark", "optimize", "forms", "advanced"];

const PAGES: FieldDef = { k: "pages", type: "pages", label: "f.pages", def: "", help: "f.pagesHelp" };

export const TOOLS: ToolDef[] = [
  // ---------------- view
  { id: "search", cat: "view", icon: Search, kind: "sidebar", needsDoc: true },
  { id: "outline", cat: "view", icon: BookMarked, kind: "sidebar", needsDoc: true },
  { id: "bookmarks", cat: "view", icon: Bookmark, kind: "custom", needsDoc: true, serverSide: true },
  { id: "properties", cat: "view", icon: Info, kind: "sidebar", needsDoc: true },
  { id: "attachments", cat: "view", icon: Paperclip, kind: "custom", needsDoc: true, serverSide: true },

  // ---------------- edit
  { id: "edit_text", cat: "edit", icon: TextCursorInput, kind: "custom", needsDoc: true, serverSide: true },
  { id: "add_content", cat: "edit", icon: Type, kind: "custom", needsDoc: true, serverSide: true },
  {
    id: "page_numbers", cat: "edit", icon: ListOrdered, kind: "schema", op: "header_footer", needsDoc: true, result: "replace", preview: true, serverSide: true, batch: true,
    fields: [
      { k: "number_format", type: "select", label: "f.numberFormat", def: "n", options: [["n", "1"], ["n_of", "1 / N"], ["page_n", "Page 1"], ["page_n_of", "Page 1 of N"], ["ar_n", "صفحة 1"], ["ar_n_of", "صفحة 1 من N"], ["dash", "- 1 -"]] },
      { k: "number_position", type: "select", label: "f.position", def: "bc", options: [["bc", "pos.bc"], ["br", "pos.br"], ["bl", "pos.bl"], ["tc", "pos.tc"], ["tr", "pos.tr"], ["tl", "pos.tl"]] },
      { k: "digits", type: "select", label: "f.digits", def: "latin", options: [["latin", "f.digitsLatin"], ["arabic", "f.digitsArabic"]] },
      { k: "start", type: "number", label: "f.startNumber", def: 1, min: 0, max: 100000 },
      { k: "skip_first", type: "checkbox", label: "f.skipFirst", def: false },
      { k: "exclude", type: "text", label: "f.exclude", def: "", placeholder: "2, 5-6" },
      PAGES,
      { k: "size", type: "number", label: "f.fontSize", def: 10, min: 5, max: 72 },
      { k: "family", type: "select", label: "f.font", def: "sans", options: [["sans", "font.sans"], ["serif", "font.serif"], ["mono", "font.mono"]] },
      { k: "color", type: "color", label: "f.color", def: "#333333" },
      { k: "margin_y", type: "number", label: "f.marginY", def: 28, min: 0, max: 200 },
      { k: "margin_x", type: "number", label: "f.marginX", def: 40, min: 0, max: 300 },
    ],
    params: (v) => ({ ...v, numbering: true }),
  },
  {
    id: "header_footer", cat: "edit", icon: PanelTop, kind: "schema", op: "header_footer", needsDoc: true, result: "replace", preview: true, serverSide: true, batch: true, presets: "hf",
    fields: [
      { k: "note", type: "note", label: "f.hfTokens" },
      { k: "tr", type: "text", label: "pos.tr", def: "" },
      { k: "tc", type: "text", label: "pos.tc", def: "" },
      { k: "tl", type: "text", label: "pos.tl", def: "" },
      { k: "br", type: "text", label: "pos.br", def: "" },
      { k: "bc", type: "text", label: "pos.bc", def: "" },
      { k: "bl", type: "text", label: "pos.bl", def: "" },
      { k: "title", type: "text", label: "f.docTitle", def: "" },
      { k: "date", type: "text", label: "f.date", def: "" , placeholder: "2025-01-31" },
      { k: "digits", type: "select", label: "f.digits", def: "latin", options: [["latin", "f.digitsLatin"], ["arabic", "f.digitsArabic"]] },
      { k: "start", type: "number", label: "f.startNumber", def: 1, min: 0, max: 100000 },
      { k: "skip_first", type: "checkbox", label: "f.skipFirst", def: false },
      PAGES,
      { k: "size", type: "number", label: "f.fontSize", def: 10, min: 5, max: 72 },
      { k: "bold", type: "checkbox", label: "f.bold", def: false },
      { k: "family", type: "select", label: "f.font", def: "sans", options: [["sans", "font.sans"], ["serif", "font.serif"], ["mono", "font.mono"]] },
      { k: "color", type: "color", label: "f.color", def: "#333333" },
      { k: "margin_y", type: "number", label: "f.marginY", def: 28, min: 0, max: 200 },
      { k: "margin_x", type: "number", label: "f.marginX", def: 40, min: 0, max: 300 },
    ],
    params: (v) => {
      const slots: Record<string, string> = {};
      for (const k of ["tl", "tc", "tr", "bl", "bc", "br"]) if (v[k]) slots[k] = v[k];
      const { tl, tc, tr, bl, bc, br, note, ...rest } = v;
      void tl; void tc; void tr; void bl; void bc; void br; void note;
      return { ...rest, slots };
    },
  },

  // ---------------- convert
  { id: "pdf_to_docx", cat: "convert", icon: FileText, op: "pdf_to_docx", kind: "schema", needsDoc: true, result: "download", serverSide: true, batch: true, fields: [PAGES, { k: "n", type: "note", label: "f.convertQuality" }] },
  { id: "pdf_to_xlsx", cat: "convert", icon: FileSpreadsheet, op: "pdf_to_xlsx", kind: "schema", needsDoc: true, result: "download", serverSide: true, batch: true, fields: [PAGES, { k: "sheet_per_table", type: "checkbox", label: "f.sheetPerTable", def: true }, { k: "n", type: "note", label: "f.convertQuality" }] },
  { id: "pdf_to_pptx", cat: "convert", icon: Presentation, op: "pdf_to_pptx", kind: "schema", needsDoc: true, result: "download", serverSide: true, batch: true, fields: [PAGES, { k: "mode", type: "select", label: "f.pptMode", def: "image", options: [["image", "f.pptImage"], ["editable", "f.pptEditable"]] }, { k: "dpi", type: "number", label: "f.dpi", def: 150, min: 72, max: 300, showIf: (v) => v.mode === "image" }] },
  { id: "pdf_to_images", cat: "convert", icon: FileImage, op: "pdf_to_images", kind: "schema", needsDoc: true, result: "download", serverSide: true, batch: true, fields: [PAGES, { k: "format", type: "select", label: "f.format", def: "png", options: [["png", "PNG"], ["jpg", "JPG"]] }, { k: "dpi", type: "range", label: "f.dpi", def: 150, min: 72, max: 600, step: 6 }, { k: "quality", type: "range", label: "f.quality", def: 88, min: 30, max: 100, showIf: (v) => v.format === "jpg" }] },
  { id: "pdf_to_text", cat: "convert", icon: FileType2, op: "pdf_to_text", kind: "schema", needsDoc: true, result: "download", serverSide: true, batch: true, fields: [PAGES, { k: "page_markers", type: "checkbox", label: "f.pageMarkers", def: true }] },
  { id: "pdf_to_csv", cat: "convert", icon: Table, op: "pdf_to_csv", kind: "schema", needsDoc: true, result: "download", serverSide: true, batch: true, fields: [PAGES] },
  { id: "extract_images", cat: "convert", icon: Images, op: "extract_images", kind: "schema", needsDoc: true, result: "download", serverSide: true, batch: true, fields: [PAGES, { k: "min_size", type: "number", label: "f.minImage", def: 32, min: 1, max: 5000 }] },
  { id: "convert_to_pdf", cat: "convert", icon: FileInput, kind: "standalone", needsDoc: false, serverSide: true },
  { id: "images_to_pdf", cat: "convert", icon: Image, kind: "standalone", needsDoc: false, serverSide: true },
  { id: "blank_pdf", cat: "convert", icon: FilePlus2, kind: "standalone", needsDoc: false, serverSide: true },

  // ---------------- organize
  { id: "organize", cat: "organize", icon: LayoutGrid, kind: "custom", needsDoc: true, serverSide: true },
  { id: "merge", cat: "organize", icon: Combine, kind: "standalone", needsDoc: false, serverSide: true },
  {
    id: "split", cat: "organize", icon: Scissors, op: "split", kind: "schema", needsDoc: true, result: "download", serverSide: true, batch: true,
    fields: [
      { k: "mode", type: "select", label: "f.splitMode", def: "ranges", options: [["ranges", "f.splitRanges"], ["every", "f.splitEvery"], ["each", "f.splitEach"], ["odd_even", "f.splitOddEven"]] },
      { k: "ranges", type: "text", label: "f.ranges", def: "", placeholder: "1-3; 4-10; 11-", help: "f.rangesHelp", showIf: (v) => v.mode === "ranges" },
      { k: "every", type: "number", label: "f.everyN", def: 2, min: 1, max: 10000, showIf: (v) => v.mode === "every" },
      { k: "names", type: "text", label: "f.outputNames", def: "", help: "f.outputNamesHelp", showIf: (v) => v.mode === "ranges" },
    ],
    params: (v) => ({ ...v, names: v.names ? String(v.names).split(/[;,؛،]/).map((s: string) => s.trim()) : [] }),
  },
  { id: "extract_pages", cat: "organize", icon: SquareStack, op: "extract_pages", kind: "schema", needsDoc: true, result: "download", serverSide: true, fields: [{ ...PAGES, def: "1" }, { k: "separate", type: "checkbox", label: "f.separateFiles", def: false }] },
  { id: "delete_pages", cat: "organize", icon: Trash2, op: "delete_pages", kind: "schema", needsDoc: true, result: "replace", confirm: "confirm.delete", serverSide: true, fields: [{ ...PAGES, def: "" }] },
  { id: "rotate", cat: "organize", icon: RotateCw, op: "rotate", kind: "schema", needsDoc: true, result: "replace", serverSide: true, batch: true, fields: [PAGES, { k: "angle", type: "select", label: "f.angle", def: "90", options: [["90", "90°"], ["180", "180°"], ["270", "270° (-90°)"]] }], params: (v) => ({ ...v, angle: Number(v.angle) }) },
  { id: "insert_blank", cat: "organize", icon: FilePlus2, op: "insert_blank", kind: "schema", needsDoc: true, result: "replace", serverSide: true, fields: [{ k: "after", type: "number", label: "f.insertAfter", def: 1, min: 0, max: 100000, help: "f.insertAfterHelp" }, { k: "count", type: "number", label: "f.count", def: 1, min: 1, max: 200 }, { k: "size", type: "select", label: "f.paper", def: "same", options: [["same", "f.sameSize"], ["a4", "A4"], ["letter", "Letter"], ["a3", "A3"], ["a5", "A5"], ["legal", "Legal"]] }] },
  { id: "remove_blank", cat: "organize", icon: FileX2, kind: "custom", needsDoc: true, serverSide: true, batch: true, op: "remove_blank" },

  // ---------------- ocr
  {
    id: "ocr", cat: "ocr", icon: ScanText, op: "ocr", kind: "schema", needsDoc: true, result: "replace", serverSide: true, batch: true,
    fields: [
      { k: "languages", type: "langs", label: "f.languages", def: ["ara", "eng"] },
      PAGES,
      { k: "dpi", type: "select", label: "f.dpi", def: "300", options: [["200", "200"], ["300", "300 (f.recommended)"], ["400", "400"]] },
      { k: "deskew", type: "checkbox", label: "f.deskew", def: true },
      { k: "contrast", type: "checkbox", label: "f.contrast", def: true },
      { k: "denoise", type: "checkbox", label: "f.denoise", def: false },
      { k: "binarize", type: "checkbox", label: "f.binarize", def: false },
      { k: "psm", type: "select", label: "f.layout", def: "3", options: [["3", "f.layoutAuto"], ["4", "f.layoutColumn"], ["6", "f.layoutBlock"], ["11", "f.layoutSparse"]] },
      { k: "force", type: "checkbox", label: "f.forceOcr", def: false, help: "f.forceOcrHelp" },
      { k: "text_output", type: "checkbox", label: "f.textOutput", def: false },
    ],
    params: (v) => ({ ...v, dpi: Number(v.dpi), psm: Number(v.psm) }),
  },

  // ---------------- review
  { id: "annotate", cat: "review", icon: MessageSquarePlus, kind: "custom", needsDoc: true, serverSide: true },
  { id: "signature", cat: "review", icon: PenLine, kind: "custom", needsDoc: true, serverSide: true },
  { id: "stamp", cat: "review", icon: Stamp, kind: "custom", needsDoc: true, serverSide: true },
  { id: "digital_sign", cat: "review", icon: BadgeCheck, kind: "custom", needsDoc: true, serverSide: true },
  { id: "verify_signatures", cat: "review", icon: FileCheck2, kind: "custom", needsDoc: true, serverSide: true },

  // ---------------- compare
  { id: "compare", cat: "compare", icon: Columns2, kind: "standalone", needsDoc: false, serverSide: true },

  // ---------------- protect
  {
    id: "protect", cat: "protect", icon: Lock, op: "protect", kind: "schema", needsDoc: true, result: "replace", serverSide: true, batch: true,
    fields: [
      { k: "user_password", type: "password", label: "f.userPassword", def: "", help: "f.userPasswordHelp" },
      { k: "owner_password", type: "password", label: "f.ownerPassword", def: "", help: "f.ownerPasswordHelp" },
      { k: "encryption", type: "select", label: "f.encryption", def: "aes256", options: [["aes256", "AES-256"], ["aes128", "AES-128"]] },
      { k: "p_print", type: "checkbox", label: "perm.print", def: true },
      { k: "p_copy", type: "checkbox", label: "perm.copy", def: true },
      { k: "p_modify", type: "checkbox", label: "perm.modify", def: true },
      { k: "p_annotate", type: "checkbox", label: "perm.annotate", def: true },
      { k: "p_forms", type: "checkbox", label: "perm.forms", def: true },
      { k: "p_assemble", type: "checkbox", label: "perm.assemble", def: true },
      { k: "n", type: "note", label: "f.protectNote" },
    ],
    params: (v) => ({ user_password: v.user_password, owner_password: v.owner_password, encryption: v.encryption,
      permissions: { print: v.p_print, copy: v.p_copy, modify: v.p_modify, annotate: v.p_annotate, forms: v.p_forms, assemble: v.p_assemble } }),
  },
  { id: "unprotect", cat: "protect", icon: Unlock, op: "unprotect", kind: "schema", needsDoc: true, result: "replace", serverSide: true, fields: [{ k: "note", type: "note", label: "f.unprotectNote" }, { k: "password", type: "password", label: "f.currentPassword", def: "" }] },
  { id: "redact", cat: "protect", icon: Eraser, kind: "custom", needsDoc: true, serverSide: true },
  {
    id: "sanitize", cat: "protect", icon: ShieldCheck, op: "sanitize", kind: "schema", needsDoc: true, result: "replace", serverSide: true, batch: true,
    fields: [
      { k: "metadata", type: "checkbox", label: "f.rmMetadata", def: true },
      { k: "javascript", type: "checkbox", label: "f.rmJs", def: true },
      { k: "attachments", type: "checkbox", label: "f.rmAttachments", def: true },
      { k: "thumbnails", type: "checkbox", label: "f.rmHidden", def: true },
      { k: "comments", type: "checkbox", label: "f.rmComments", def: false },
    ],
  },

  // ---------------- watermark & background
  {
    id: "watermark_add", cat: "watermark", icon: Droplets, op: "watermark_add", kind: "schema", needsDoc: true, result: "replace", preview: true, serverSide: true, batch: true, presets: "wm",
    fields: [
      { k: "type", type: "select", label: "f.wmType", def: "text", options: [["text", "f.wmText"], ["image", "f.wmImage"]] },
      { k: "text", type: "text", label: "f.text", def: "سري", showIf: (v) => v.type === "text" },
      { k: "image", type: "image", label: "f.image", showIf: (v) => v.type === "image" },
      { k: "scale", type: "range", label: "f.imageScale", def: 0.5, min: 0.05, max: 1, step: 0.05, showIf: (v) => v.type === "image" },
      { k: "size", type: "number", label: "f.fontSize", def: 60, min: 6, max: 400, showIf: (v) => v.type === "text" },
      { k: "family", type: "select", label: "f.font", def: "sans", options: [["sans", "font.sans"], ["serif", "font.serif"], ["mono", "font.mono"]], showIf: (v) => v.type === "text" },
      { k: "bold", type: "checkbox", label: "f.bold", def: true, showIf: (v) => v.type === "text" },
      { k: "color", type: "color", label: "f.color", def: "#d02020", showIf: (v) => v.type === "text" },
      { k: "opacity", type: "range", label: "f.opacity", def: 0.25, min: 0.05, max: 1, step: 0.05 },
      { k: "rotation", type: "range", label: "f.rotation", def: 45, min: -180, max: 180, step: 5, unit: "°" },
      { k: "position", type: "select", label: "f.position", def: "mc", options: [["mc", "pos.mc"], ["tc", "pos.tc"], ["bc", "pos.bc"], ["tl", "pos.tl"], ["tr", "pos.tr"], ["bl", "pos.bl"], ["br", "pos.br"], ["ml", "pos.ml"], ["mr", "pos.mr"]], showIf: (v) => !v.tile },
      { k: "tile", type: "checkbox", label: "f.tile", def: false },
      { k: "gap", type: "number", label: "f.tileGap", def: 60, min: 0, max: 500, showIf: (v) => v.tile },
      { k: "layer", type: "select", label: "f.layer", def: "over", options: [["over", "f.layerOver"], ["under", "f.layerUnder"]] },
      PAGES,
    ],
  },
  { id: "watermark_remove", cat: "watermark", icon: Layers, kind: "custom", needsDoc: true, serverSide: true },
  {
    id: "background_add", cat: "watermark", icon: PaintBucket, op: "background_add", kind: "schema", needsDoc: true, result: "replace", preview: true, serverSide: true, batch: true, presets: "bg",
    fields: [
      { k: "type", type: "select", label: "f.bgType", def: "color", options: [["color", "f.bgColor"], ["image", "f.bgImage"]] },
      { k: "color", type: "color", label: "f.color", def: "#fff6d8", showIf: (v) => v.type !== "image" },
      { k: "image", type: "image", label: "f.image", showIf: (v) => v.type === "image" },
      { k: "fit", type: "select", label: "f.fit", def: "cover", options: [["cover", "f.fitCover"], ["contain", "f.fitContain"], ["stretch", "f.fitStretch"], ["center", "f.fitCenter"]], showIf: (v) => v.type === "image" },
      { k: "opacity", type: "range", label: "f.opacity", def: 1, min: 0.05, max: 1, step: 0.05 },
      PAGES,
      { k: "n", type: "note", label: "f.bgNote" },
    ],
  },
  { id: "background_remove", cat: "watermark", icon: Eraser, op: "background_remove", kind: "schema", needsDoc: true, result: "replace", serverSide: true, batch: true, fields: [{ k: "n", type: "note", label: "f.bgRemoveNote" }, { k: "aggressive", type: "checkbox", label: "f.bgAggressive", def: false }] },

  // ---------------- optimize
  {
    id: "compress", cat: "optimize", icon: Minimize2, op: "compress", kind: "schema", needsDoc: true, result: "replace", serverSide: true, batch: true,
    fields: [
      { k: "level", type: "select", label: "f.level", def: "medium", options: [["light", "f.levelLight"], ["medium", "f.levelMedium"], ["strong", "f.levelStrong"]] },
      { k: "custom", type: "checkbox", label: "f.customImages", def: false },
      { k: "dpi", type: "range", label: "f.imageDpi", def: 150, min: 50, max: 300, step: 10, showIf: (v) => v.custom },
      { k: "quality", type: "range", label: "f.jpegQuality", def: 70, min: 20, max: 95, showIf: (v) => v.custom },
      { k: "grayscale", type: "checkbox", label: "f.grayscale", def: false },
      { k: "remove_metadata", type: "checkbox", label: "f.rmMetadata", def: false },
      { k: "linearize", type: "checkbox", label: "f.linearize", def: false },
    ],
    params: (v) => ({ level: v.level, grayscale: v.grayscale, remove_metadata: v.remove_metadata, linearize: v.linearize, ...(v.custom ? { dpi: v.dpi, quality: v.quality } : {}) }),
  },
  { id: "flatten", cat: "optimize", icon: ClipboardCheck, op: "flatten", kind: "schema", needsDoc: true, result: "replace", confirm: "confirm.flatten", serverSide: true, batch: true, fields: [{ k: "n", type: "note", label: "f.flattenNote" }] },

  // ---------------- forms
  { id: "forms_fill", cat: "forms", icon: FormInput, kind: "custom", needsDoc: true, serverSide: true },
  { id: "forms_create", cat: "forms", icon: PenTool, kind: "custom", needsDoc: true, serverSide: true },

  // ---------------- advanced
  { id: "inspect", cat: "advanced", icon: FileSearch, kind: "custom", needsDoc: true, serverSide: true },
  { id: "metadata", cat: "advanced", icon: FileCog, kind: "custom", needsDoc: true, serverSide: true },
  { id: "batch", cat: "advanced", icon: Workflow, kind: "standalone", needsDoc: false, serverSide: true },
];

export const VISIBLE_TOOLS = TOOLS;

export function toolById(id: string | null): ToolDef | undefined {
  return TOOLS.find((x) => x.id === id);
}

export const SIDEBAR_FOR: Record<string, "search" | "outline" | "info"> = { search: "search", outline: "outline", properties: "info" };
