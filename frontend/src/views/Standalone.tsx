import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronLeft, ChevronRight, FileDown, FolderDown, GripVertical, Play, Plus, RefreshCw, Save, Trash2, Upload } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useT } from "../i18n";
import { errorText } from "../i18n";
import { ApiError, runJob } from "../lib/api";
import { openBytes, runOp } from "../lib/actions";
import { openPdf } from "../lib/pdf";
import { getState, setState, toast, useStore } from "../lib/store";
import { cls, downloadBlob, formatBytes, stem, storage, uid, zipFiles } from "../lib/utils";
import { Badge, Button, DropZone, Field, IconButton, Progress, Segmented } from "../components/ui";
import { Outputs, SchemaForm, defaults, type OutFile } from "../components/tools/common";
import { TOOLS, toolById } from "../components/tools/registry";
import Header from "./Header";

export default function Standalone() {
  const id = useStore((s) => s.standalone);
  const t = useT();
  const rtl = useStore((s) => s.lang) === "ar";
  const tool = toolById(id);
  const back = () => setState({ route: getState().doc ? "workspace" : "home", standalone: null });
  return (
    <div className="standalone">
      <Header />
      <main id="main" className="sa-main">
        <div className="sa-head">
          <IconButton label={t("common.back")} onClick={back}>{rtl ? <ArrowRight size={20} /> : <ArrowLeft size={20} />}</IconButton>
          {tool && <h1><tool.icon size={22} /> {t(`tool.${tool.id}`)}</h1>}
        </div>
        {tool && <p className="tool-desc">{t(`desc.${tool.id}`)}</p>}
        {id === "merge" && <Merge />}
        {id === "convert_to_pdf" && <ConvertToPdf />}
        {id === "images_to_pdf" && <ImagesToPdf />}
        {id === "blank_pdf" && <BlankPdf />}
        {id === "compare" && <Compare />}
        {id === "batch" && <Batch />}
      </main>
    </div>
  );
}

// ------------------------------------------------------------------ shared file list
interface FItem { id: string; file: File; range?: string; name?: string; password?: string }

