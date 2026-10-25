import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, FilePlus2, FileInput, Replace, RotateCcw, RotateCw, Scissors, Trash2, Undo, X } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useT } from "../../i18n";
import { confirmDialog, currentFile, docParams, runOnDoc, runOp } from "../../lib/actions";
import { openPdf, PasswordNeeded } from "../../lib/pdf";
import { setState, toast, useStore } from "../../lib/store";
import { cls, uid } from "../../lib/utils";
import { Button, IconButton, Modal } from "../ui";
import { Thumb } from "../Sidebar";
import { Outputs, type OutFile } from "./common";

interface Item { key: string; src: number; page: number; rotate: number; blank?: boolean }
interface Source { name: string; file: File | null; pdf: PDFDocumentProxy; password: string }

export default function Organize() {
  const t = useT();
  const doc = useStore((s) => s.doc)!;
  const [items, setItems] = useState<Item[]>(() => Array.from({ length: doc.numPages }, (_, i) => ({ key: uid(), src: 0, page: i, rotate: 0 })));
  const [sources, setSources] = useState<Source[]>([{ name: doc.name, file: null, pdf: doc.pdf, password: doc.password }]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ src: number; mode: "insert" | "replace" } | null>(null);
  const [outs, setOuts] = useState<OutFile[]>([]);
  const lastClick = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingMode = useRef<"insert" | "replace">("insert");

  useEffect(() => {
    setItems(Array.from({ length: doc.numPages }, (_, i) => ({ key: uid(), src: 0, page: i, rotate: 0 })));
    setSources([{ name: doc.name, file: null, pdf: doc.pdf, password: doc.password }]);
    setSel(new Set());
  }, [doc.version]);

  const changed = useMemo(() => items.length !== doc.numPages || items.some((it, i) => it.src !== 0 || it.page !== i || it.rotate || it.blank), [items, doc.numPages]);

  const click = (it: Item, e: React.MouseEvent) => {
    const next = new Set(e.ctrlKey || e.metaKey ? sel : []);
    if (e.shiftKey && lastClick.current) {
      const a = items.findIndex((x) => x.key === lastClick.current);
      const b = items.findIndex((x) => x.key === it.key);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(items[i].key);
    } else if (next.has(it.key) && (e.ctrlKey || e.metaKey)) next.delete(it.key);
    else next.add(it.key);
    lastClick.current = it.key;
    setSel(next);
  };
  const selected = items.filter((x) => sel.has(x.key));
  const rotate = (d: number) => setItems(items.map((x) => (sel.has(x.key) ? { ...x, rotate: (x.rotate + d + 360) % 360 } : x)));
  const remove = () => {
    if (selected.length >= items.length) { toast("warning", t("org.cantDeleteAll")); return; }
    setItems(items.filter((x) => !sel.has(x.key)));
    setSel(new Set());
  };
  const duplicate = () => {
    const out: Item[] = [];
    for (const x of items) { out.push(x); if (sel.has(x.key)) out.push({ ...x, key: uid() }); }
    setItems(out);
  };
  const insertAt = () => {
    const idx = selected.length ? Math.max(...selected.map((s) => items.indexOf(s))) + 1 : items.length;
    return idx;
  };
  const addBlank = () => {
    const i = insertAt();
    setItems([...items.slice(0, i), { key: uid(), src: 0, page: 0, rotate: 0, blank: true }, ...items.slice(i)]);
  };
  const onDrop = (target: string) => {
    if (!drag || drag === target) return;
    const moving = sel.has(drag) ? items.filter((x) => sel.has(x.key)) : items.filter((x) => x.key === drag);
    const rest = items.filter((x) => !moving.includes(x));
    const ti = rest.findIndex((x) => x.key === target);
    const at = ti < 0 ? rest.length : ti;
    setItems([...rest.slice(0, at), ...moving, ...rest.slice(at)]);
    setDrag(null);
  };
  const move = (it: Item, d: number) => {
    const i = items.indexOf(it);
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const n = items.slice();
    [n[i], n[j]] = [n[j], n[i]];
    setItems(n);
  };

  const addFile = async (f: File) => {
    let pw = "";
    for (let k = 0; k < 4; k++) {
      try {
        const pdf = await openPdf(new Uint8Array(await f.arrayBuffer()), pw);
        const src = sources.length;
        setSources([...sources, { name: f.name, file: f, pdf, password: pw }]);
        setPicker({ src, mode: pendingMode.current });
        return;
      } catch (e) {
        if (e instanceof PasswordNeeded) {
          const p = window.prompt(t("pw.body", { name: f.name }));
          if (!p) return;
          pw = p;
        } else { toast("error", t("err.invalid_pdf"), f.name); return; }
      }
    }
  };
  const pickPages = (pages: number[]) => {
    if (!picker) return;
    const newItems = pages.map((p) => ({ key: uid(), src: picker.src, page: p, rotate: 0 }));
    if (picker.mode === "replace" && selected.length) {
      const first = items.indexOf(selected[0]);
      const rest = items.filter((x) => !sel.has(x.key));
      const at = rest.filter((x) => items.indexOf(x) < first).length;
      setItems([...rest.slice(0, at), ...newItems, ...rest.slice(at)]);
      setSel(new Set());
    } else {
      const i = insertAt();
      setItems([...items.slice(0, i), ...newItems, ...items.slice(i)]);
    }
    setPicker(null);
  };

  const payload = (list: Item[]) => {
    const used = Array.from(new Set(list.filter((x) => !x.blank).map((x) => x.src))).filter((s) => s > 0);
    const files = [currentFile()!, ...used.map((s) => ({ name: sources[s].name, data: sources[s].file! }))];
    const map = new Map<number, number>([[0, 0], ...used.map((s, i) => [s, i + 1] as [number, number])]);
    const pages = list.map((x) => (x.blank ? { blank: true } : { src: map.get(x.src), page: x.page, rotate: x.rotate }));
    const passwords = [getDocPw(), ...used.map((s) => sources[s].password)];
    return { files, params: docParams({ pages, passwords }) };
  };
  const getDocPw = () => doc.password;

  const apply = async () => {
    const { files, params } = payload(items);
    void files;
    const extra = files.slice(1);
    const res = await runOnDoc("organize", params, t("tool.organize"), extra);
    if (res) toast("success", t("org.applied", { n: items.length }));
  };
  const extract = async () => {
    const list = selected.length ? items.filter((x) => sel.has(x.key)) : items;
    const { files, params } = payload(list);
    const res = await runOp("organize", files, { ...params, output_name: t("org.extractName") }, t("org.extract"));
    if (res) setOuts(res.files);
  };
  const reset = async () => {
    if (changed && !(await confirmDialog(t("org.reset"), t("org.resetBody")))) return;
    setItems(Array.from({ length: doc.numPages }, (_, i) => ({ key: uid(), src: 0, page: i, rotate: 0 })));
    setSel(new Set());
  };

  const screen = (
    <div className="organizer" role="region" aria-label={t("tool.organize")}>
      <div className="org-bar">
        <strong>{t("tool.organize")}</strong>
        <span className="muted small">{t("org.count", { n: items.length, s: selected.length })}</span>
        <div className="grow" />
        <IconButton label={t("org.rotL")} disabled={!selected.length} onClick={() => rotate(-90)}><RotateCcw size={18} /></IconButton>
        <IconButton label={t("org.rotR")} disabled={!selected.length} onClick={() => rotate(90)}><RotateCw size={18} /></IconButton>
        <IconButton label={t("org.duplicate")} disabled={!selected.length} onClick={duplicate}><Copy size={18} /></IconButton>
        <IconButton label={t("org.delete")} disabled={!selected.length} onClick={remove}><Trash2 size={18} /></IconButton>
        <IconButton label={t("org.blank")} onClick={addBlank}><FilePlus2 size={18} /></IconButton>
        <IconButton label={t("org.insertFile")} onClick={() => { pendingMode.current = "insert"; fileInput.current?.click(); }}><FileInput size={18} /></IconButton>
        <IconButton label={t("org.replace")} disabled={!selected.length} onClick={() => { pendingMode.current = "replace"; fileInput.current?.click(); }}><Replace size={18} /></IconButton>
        <IconButton label={t("org.extract")} onClick={extract}><Scissors size={18} /></IconButton>
        <IconButton label={t("org.reset")} onClick={reset}><Undo size={18} /></IconButton>
        <Button variant="primary" small disabled={!changed} onClick={apply}>{t("common.apply")}</Button>
        <IconButton label={t("common.close")} onClick={() => setState({ tool: null })}><X size={18} /></IconButton>
      </div>
      <p className="muted small org-help">{t("org.help")}</p>
      <div className="org-grid" onClick={(e) => { if (e.target === e.currentTarget) setSel(new Set()); }}>
        {items.map((it, i) => (
          <div key={it.key} className={cls("org-item", sel.has(it.key) && "sel", drag === it.key && "dragging")} draggable
            onDragStart={() => setDrag(it.key)} onDragOver={(e) => e.preventDefault()} onDrop={() => onDrop(it.key)} onDragEnd={() => setDrag(null)}
            onClick={(e) => click(it, e)} onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") { e.preventDefault(); click(it, e as any); }
              if (e.key === "Delete") remove();
              if (e.altKey && e.key === "ArrowLeft") move(it, -1);
              if (e.altKey && e.key === "ArrowRight") move(it, 1);
            }} tabIndex={0} role="option" aria-selected={sel.has(it.key)} aria-label={t("org.itemLabel", { n: i + 1 })}>
            {it.blank ? <div className="blank-page">{t("org.blankPage")}</div> : (
              <div className="org-thumb" style={{ transform: `rotate(${it.rotate}deg)` }}>
                <Thumb pdf={sources[it.src].pdf} index={it.page} width={110} onClick={() => undefined} />
              </div>
            )}
            <div className="org-cap">
              <span>{i + 1}</span>
              {it.src > 0 && <span className="badge badge-info" title={sources[it.src].name}>+</span>}
              {it.rotate ? <span className="muted small">{it.rotate}°</span> : null}
            </div>
          </div>
        ))}
        <div className="org-drop-end" onDragOver={(e) => e.preventDefault()} onDrop={() => onDrop("__end__")} />
      </div>
      <input ref={fileInput} type="file" hidden accept=".pdf,application/pdf" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) addFile(f); }} />
      {picker && <PagePicker source={sources[picker.src]} mode={picker.mode} onCancel={() => setPicker(null)} onPick={pickPages} />}
      {outs.length > 0 && <div className="org-outs"><Outputs files={outs} /></div>}
    </div>
  );
  return (
    <>
      <p className="muted small">{t("org.panelHint")}</p>
      {createPortal(screen, document.body)}
    </>
  );
}

