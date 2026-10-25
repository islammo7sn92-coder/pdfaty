import { Suspense, lazy, useEffect, useMemo, useState, type ComponentType } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, Eye, Play, Server, X } from "lucide-react";
import { useT } from "../i18n";
import { confirmDialog, currentFile, docParams, runOnDoc, runOp } from "../lib/actions";
import { setOverlay } from "../lib/overlay";
import { getState, setState, toast, useStore } from "../lib/store";
import { formatBytes } from "../lib/utils";
import { Button, IconButton } from "./ui";
import { CATEGORIES, SIDEBAR_FOR, VISIBLE_TOOLS, toolById, type ToolDef } from "./tools/registry";
import { Outputs, PdfPreviewModal, Presets, SchemaForm, defaults, type OutFile } from "./tools/common";

const CUSTOM: Record<string, ComponentType> = {
  organize: lazy(() => import("./tools/Organize")),
  annotate: lazy(() => import("./tools/Annotate")),
  stamp: lazy(() => import("./tools/Annotate").then((m) => ({ default: m.StampTool }))),
  add_content: lazy(() => import("./tools/AddContent")),
  edit_text: lazy(() => import("./tools/EditText")),
  signature: lazy(() => import("./tools/Signature")),
  redact: lazy(() => import("./tools/Redact")),
  watermark_remove: lazy(() => import("./tools/WatermarkRemove")),
  forms_fill: lazy(() => import("./tools/Forms")),
  forms_create: lazy(() => import("./tools/Forms").then((m) => ({ default: m.FormsCreate }))),
  inspect: lazy(() => import("./tools/Inspect")),
  metadata: lazy(() => import("./tools/Metadata")),
  bookmarks: lazy(() => import("./tools/Metadata").then((m) => ({ default: m.Bookmarks }))),
  attachments: lazy(() => import("./tools/Metadata").then((m) => ({ default: m.AttachmentsTool }))),
  remove_blank: lazy(() => import("./tools/Organize").then((m) => ({ default: m.RemoveBlank }))),
  digital_sign: lazy(() => import("./tools/DigitalSign")),
  verify_signatures: lazy(() => import("./tools/DigitalSign").then((m) => ({ default: m.VerifySignatures }))),
};

export function openTool(id: string): void {
  const tool = toolById(id);
  if (!tool) return;
  if (tool.kind === "standalone") {
    setState({ route: "standalone", standalone: id, tool: null });
    return;
  }
  if (tool.kind === "sidebar") {
    setState({ sidebar: SIDEBAR_FOR[id] ?? "info", tool: null });
    return;
  }
  setState({ tool: id, panelOpen: true });
}

export default function ToolPanel() {
  const open = useStore((s) => s.panelOpen);
  const toolId = useStore((s) => s.tool);
  const t = useT();
  const tool = toolById(toolId);
  // tools register overlays; make sure nothing stays active when switching
  useEffect(() => () => setOverlay(null), [toolId]);
  if (!open) return null;
  return (
    <aside className="toolpanel" aria-label={t("panel.label")}>
      {tool ? <ToolHost tool={tool} /> : <ToolList />}
    </aside>
  );
}