function FileList({ items, setItems, showRange, showName, accept, label }: { items: FItem[]; setItems: (f: FItem[]) => void; showRange?: boolean; showName?: boolean; accept: string; label?: string }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const [drag, setDrag] = useState<string | null>(null);
  const add = (fs: File[]) => setItems([...items, ...fs.map((file) => ({ id: uid(), file }))]);
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= items.length) return; const n = items.slice(); [n[i], n[j]] = [n[j], n[i]]; setItems(n); };
  const drop = (target: string) => {
    if (!drag || drag === target) return;
    const from = items.findIndex((x) => x.id === drag), to = items.findIndex((x) => x.id === target);
    const n = items.slice();
    const [m] = n.splice(from, 1);
    n.splice(to, 0, m);
    setItems(n);
    setDrag(null);
  };
  return (
    <div className="filelist">
      <DropZone onFiles={add} multiple accept={accept} compact={items.length > 0} label={label} />
      {items.length > 0 && (
        <ol>
          {items.map((it, i) => (
            <li key={it.id} draggable onDragStart={() => setDrag(it.id)} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(it.id)} className={cls(drag === it.id && "dragging")}>
              <GripVertical size={16} className="grip" aria-hidden />
              <span className="fl-n">{i + 1}</span>
              <div className="grow">
                <div dir="auto" className="fl-name">{it.file.name}</div>
                <div className="muted small">{formatBytes(it.file.size, lang)}</div>
                <div className="row wrap">
                  {showRange && <input className="input" dir="ltr" placeholder={t("merge.rangePh")} value={it.range ?? ""} onChange={(e) => setItems(items.map((x) => (x.id === it.id ? { ...x, range: e.target.value } : x)))} aria-label={t("f.pages")} />}
                  {showName && <input className="input" dir="auto" placeholder={stem(it.file.name)} value={it.name ?? ""} onChange={(e) => setItems(items.map((x) => (x.id === it.id ? { ...x, name: e.target.value } : x)))} aria-label={t("f.outputName")} />}
                  <input className="input pw-input" type="password" autoComplete="off" placeholder={t("merge.pwPh")} value={it.password ?? ""} onChange={(e) => setItems(items.map((x) => (x.id === it.id ? { ...x, password: e.target.value } : x)))} aria-label={t("pw.label")} hidden={!it.file.name.toLowerCase().endsWith(".pdf")} />
                </div>
              </div>
              <IconButton label={t("bm.up")} onClick={() => move(i, -1)}><ArrowUp size={15} /></IconButton>
              <IconButton label={t("bm.down")} onClick={() => move(i, 1)}><ArrowDown size={15} /></IconButton>
              <IconButton label={t("common.delete")} onClick={() => setItems(items.filter((x) => x.id !== it.id))}><Trash2 size={15} /></IconButton>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function useCurrentAsFile(): FItem | null {
  const d = useStore((s) => s.doc);
  return useMemo(() => (d ? { id: "current", file: new File([d.bytes], d.name, { type: "application/pdf" }), password: d.password } : null), [d?.version, d?.id]);
}

// ------------------------------------------------------------------ merge
function Merge() {
  const t = useT();
  const cur = useCurrentAsFile();
  const [items, setItems] = useState<FItem[]>(() => (cur ? [cur] : []));
  const [name, setName] = useState("merged");
  const [bookmarks, setBookmarks] = useState(true);
  const [outs, setOuts] = useState<OutFile[]>([]);
  const run = async () => {
    if (items.length < 2) { toast("info", t("err.need_two_pdfs")); return; }
    const res = await runOp("merge", items.map((i) => ({ name: i.file.name, data: i.file })), {
      ranges: items.map((i) => i.range || ""), passwords: items.map((i) => i.password || ""), bookmarks, output_name: name || "merged",
    }, t("tool.merge"));
    if (res) { setOuts(res.files); toast("success", t("done.ready")); }
  };
  return (
    <div className="sa-body">
      <FileList items={items} setItems={setItems} showRange accept=".pdf,application/pdf" label={t("merge.drop")} />
      <div className="sa-opts">
        <Field label={t("f.outputName")}><input className="input" dir="auto" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <label className="check"><input type="checkbox" checked={bookmarks} onChange={(e) => setBookmarks(e.target.checked)} />{t("merge.bookmarks")}</label>
        <Button variant="primary" icon={<Play size={16} />} onClick={run} disabled={items.length < 2}>{t("merge.run", { n: items.length })}</Button>
      </div>
      <Outputs files={outs} />
    </div>
  );
}

// ------------------------------------------------------------------ convert to pdf
function ConvertToPdf() {
  const t = useT();
  const [items, setItems] = useState<FItem[]>([]);
  const [combine, setCombine] = useState(false);
  const [pdfa, setPdfa] = useState(false);
  const [name, setName] = useState("combined");
  const [outs, setOuts] = useState<OutFile[]>([]);
  const run = async () => {
    if (!items.length) return;
    const res = await runOp("convert_to_pdf", items.map((i) => ({ name: i.file.name, data: i.file })), {
      combine, pdfa, output_name: name, names: items.map((i) => i.name || ""), passwords: items.map((i) => i.password || ""),
    }, t("tool.convert_to_pdf"));
    if (res) { setOuts(res.files); toast("success", t("done.ready")); }
  };
  return (
    <div className="sa-body">
      <FileList items={items} setItems={setItems} showName={!combine} accept=".docx,.doc,.odt,.rtf,.xlsx,.xls,.ods,.csv,.pptx,.ppt,.odp,.odg,.vsd,.vsdx,.txt,.md,.html,.htm,.svg,.png,.jpg,.jpeg,.gif,.bmp,.tif,.tiff,.webp,.pdf" label={t("conv.drop")} />
      <p className="muted small">{t("conv.formats")}</p>
      <div className="sa-opts">
        <label className="check"><input type="checkbox" checked={combine} onChange={(e) => setCombine(e.target.checked)} />{t("conv.combine")}</label>
        {combine && <Field label={t("f.outputName")}><input className="input" dir="auto" value={name} onChange={(e) => setName(e.target.value)} /></Field>}
        <label className="check"><input type="checkbox" checked={pdfa} onChange={(e) => setPdfa(e.target.checked)} />{t("conv.pdfa")}</label>
        <Button variant="primary" icon={<Play size={16} />} onClick={run} disabled={!items.length}>{t("common.run")}</Button>
      </div>
      <p className="muted small">{t("conv.note")}</p>
      <Outputs files={outs} />
    </div>
  );
}

// ------------------------------------------------------------------ images to pdf
function ImagesToPdf() {
  const t = useT();
  const [items, setItems] = useState<FItem[]>([]);
  const [opts, setOpts] = useState({ size: "a4", orientation: "auto", margin: 0, enhance: false, separate: false, ocr: false, output_name: "images" });
  const [outs, setOuts] = useState<OutFile[]>([]);
  const run = async () => {
    if (!items.length) return;
    const files = items.map((i) => ({ name: i.file.name, data: i.file }));
    const res = await runOp("images_to_pdf", files, opts, t("tool.images_to_pdf"));
    if (!res) return;
    let out = res.files;
    if (opts.ocr && !opts.separate) {
      const pdf = res.files.find((f) => f.mime === "application/pdf");
      if (pdf) {
        const r2 = await runOp("ocr", [{ name: pdf.name, data: pdf.blob }], { languages: ["ara", "eng"], deskew: true }, t("tool.ocr"));
        if (r2) out = r2.files;
      }
    }
    setOuts(out);
    toast("success", t("done.ready"));
  };
  return (
    <div className="sa-body">
      <FileList items={items} setItems={setItems} accept="image/*" label={t("img.drop")} />
      <div className="sa-opts">
        <Field label={t("f.paper")}>
          <select className="input" value={opts.size} onChange={(e) => setOpts({ ...opts, size: e.target.value })}>
            <option value="fit">{t("img.fit")}</option><option value="a4">A4</option><option value="letter">Letter</option><option value="a3">A3</option><option value="a5">A5</option><option value="legal">Legal</option>
          </select>
        </Field>
        <Field label={t("img.orientation")}>
          <select className="input" value={opts.orientation} onChange={(e) => setOpts({ ...opts, orientation: e.target.value })}>
            <option value="auto">{t("img.auto")}</option><option value="portrait">{t("img.portrait")}</option><option value="landscape">{t("img.landscape")}</option>
          </select>
        </Field>
        <Field label={t("img.margin")}><input className="input small-num" type="number" min={0} max={100} value={opts.margin} onChange={(e) => setOpts({ ...opts, margin: Number(e.target.value) })} /></Field>
        <label className="check"><input type="checkbox" checked={opts.enhance} onChange={(e) => setOpts({ ...opts, enhance: e.target.checked })} />{t("img.enhance")}</label>
        <label className="check"><input type="checkbox" checked={opts.ocr} onChange={(e) => setOpts({ ...opts, ocr: e.target.checked })} />{t("img.ocr")}</label>
        <label className="check"><input type="checkbox" checked={opts.separate} onChange={(e) => setOpts({ ...opts, separate: e.target.checked })} />{t("img.separate")}</label>
        <Button variant="primary" icon={<Play size={16} />} onClick={run} disabled={!items.length}>{t("common.run")}</Button>
      </div>
      <Outputs files={outs} />
    </div>
  );
}

// ------------------------------------------------------------------ blank
function BlankPdf() {
  const t = useT();
  const [o, setO] = useState({ size: "a4", orientation: "portrait", count: 1, title: "" });
  const run = async () => {
    const res = await runOp("blank_pdf", [], o, t("tool.blank_pdf"));
    if (res?.files[0]) await openBytes(new Uint8Array(await res.files[0].blob.arrayBuffer()), (o.title || "blank") + ".pdf");
  };
  return (
    <div className="sa-body narrow">
      <Field label={t("f.paper")}><select className="input" value={o.size} onChange={(e) => setO({ ...o, size: e.target.value })}><option value="a4">A4</option><option value="letter">Letter</option><option value="a3">A3</option><option value="a5">A5</option><option value="legal">Legal</option></select></Field>
      <Field label={t("img.orientation")}><select className="input" value={o.orientation} onChange={(e) => setO({ ...o, orientation: e.target.value })}><option value="portrait">{t("img.portrait")}</option><option value="landscape">{t("img.landscape")}</option></select></Field>
      <Field label={t("f.count")}><input className="input small-num" type="number" min={1} max={500} value={o.count} onChange={(e) => setO({ ...o, count: Number(e.target.value) })} /></Field>
      <Field label={t("props.title")}><input className="input" dir="auto" value={o.title} onChange={(e) => setO({ ...o, title: e.target.value })} /></Field>
      <Button variant="primary" onClick={run}>{t("blank.create")}</Button>
      <p className="muted small">{t("blank.after")}</p>
    </div>
  );
}

// ------------------------------------------------------------------ compare
interface Change { type: "added" | "removed" | "changed"; old: string; new: string; old_page: number; new_page: number; old_boxes: number[][]; new_boxes: number[][]; categories: string[]; important: boolean; context: string }

function Compare() {
  const t = useT();
  const cur = useCurrentAsFile();
  const lang = useStore((s) => s.lang);
  const [a, setA] = useState<FItem | null>(cur);
  const [b, setB] = useState<FItem | null>(null);
  const [opts, setOpts] = useState({ mode: "contract", only_important: false, ignore_case: true, ocr: true });
  const [res, setRes] = useState<{ changes: Change[]; summary: Record<string, number>; similarity: number; important: number; total: number } | null>(null);
  const [report, setReport] = useState<OutFile | null>(null);
  const [filter, setFilter] = useState<"all" | "important" | "added" | "removed" | "changed">("all");
  const [idx, setIdx] = useState(0);
  const [docs, setDocs] = useState<[PDFDocumentProxy, PDFDocumentProxy] | null>(null);

  const run = async () => {
    if (!a || !b) return;
    const r = await runOp("compare", [{ name: a.file.name, data: a.file }, { name: b.file.name, data: b.file }], { ...opts, lang, passwords: [a.password || "", b.password || ""] }, t("tool.compare"));
    if (!r) return;
    setRes(r.result as any);
    setReport(r.files[0] ?? null);
    setIdx(0);
    try {
      const da = await openPdf(new Uint8Array(await a.file.arrayBuffer()), a.password);
      const db = await openPdf(new Uint8Array(await b.file.arrayBuffer()), b.password);
      setDocs([da, db]);
    } catch { setDocs(null); }
  };
  const list = useMemo(() => (res?.changes ?? []).filter((c) => filter === "all" || (filter === "important" ? c.important : c.type === filter)), [res, filter]);
  const ch = list[idx];
  const pick = (setter: (f: FItem) => void) => (fs: File[]) => setter({ id: uid(), file: fs[0] });
  const rtl = lang === "ar";

  return (
    <div className="sa-body">
      <div className="cmp-pick">
        <div>
          <h3>{t("cmp.original")}</h3>
          {a ? <div className="picked"><span dir="auto">{a.file.name}</span><IconButton label={t("common.delete")} onClick={() => setA(null)}><Trash2 size={14} /></IconButton></div>
            : <DropZone onFiles={pick(setA)} accept=".pdf,application/pdf" compact label={t("cmp.dropA")} />}
        </div>
        <div>
          <h3>{t("cmp.revised")}</h3>
          {b ? <div className="picked"><span dir="auto">{b.file.name}</span><IconButton label={t("common.delete")} onClick={() => setB(null)}><Trash2 size={14} /></IconButton></div>
            : <DropZone onFiles={pick(setB)} accept=".pdf,application/pdf" compact label={t("cmp.dropB")} />}
        </div>
      </div>
      <div className="sa-opts">
        <Segmented label={t("cmp.mode")} value={opts.mode} onChange={(m) => setOpts({ ...opts, mode: m })} options={[{ value: "general", label: t("cmp.general") }, { value: "contract", label: t("cmp.contract") }]} />
        <label className="check"><input type="checkbox" checked={opts.only_important} onChange={(e) => setOpts({ ...opts, only_important: e.target.checked })} />{t("cmp.onlyImportant")}</label>
        <label className="check"><input type="checkbox" checked={opts.ignore_case} onChange={(e) => setOpts({ ...opts, ignore_case: e.target.checked })} />{t("cmp.ignoreCase")}</label>
        <label className="check"><input type="checkbox" checked={opts.ocr} onChange={(e) => setOpts({ ...opts, ocr: e.target.checked })} />{t("cmp.ocr")}</label>
        <Button variant="primary" icon={<Play size={16} />} onClick={run} disabled={!a || !b}>{t("cmp.run")}</Button>
      </div>
      <p className="note">{t("cmp.disclaimer")}</p>
      {res && (
        <div className="cmp-results">
          <div className="cmp-summary">
            <Badge kind="info">{t("cmp.similarity", { n: res.similarity })}</Badge>
            <Badge kind="pass">{t("cmp.added", { n: res.summary.added })}</Badge>
            <Badge kind="fail">{t("cmp.removed", { n: res.summary.removed })}</Badge>
            <Badge kind="warn">{t("cmp.changed", { n: res.summary.changed })}</Badge>
            <Badge kind="warn">{t("cmp.important", { n: res.important })}</Badge>
            {report && <Button small icon={<FileDown size={14} />} onClick={() => downloadBlob(report.blob, report.name)}>{t("cmp.report")}</Button>}
          </div>
          {res.total === 0 && <p className="ok-text">{t("cmp.identical")}</p>}
          <div className="cmp-layout">
            <div className="cmp-list">
              <select className="input" value={filter} onChange={(e) => { setFilter(e.target.value as any); setIdx(0); }} aria-label={t("cmp.filter")}>
                <option value="all">{t("cmp.fAll")}</option><option value="important">{t("cmp.fImportant")}</option><option value="added">{t("cmp.fAdded")}</option><option value="removed">{t("cmp.fRemoved")}</option><option value="changed">{t("cmp.fChanged")}</option>
              </select>
              <ol>
                {list.slice(0, 1000).map((c, i) => (
                  <li key={i}>
                    <button type="button" className={cls("cmp-item", `t-${c.type}`, i === idx && "on")} onClick={() => setIdx(i)}>
                      <span className="small">{t(`cmp.t.${c.type}`)} · {t("cmp.pages", { a: c.old_page + 1, b: c.new_page + 1 })}{c.categories.length ? ` · ${c.categories.map((x) => t(`cmp.cat.${x}`)).join("، ")}` : ""}</span>
                      {c.old && <del dir="auto">{c.old}</del>}
                      {c.new && <ins dir="auto">{c.new}</ins>}
                    </button>
                  </li>
                ))}
              </ol>
            </div>
            <div className="cmp-visual">
              <div className="row">
                <IconButton label={t("search.prev")} onClick={() => setIdx(Math.max(0, idx - 1))} disabled={idx <= 0}>{rtl ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}</IconButton>
                <span>{list.length ? `${idx + 1} / ${list.length}` : "0"}</span>
                <IconButton label={t("search.next")} onClick={() => setIdx(Math.min(list.length - 1, idx + 1))} disabled={idx >= list.length - 1}>{rtl ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}</IconButton>
              </div>
              {docs && ch && (
                <div className="cmp-pages">
                  <ComparePage pdf={docs[0]} page={ch.old_page} boxes={ch.old_boxes} color="rgba(220,30,30,.35)" label={t("cmp.original")} />
                  <ComparePage pdf={docs[1]} page={ch.new_page} boxes={ch.new_boxes} color="rgba(20,160,70,.35)" label={t("cmp.revised")} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ComparePage({ pdf, page, boxes, color, label }: { pdf: PDFDocumentProxy; page: number; boxes: number[][]; color: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [dim, setDim] = useState<{ w: number; h: number; s: number } | null>(null);
  useEffect(() => {
    let task: any;
    (async () => {
      if (page >= pdf.numPages) return;
      const p = await pdf.getPage(page + 1);
      const base = p.getViewport({ scale: 1 });
      const s = 460 / base.width;
      const dpr = Math.min(2, devicePixelRatio || 1);
      const vp = p.getViewport({ scale: s * dpr });
      const c = document.createElement("canvas");
      c.width = vp.width; c.height = vp.height;
      c.style.width = "100%"; c.style.height = "100%";
      setDim({ w: base.width * s, h: base.height * s, s });
      task = p.render({ canvasContext: c.getContext("2d")!, canvas: c, viewport: vp });
      await task.promise;
      ref.current?.replaceChildren(c);
    })().catch(() => undefined);
    return () => task?.cancel?.();
  }, [pdf, page]);
  useEffect(() => {
    const first = boxes.find((b) => b[0] === page);
    if (first && dim && ref.current?.parentElement?.parentElement) ref.current.parentElement.parentElement.scrollTop = Math.max(0, first[2] * dim.s - 80);
  }, [boxes, dim, page]);
  return (
    <figure className="cmp-page">
      <figcaption>{label} — {page + 1}</figcaption>
      <div className="cmp-canvas" style={{ maxHeight: 640 }}>
        <div style={{ position: "relative", width: dim?.w, height: dim?.h }}>
          <div ref={ref} style={{ width: dim?.w, height: dim?.h }} />
          {dim && boxes.filter((b) => b[0] === page).map((b, i) => (
            <div key={i} className="cmp-box" style={{ left: b[1] * dim.s - 1, top: b[2] * dim.s - 1, width: b[3] * dim.s + 2, height: b[4] * dim.s + 2, background: color }} />
          ))}
        </div>
      </div>
    </figure>
  );
}

// ------------------------------------------------------------------ batch
interface Step { tool: string; params: Record<string, any> }
interface Saved { name: string; steps: Step[] }
interface BRow { id: string; file: File; status: "pending" | "running" | "done" | "error"; error?: string; outputs: OutFile[]; pct: number }

const BATCH_TOOLS = TOOLS.filter((x) => x.batch);
const MAX_BATCH = 50;

function Batch() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const [rows, setRows] = useState<BRow[]>([]);
  const [steps, setSteps] = useState<Step[]>([{ tool: "compress", params: defaults(toolById("compress")!.fields!) }]);
  const [saved, setSaved] = useState<Saved[]>(() => storage.get("pdfaty.actions", []));
  const [name, setName] = useState("");
  const [running, setRunning] = useState(false);
  const stop = useRef(false);
  const rowsRef = useRef<BRow[]>([]);
  rowsRef.current = rows;

  const add = (fs: File[]) => {
    const pdfs = fs.filter((f) => f.name.toLowerCase().endsWith(".pdf") || f.type === "application/pdf");
    if (pdfs.length < fs.length) toast("warning", t("batch.onlyPdf"));
    const n = [...rows, ...pdfs.map((file) => ({ id: uid(), file, status: "pending" as const, outputs: [], pct: 0 }))];
    if (n.length > MAX_BATCH) toast("warning", t("batch.limit", { n: MAX_BATCH }));
    setRows(n.slice(0, MAX_BATCH));
  };
  const patch = (id: string, p: Partial<BRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  const processRow = async (row: BRow) => {
    patch(row.id, { status: "running", error: undefined, outputs: [], pct: 0 });
    let current: OutFile = { name: row.file.name, mime: "application/pdf", blob: row.file };
    let outputs: OutFile[] = [];
    try {
      for (let k = 0; k < steps.length; k++) {
        const s = steps[k];
        const def = toolById(s.tool)!;
        const params = def.params ? def.params(s.params) : { ...s.params };
        delete params.n; delete params.note;
        const r = await runJob(def.op!, [{ name: current.name, data: current.blob }], params, {
          onProgress: (pct) => patch(row.id, { pct: ((k + pct / 100) / steps.length) * 100 }),
        });
        const pdf = r.files.find((f) => f.mime === "application/pdf" && !/preview/.test(f.name));
        if (def.result === "replace" && pdf) current = { ...pdf, name: row.file.name };
        else { outputs = r.files; if (k < steps.length - 1) throw new ApiError("batch_step_not_pdf"); }
      }
      if (!outputs.length) outputs = [current];
      patch(row.id, { status: "done", outputs, pct: 100 });
    } catch (e) {
      patch(row.id, { status: "error", error: errorText(e instanceof ApiError ? e.code : "network_error", e instanceof ApiError ? e.detail : null) });
    }
  };

  const runAll = async (only?: (r: BRow) => boolean) => {
    setRunning(true);
    stop.current = false;
    const queue = rowsRef.current.filter(only ?? ((r) => r.status !== "done"));
    const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (queue.length && !stop.current) await processRow(queue.shift()!);
    });
    await Promise.all(workers);
    setRunning(false);
  };

  const allOutputs = rows.flatMap((r) => r.outputs.filter((o) => o.mime !== "application/zip").map((o) => ({ ...o, name: rows.filter((x) => x.file.name === r.file.name).length > 1 ? `${stem(r.file.name)}-${r.id.slice(0, 4)}_${o.name}` : o.name })));
  const saveFolder = async () => {
    const w = window as any;
    if (!w.showDirectoryPicker) { downloadBlob(await zipFiles(allOutputs), "pdfaty-batch.zip"); return; }
    try {
      const dir = await w.showDirectoryPicker({ mode: "readwrite" });
      for (const o of allOutputs) {
        const fh = await dir.getFileHandle(o.name, { create: true });
        const ws = await fh.createWritable();
        await ws.write(o.blob);
        await ws.close();
      }
      toast("success", t("batch.savedFolder", { n: allOutputs.length }));
    } catch { /* cancelled */ }
  };
  const report = () => {
    const lines = [["file", "status", "error", "outputs"].join(","), ...rows.map((r) => [JSON.stringify(r.file.name), r.status, JSON.stringify(r.error ?? ""), JSON.stringify(r.outputs.map((o) => o.name).join(" | "))].join(","))];
    downloadBlob(new Blob(["﻿" + lines.join("\n")], { type: "text/csv" }), "pdfaty-batch-report.csv");
  };
  const saveAction = () => {
    if (!name.trim()) return;
    const n = [...saved.filter((s) => s.name !== name.trim()), { name: name.trim(), steps }];
    setSaved(n); storage.set("pdfaty.actions", n); setName("");
    toast("success", t("batch.actionSaved"));
  };
  const exportActions = () => downloadBlob(new Blob([JSON.stringify(saved, null, 2)], { type: "application/json" }), "pdfaty-actions.json");
  const importActions = async (f: File) => {
    try {
      const data = JSON.parse(await f.text()) as Saved[];
      const valid = data.filter((s) => s && typeof s.name === "string" && Array.isArray(s.steps) && s.steps.every((x) => toolById(x.tool)?.batch));
      const n = [...saved.filter((s) => !valid.some((v) => v.name === s.name)), ...valid];
      setSaved(n); storage.set("pdfaty.actions", n);
      toast("success", t("batch.imported", { n: valid.length }));
    } catch { toast("error", t("batch.badJson")); }
  };
  const done = rows.filter((r) => r.status === "done").length;
  const failed = rows.filter((r) => r.status === "error").length;

  return (
    <div className="sa-body batch">
      <div className="batch-cols">
        <section>
          <h3>{t("batch.files")}</h3>
          <DropZone onFiles={add} multiple accept=".pdf,application/pdf" compact={rows.length > 0} label={t("batch.drop")} />
          <ul className="batch-rows">
            {rows.map((r) => (
              <li key={r.id} className={`b-${r.status}`}>
                <div className="grow">
                  <div dir="auto">{r.file.name} <span className="muted small">{formatBytes(r.file.size, lang)}</span></div>
                  {r.status === "running" && <Progress pct={r.pct} />}
                  {r.error && <div className="error-text small">{r.error}</div>}
                  {r.status === "done" && <div className="muted small">{r.outputs.map((o) => o.name).join("، ")}</div>}
                </div>
                <Badge kind={r.status === "done" ? "pass" : r.status === "error" ? "fail" : r.status === "running" ? "warn" : "info"}>{t(`batch.st.${r.status}`)}</Badge>
                {r.status === "error" && <IconButton label={t("batch.retry")} onClick={() => runAll((x) => x.id === r.id)} disabled={running}><RefreshCw size={14} /></IconButton>}
                {r.status === "done" && r.outputs.map((o, k) => <IconButton key={k} label={`${t("common.download")} ${o.name}`} onClick={() => downloadBlob(o.blob, o.name)}><FileDown size={14} /></IconButton>)}
                <IconButton label={t("common.delete")} onClick={() => setRows(rows.filter((x) => x.id !== r.id))} disabled={r.status === "running"}><Trash2 size={14} /></IconButton>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3>{t("batch.action")}</h3>
          {steps.map((s, i) => {
            const def = toolById(s.tool)!;
            return (
              <div className="step" key={i}>
                <div className="row">
                  <span className="fl-n">{i + 1}</span>
                  <select className="input" value={s.tool} onChange={(e) => { const d = toolById(e.target.value)!; setSteps(steps.map((x, k) => (k === i ? { tool: d.id, params: defaults(d.fields ?? []) } : x))); }} aria-label={t("batch.step")}>
                    {BATCH_TOOLS.map((x) => <option key={x.id} value={x.id}>{t(`tool.${x.id}`)}</option>)}
                  </select>
                  <IconButton label={t("common.delete")} onClick={() => setSteps(steps.filter((_, k) => k !== i))} disabled={steps.length === 1}><Trash2 size={14} /></IconButton>
                </div>
                <SchemaForm fields={(def.fields ?? []).filter((f) => f.type !== "image")} values={s.params} onChange={(v) => setSteps(steps.map((x, k) => (k === i ? { ...x, params: v } : x)))} />
                {def.result !== "replace" && i < steps.length - 1 && <p className="warn-text small">{t("batch.lastOnly")}</p>}
              </div>
            );
          })}
          <Button small icon={<Plus size={14} />} onClick={() => setSteps([...steps, { tool: "watermark_add", params: defaults(toolById("watermark_add")!.fields!) }])}>{t("batch.addStep")}</Button>
          <details className="presets">
            <summary>{t("batch.saved")}</summary>
            <div className="row"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("presets.name")} aria-label={t("presets.name")} /><IconButton label={t("presets.save")} onClick={saveAction} disabled={!name.trim()}><Save size={15} /></IconButton></div>
            <ul>{saved.map((s) => <li key={s.name}><button type="button" className="link" onClick={() => setSteps(s.steps)}>{s.name} ({s.steps.length})</button><IconButton label={t("common.delete")} onClick={() => { const n = saved.filter((x) => x.name !== s.name); setSaved(n); storage.set("pdfaty.actions", n); }}><Trash2 size={13} /></IconButton></li>)}</ul>
            <div className="row">
              <Button small onClick={exportActions} disabled={!saved.length}>{t("batch.export")}</Button>
              <label className="btn btn-default btn-sm"><Upload size={14} /><span>{t("batch.import")}</span><input type="file" hidden accept="application/json,.json" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) importActions(f); }} /></label>
            </div>
            <p className="muted small">{t("presets.local")}</p>
          </details>
        </section>
      </div>
      <div className="sa-opts">
        {!running ? <Button variant="primary" icon={<Play size={16} />} onClick={() => runAll()} disabled={!rows.length}>{t("batch.run", { n: rows.filter((r) => r.status !== "done").length })}</Button>
          : <Button variant="danger" onClick={() => { stop.current = true; }}>{t("batch.stop")}</Button>}
        {failed > 0 && !running && <Button icon={<RefreshCw size={16} />} onClick={() => runAll((r) => r.status === "error")}>{t("batch.retryFailed", { n: failed })}</Button>}
        <Button icon={<FolderDown size={16} />} onClick={saveFolder} disabled={!allOutputs.length}>{t("batch.saveFolder")}</Button>
        <Button onClick={async () => downloadBlob(await zipFiles(allOutputs), "pdfaty-batch.zip")} disabled={!allOutputs.length}>{t("batch.zip")}</Button>
        <Button onClick={report} disabled={!rows.length}>{t("batch.report")}</Button>
        <span className="muted small">{t("batch.status", { done, failed, total: rows.length })}</span>
      </div>
      <p className="muted small">{t("batch.note", { n: MAX_BATCH })}</p>
    </div>
  );
}