function PagePicker({ source, mode, onPick, onCancel }: { source: Source; mode: "insert" | "replace"; onPick: (p: number[]) => void; onCancel: () => void }) {
  const t = useT();
  const [chosen, setChosen] = useState<Set<number>>(new Set(Array.from({ length: source.pdf.numPages }, (_, i) => i)));
  const root = useRef<HTMLDivElement>(null);
  return (
    <Modal open title={t(mode === "insert" ? "org.pickInsert" : "org.pickReplace", { name: source.name })} onClose={onCancel} wide
      footer={<><Button onClick={() => setChosen(new Set())}>{t("org.none")}</Button><Button onClick={onCancel}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={!chosen.size} onClick={() => onPick(Array.from(chosen).sort((a, b) => a - b))}>{t("org.addPages", { n: chosen.size })}</Button></>}>
      <div className="picker-grid" ref={root}>
        {Array.from({ length: source.pdf.numPages }, (_, i) => (
          <label key={i} className={cls("pick", chosen.has(i) && "on")}>
            <input type="checkbox" checked={chosen.has(i)} onChange={(e) => { const n = new Set(chosen); e.target.checked ? n.add(i) : n.delete(i); setChosen(n); }} />
            <Thumb pdf={source.pdf} index={i} width={90} root={root} onClick={() => { const n = new Set(chosen); n.has(i) ? n.delete(i) : n.add(i); setChosen(n); }} />
          </label>
        ))}
      </div>
    </Modal>
  );
}

