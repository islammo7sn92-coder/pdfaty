// Shared tool building blocks: schema-driven forms, output lists, preview modal, page-placed items.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download, ExternalLink, FileArchive, Save, Trash2 } from "lucide-react";
import { useT } from "../../i18n";
import { getCapabilities } from "../../lib/api";
import { confirmDialog, openBytes } from "../../lib/actions";
import { openPdf } from "../../lib/pdf";
import { getState, useStore } from "../../lib/store";
import { downloadBlob, formatBytes, storage, zipFiles } from "../../lib/utils";
import { Button, Field, IconButton, Modal } from "../ui";
import type { FieldDef } from "./registry";

export function defaults(fields: FieldDef[]): Record<string, any> {
  const v: Record<string, any> = {};
  for (const f of fields) if (f.def !== undefined) v[f.k] = f.def;
  return v;
}

export function SchemaForm({ fields, values, onChange, files, onFile }: {
  fields: FieldDef[]; values: Record<string, any>; onChange: (v: Record<string, any>) => void;
  files?: Record<string, File | null>; onFile?: (k: string, f: File | null) => void;
}) {
  const t = useT();
  const numPages = useStore((s) => s.doc?.numPages ?? 0);
  const [langs, setLangs] = useState<string[]>(["ara", "eng"]);
  useEffect(() => {
    if (fields.some((f) => f.type === "langs")) getCapabilities().then((c) => setLangs(c.ocr_languages)).catch(() => undefined);
  }, [fields]);
  const set = (k: string, val: any) => onChange({ ...values, [k]: val });
  const lbl = (s: string) => {
    const tr = t(s);
    return tr.includes("(f.") ? tr.replace(/\((f\.[a-zA-Z]+)\)/, (_m, k) => `(${t(k)})`) : tr;
  };
  return (
    <div className="form">
      {fields.filter((f) => !f.showIf || f.showIf(values)).map((f) => {
        const help = f.help ? t(f.help, { n: numPages }) : undefined;
        switch (f.type) {
          case "note":
            return <p key={f.k} className="note">{t(f.label)}</p>;
          case "checkbox":
            return (
              <label key={f.k} className="check">
                <input type="checkbox" checked={!!values[f.k]} onChange={(e) => set(f.k, e.target.checked)} />
                <span>{t(f.label)}</span>
                {help && <span className="field-help">{help}</span>}
              </label>
            );
          case "select":
            return (
              <Field key={f.k} label={t(f.label)} help={help}>
                <select className="input" value={values[f.k] ?? ""} onChange={(e) => set(f.k, e.target.value)}>
                  {f.options!.map(([v, l]) => <option key={v} value={v}>{lbl(l)}</option>)}
                </select>
              </Field>
            );
          case "number":
            return (
              <Field key={f.k} label={t(f.label)} help={help}>
                <input className="input" type="number" min={f.min} max={f.max} step={f.step ?? 1} value={values[f.k] ?? ""} onChange={(e) => set(f.k, e.target.value === "" ? "" : Number(e.target.value))} />
              </Field>
            );
          case "range":
            return (
              <Field key={f.k} label={`${t(f.label)}: ${values[f.k]}${f.unit ?? ""}`} help={help}>
                <input type="range" min={f.min} max={f.max} step={f.step ?? 1} value={values[f.k] ?? f.def} onChange={(e) => set(f.k, Number(e.target.value))} />
              </Field>
            );
          case "color":
            return (
              <Field key={f.k} label={t(f.label)} help={help} inline>
                <input type="color" value={values[f.k] ?? "#000000"} onChange={(e) => set(f.k, e.target.value)} />
              </Field>
            );
          case "textarea":
            return (
              <Field key={f.k} label={t(f.label)} help={help}>
                <textarea className="input" rows={4} dir="auto" value={values[f.k] ?? ""} placeholder={f.placeholder} onChange={(e) => set(f.k, e.target.value)} />
              </Field>
            );
          case "pages":
            return (
              <Field key={f.k} label={t(f.label)} help={help}>
                <input className="input" dir="ltr" value={values[f.k] ?? ""} placeholder={t("f.pagesPlaceholder")} onChange={(e) => set(f.k, e.target.value)} />
              </Field>
            );
          case "image":
            return (
              <Field key={f.k} label={t(f.label)} help={help}>
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" onChange={(e) => onFile?.(f.k, e.target.files?.[0] ?? null)} />
                {files?.[f.k] && <span className="muted small">{files[f.k]!.name}</span>}
              </Field>
            );
          case "langs":
            return (
              <fieldset key={f.k} className="field">
                <legend className="field-label">{t(f.label)}</legend>
                <div className="chips">
                  {langs.map((l) => (
                    <label key={l} className="check chip">
                      <input type="checkbox" checked={(values[f.k] ?? []).includes(l)}
                        onChange={(e) => set(f.k, e.target.checked ? [...(values[f.k] ?? []), l] : (values[f.k] ?? []).filter((x: string) => x !== l))} />
                      <span>{t(`lang.${l}`) === `lang.${l}` ? l : t(`lang.${l}`)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          default:
            return (
              <Field key={f.k} label={t(f.label)} help={help}>
                <input className="input" type={f.type === "password" ? "password" : "text"} dir="auto" autoComplete={f.type === "password" ? "new-password" : "off"}
                  value={values[f.k] ?? ""} placeholder={f.placeholder} onChange={(e) => set(f.k, e.target.value)} />
              </Field>
            );
        }
      })}
    </div>
  );
}

export interface OutFile { name: string; mime: string; blob: Blob }

export function Outputs({ files, title }: { files: OutFile[]; title?: string }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  if (!files.length) return null;
  const zip = files.find((f) => f.mime === "application/zip");
  const singles = files.filter((f) => f !== zip);
  const open = async (f: OutFile) => {
    if (getState().doc?.modified && !(await confirmDialog(t("close.title"), t("close.body"), true))) return;
    await openBytes(new Uint8Array(await f.blob.arrayBuffer()), f.name);
  };
  return (
    <div className="outputs">
      <h3>{title ?? t("out.title")}</h3>
      {singles.length > 1 && (
        <Button variant="primary" icon={<FileArchive size={16} />} onClick={async () => (zip ? downloadBlob(zip.blob, zip.name) : downloadBlob(await zipFiles(singles), "pdfaty-files.zip"))}>
          {t("out.downloadAll", { n: singles.length })}
        </Button>
      )}
      <ul>
        {singles.slice(0, 300).map((f, i) => (
          <li key={i}>
            <span className="grow" dir="auto">{f.name}</span>
            <span className="muted small">{formatBytes(f.blob.size, lang)}</span>
            {f.mime === "application/pdf" && <IconButton label={t("out.open")} onClick={() => open(f)}><ExternalLink size={15} /></IconButton>}
            <IconButton label={t("common.download")} onClick={() => downloadBlob(f.blob, f.name)}><Download size={15} /></IconButton>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PdfPreviewModal({ blob, onClose, title }: { blob: Blob | null; onClose: () => void; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!blob) return;
    let alive = true;
    (async () => {
      const pdf = await openPdf(new Uint8Array(await blob.arrayBuffer()));
      const page = await pdf.getPage(1);
      const box = ref.current;
      if (!box || !alive) return;
      const base = page.getViewport({ scale: 1 });
      const s = Math.min((box.clientWidth || 600) / base.width, 700 / base.height) * Math.min(2, devicePixelRatio || 1);
      const vp = page.getViewport({ scale: s });
      const c = document.createElement("canvas");
      c.width = vp.width;
      c.height = vp.height;
      c.style.width = "100%";
      c.style.maxWidth = `${vp.width / Math.min(2, devicePixelRatio || 1)}px`;
      await page.render({ canvasContext: c.getContext("2d")!, canvas: c, viewport: vp }).promise;
      if (alive) box.replaceChildren(c);
      pdf.destroy();
    })().catch(() => undefined);
    return () => { alive = false; };
  }, [blob]);
  return (
    <Modal open={!!blob} title={title} onClose={onClose} wide>
      <div className="preview-box" ref={ref} />
    </Modal>
  );
}

/** Saved settings presets in localStorage (only after the user presses "save"). */
export function Presets({ id, values, onLoad }: { id: string; values: Record<string, any>; onLoad: (v: Record<string, any>) => void }) {
  const t = useT();
  const key = `pdfaty.presets.${id}`;
  const [list, setList] = useState<{ name: string; values: Record<string, any> }[]>(() => storage.get(key, []));
  const [name, setName] = useState("");
  const save = () => {
    if (!name.trim()) return;
    const next = [...list.filter((p) => p.name !== name.trim()), { name: name.trim(), values }];
    setList(next);
    storage.set(key, next);
    setName("");
  };
  const del = (n: string) => {
    const next = list.filter((p) => p.name !== n);
    setList(next);
    storage.set(key, next);
  };
  return (
    <details className="presets">
      <summary>{t("presets.title")}</summary>
      <div className="row">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("presets.name")} aria-label={t("presets.name")} />
        <IconButton label={t("presets.save")} onClick={save} disabled={!name.trim()}><Save size={15} /></IconButton>
      </div>
      {!list.length && <p className="muted small">{t("presets.empty")}</p>}
      <ul>
        {list.map((p) => (
          <li key={p.name}>
            <button type="button" className="link" onClick={() => onLoad(p.values)}>{p.name}</button>
            <IconButton label={t("common.delete")} onClick={() => del(p.name)}><Trash2 size={14} /></IconButton>
          </li>
        ))}
      </ul>
      <p className="muted small">{t("presets.local")}</p>
    </details>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="tool-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- drawing helpers for overlays
export interface Pt { x: number; y: number }

/** Pointer position in PDF points (visible page, top-left origin). */
export function pagePoint(e: React.PointerEvent | PointerEvent, el: HTMLElement, scale: number): Pt {
  const r = el.getBoundingClientRect();
  return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
}

/** Drag-to-create rectangle hook used by many drawing tools. */
export function useRectDraw(onDone: (page: number, r: { x: number; y: number; w: number; h: number }) => void, minSize = 4) {
  const [draft, setDraft] = useState<{ page: number; a: Pt; b: Pt } | null>(null);
  const handlers = (page: number, scale: number) => ({
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || e.target !== e.currentTarget) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const p = pagePoint(e, e.currentTarget, scale);
      setDraft({ page, a: p, b: p });
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draft || draft.page !== page) return;
      setDraft({ ...draft, b: pagePoint(e, e.currentTarget, scale) });
    },
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draft || draft.page !== page) return;
      const b = pagePoint(e, e.currentTarget, scale);
      const r = { x: Math.min(draft.a.x, b.x), y: Math.min(draft.a.y, b.y), w: Math.abs(b.x - draft.a.x), h: Math.abs(b.y - draft.a.y) };
      setDraft(null);
      if (r.w >= minSize && r.h >= minSize) onDone(page, r);
      else onDone(page, { x: b.x, y: b.y, w: 0, h: 0 });
    },
  });
  const draftRect = (page: number, scale: number) => {
    if (!draft || draft.page !== page) return null;
    const x = Math.min(draft.a.x, draft.b.x), y = Math.min(draft.a.y, draft.b.y);
    return <div className="draft-rect" style={{ left: x * scale, top: y * scale, width: Math.abs(draft.b.x - draft.a.x) * scale, height: Math.abs(draft.b.y - draft.a.y) * scale }} />;
  };
  return { handlers, draftRect };
}

/** A placed, movable and resizable box on a page overlay. */
export function PlacedBox({ x, y, w, h, scale, selected, onSelect, onChange, onDelete, children, className, label }: {
  x: number; y: number; w: number; h: number; scale: number; selected?: boolean; onSelect?: () => void;
  onChange: (r: { x: number; y: number; w: number; h: number }) => void; onDelete?: () => void; children?: ReactNode; className?: string; label: string;
}) {
  const t = useT();
  const start = useRef<{ px: number; py: number; x: number; y: number; w: number; h: number; mode: "move" | "resize" } | null>(null);
  const down = (mode: "move" | "resize") => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { px: e.clientX, py: e.clientY, x, y, w, h, mode };
    onSelect?.();
  };
  const move = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const dx = (e.clientX - s.px) / scale, dy = (e.clientY - s.py) / scale;
    if (s.mode === "move") onChange({ x: s.x + dx, y: s.y + dy, w: s.w, h: s.h });
    else onChange({ x: s.x, y: s.y, w: Math.max(6, s.w + dx), h: Math.max(6, s.h + dy) });
  };
  const up = () => { start.current = null; };
  const key = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); onDelete?.(); }
    else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] as number[];
      onChange({ x: x + d[0], y: y + d[1], w, h });
    }
  };
  return (
    <div className={`placed ${selected ? "selected" : ""} ${className ?? ""}`} style={{ left: x * scale, top: y * scale, width: w * scale, height: h * scale }}
      onPointerDown={down("move")} onPointerMove={move} onPointerUp={up} tabIndex={0} role="group" aria-label={label} onKeyDown={key} onFocus={onSelect}>
      {children}
      {onDelete && selected && (
        <button type="button" className="placed-del" aria-label={t("common.delete")} onPointerDown={(e) => e.stopPropagation()} onClick={onDelete}><Trash2 size={12} /></button>
      )}
      <span className="placed-handle" onPointerDown={down("resize")} onPointerMove={move} onPointerUp={up} aria-hidden />
    </div>
  );
}