function ToolList() {
  const t = useT();
  const [openCat, setOpenCat] = useState<string | null>("edit");
  return (
    <div className="toollist">
      <div className="panel-head">
        <h2>{t("panel.tools")}</h2>
        <IconButton label={t("common.close")} onClick={() => setState({ panelOpen: false })}><X size={18} /></IconButton>
      </div>
      {CATEGORIES.map((c) => (
        <div key={c} className="cat">
          <button type="button" className="cat-head" aria-expanded={openCat === c} onClick={() => setOpenCat(openCat === c ? null : c)}>
            <span>{t(`cat.${c}`)}</span>
            <ChevronDown size={16} className={openCat === c ? "rot" : ""} />
          </button>
          {openCat === c && (
            <div className="cat-tools">
              {VISIBLE_TOOLS.filter((x) => x.cat === c).map((x) => (
                <button key={x.id} type="button" className="tool-item" onClick={() => openTool(x.id)}>
                  <x.icon size={18} />
                  <span>{t(`tool.${x.id}`)}</span>
                  {x.serverSide && <span title={t("panel.serverSide")} aria-label={t("panel.serverSide")} className="srv"><Server size={12} /></span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      <p className="muted small pad">{t("panel.serverHint")}</p>
    </div>
  );
}

function ToolHost({ tool }: { tool: ToolDef }) {
  const t = useT();
  const rtl = useStore((s) => s.lang) === "ar";
  const Custom = CUSTOM[tool.id];
  return (
    <div className="toolhost">
      <div className="panel-head">
        <IconButton label={t("common.back")} onClick={() => setState({ tool: null })}>{rtl ? <ArrowRight size={18} /> : <ArrowLeft size={18} />}</IconButton>
        <h2><tool.icon size={18} /> {t(`tool.${tool.id}`)}</h2>
        <IconButton label={t("common.close")} onClick={() => setState({ tool: null, panelOpen: false })}><X size={18} /></IconButton>
      </div>
      <p className="tool-desc">{t(`desc.${tool.id}`)}</p>
      {tool.kind === "schema" && <SchemaTool tool={tool} key={tool.id} />}
      {Custom && (
        <Suspense fallback={<div className="muted small pad">{t("common.loading")}</div>}>
          <Custom key={tool.id} />
        </Suspense>
      )}
    </div>
  );
}

function SchemaTool({ tool }: { tool: ToolDef }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const page = useStore((s) => s.page);
  const [values, setValues] = useState<Record<string, any>>(() => defaults(tool.fields ?? []));
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [outs, setOuts] = useState<OutFile[]>([]);
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const [preview, setPreview] = useState<Blob | null>(null);

  const build = () => {
    const extra = Object.values(files).filter(Boolean).map((f) => ({ name: f!.name, data: f! }));
    let p = tool.params ? tool.params(values) : { ...values };
    p = Object.fromEntries(Object.entries(p).filter(([k]) => k !== "n" && k !== "note"));
    if (extra.length) p.image_index = 1;
    return { params: docParams(p), extra };
  };
  const validate = (): boolean => {
    for (const f of tool.fields ?? []) {
      if (f.type === "image" && (!f.showIf || f.showIf(values)) && !files[f.k]) {
        toast("warning", t("err.image_required"));
        return false;
      }
    }
    return true;
  };

  const apply = async () => {
    if (!validate()) return;
    if (tool.confirm && !(await confirmDialog(t(`tool.${tool.id}`), t(tool.confirm), true))) return;
    const { params, extra } = build();
    const label = t(`tool.${tool.id}`);
    setOuts([]);
    setResult(null);
    if (tool.result === "replace") {
      const before = getState().doc?.bytes.byteLength ?? 0;
      const res = await runOnDoc(tool.op!, params, label, extra);
      if (!res) return;
      setResult(res.result);
      if (tool.op === "compress") {
        const r = res.result;
        toast(r.kept_original ? "info" : "success", r.kept_original ? t("compress.kept") : t("compress.done", { before: formatBytes(r.before, lang), after: formatBytes(r.after, lang), ratio: r.ratio }));
      } else toast("success", t("done.applied", { tool: label }));
      void before;
    } else {
      const f = currentFile();
      if (!f) return;
      const res = await runOp(tool.op!, [f, ...extra], params, label);
      if (!res) return;
      setOuts(res.files);
      setResult(res.result);
      toast("success", t("done.ready"));
    }
  };

  const doPreview = async () => {
    if (!validate()) return;
    const { params, extra } = build();
    const f = currentFile();
    if (!f) return;
    const res = await runOp(tool.op!, [f, ...extra], { ...params, preview_page: page }, t("common.preview"));
    if (res?.files[0]) setPreview(res.files[0].blob);
  };

  return (
    <div>
      <SchemaForm fields={tool.fields ?? []} values={values} onChange={setValues} files={files} onFile={(k, f) => setFiles({ ...files, [k]: f })} />
      {tool.presets && <Presets id={tool.presets} values={values} onLoad={(v) => setValues({ ...defaults(tool.fields ?? []), ...v })} />}
      <div className="tool-actions">
        {tool.preview && <Button icon={<Eye size={16} />} onClick={doPreview}>{t("common.previewPage", { n: page + 1 })}</Button>}
        <Button variant="primary" icon={<Play size={16} />} onClick={apply}>{t(tool.result === "replace" ? "common.apply" : "common.run")}</Button>
      </div>
      {tool.result === "replace" && <p className="muted small">{t("panel.undoHint")}</p>}
      {result && <ResultSummary tool={tool} result={result} />}
      <Outputs files={outs} />
      <PdfPreviewModal blob={preview} onClose={() => setPreview(null)} title={t("common.preview")} />
    </div>
  );
}

function ResultSummary({ tool, result }: { tool: ToolDef; result: Record<string, any> }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const rows = useMemo(() => {
    const r: string[] = [];
    if (tool.op === "ocr") {
      r.push(t("ocr.summary", { n: result.pages_ocr, langs: result.languages }));
      if (result.skipped_pages?.length) r.push(t("ocr.skipped", { pages: result.skipped_pages.join(", ") }));
      if (result.low_confidence_pages?.length) r.push(t("ocr.low", { pages: result.low_confidence_pages.join(", ") }));
      for (const s of result.stats ?? []) r.push(t("ocr.pageStat", { p: s.page + 1, w: s.words, c: s.confidence }));
    }
    if (tool.op === "compress") {
      r.push(t("compress.sizes", { before: formatBytes(result.before, lang), after: formatBytes(result.after, lang), ratio: result.ratio }));
      if (result.images) r.push(t("compress.images", { n: result.images.recompressed ?? 0, total: result.images.images ?? 0 }));
      if (result.kept_original) r.push(t("compress.kept"));
    }
    if (tool.op === "pdf_to_docx" && result.scanned_pages?.length) r.push(t("convert.scanned", { pages: result.scanned_pages.join(", ") }));
    if (tool.op === "pdf_to_text" && result.pages_without_text?.length) r.push(t("convert.noText", { pages: result.pages_without_text.join(", ") }));
    if (tool.op === "pdf_to_xlsx") r.push(t("convert.tables", { n: result.tables ?? 0 }));
    if (tool.op === "protect" && result.owner_password_generated) r.push(t("protect.ownerGenerated"));
    if (tool.op === "background_remove" || tool.op === "watermark_remove") r.push(t("layers.removed", { n: Object.values(result.removed ?? {}).reduce((a: number, b: any) => a + Number(b), 0) }));
    return r;
  }, [result, tool, lang]);
  if (!rows.length) return null;
  const warn = tool.op === "ocr" && result.low_confidence_pages?.length;
  return (
    <div className={`result-box ${warn ? "warn" : ""}`}>
      {rows.map((x, i) => <p key={i}>{x}</p>)}
    </div>
  );
}