export function RemoveBlank() {
  const t = useT();
  const [threshold, setThreshold] = useState(0.003);
  const [found, setFound] = useState<number[] | null>(null);
  const detect = async () => {
    const f = currentFile();
    if (!f) return;
    const res = await runOp("detect_blank", [f], docParams({ threshold }), t("tool.remove_blank"));
    if (res) setFound(res.result.blank_pages);
  };
  const remove = async () => {
    if (!found?.length) return;
    if (!(await confirmDialog(t("tool.remove_blank"), t("blank.confirm", { pages: found.map((p) => p + 1).join(", ") }), true))) return;
    const res = await runOnDoc("remove_blank", { threshold }, t("tool.remove_blank"));
    if (res) { toast("success", t("blank.removed", { n: res.result.removed.length })); setFound(null); }
  };
  return (
    <div className="form">
      <label className="field">
        <span className="field-label">{t("blank.sensitivity")}: {threshold}</span>
        <input type="range" min={0} max={0.02} step={0.001} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
        <span className="field-help">{t("blank.help")}</span>
      </label>
      <Button onClick={detect}>{t("blank.detect")}</Button>
      {found && (
        <div className="result-box">
          {found.length ? <p>{t("blank.found", { pages: found.map((p) => p + 1).join(", ") })}</p> : <p>{t("blank.none")}</p>}
          {found.map((p) => <button key={p} type="button" className="link" onClick={() => setState({ scrollTo: { page: p, nonce: Date.now() } })}>{t("viewer.page", { n: p + 1 })} </button>)}
          {found.length > 0 && <Button variant="danger" onClick={remove}>{t("blank.remove")}</Button>}
        </div>
      )}
    </div>
  );
}
