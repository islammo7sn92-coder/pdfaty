import { useEffect, useState } from "react";
import {
  ChevronLeft, ChevronRight, Columns2, Download, FileStack, Home, Maximize, MoveHorizontal, PanelLeft, PanelRight,
  Printer, Redo2, Rows3, Search, Square, Undo2, X, ZoomIn, ZoomOut, Wrench,
} from "lucide-react";
import { useT } from "../i18n";
import { closeDoc, downloadCurrent, printCurrent, redo, undo } from "../lib/actions";
import { getState, setState, useStore, type ViewMode } from "../lib/store";
import { IconButton, Segmented } from "../components/ui";
import Viewer from "../components/Viewer";
import Sidebar from "../components/Sidebar";
import ToolPanel from "../components/ToolPanel";
import { LangThemeButtons, Logo } from "./Header";
import { openTool } from "../components/ToolPanel";

/** Warn when the document has (almost) no extractable text: scanned pages or text converted
 * to outlines (e.g. "Microsoft Print to PDF"). Search, copy and text editing need OCR first. */
function NoTextBanner() {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const [show, setShow] = useState(false);
  useEffect(() => {
    setShow(false);
    if (!doc) return;
    let alive = true;
    (async () => {
      let letters = 0;
      const n = Math.min(doc.numPages, 3);
      for (let i = 0; i < n; i++) {
        const tc = await (await doc.pdf.getPage(i + 1)).getTextContent();
        for (const it of tc.items as any[]) letters += (String(it.str ?? "").match(/[\p{L}\p{N}]/gu)?.length ?? 0);
      }
      if (alive && letters < 20 * n) setShow(true);
    })().catch(() => undefined);
    return () => { alive = false; };
  }, [doc?.id, doc?.version]);
  if (!show) return null;
  return (
    <div className="notext-banner" role="status">
      <span>{t("notext.body")}</span>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => openTool("ocr")}>{t("notext.ocr")}</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShow(false)}>{t("common.close")}</button>
    </div>
  );
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

export default function Workspace() {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const page = useStore((s) => s.page);
  const scale = useStore((s) => s.scale);
  const fit = useStore((s) => s.fit);
  const mode = useStore((s) => s.mode);
  const sidebar = useStore((s) => s.sidebar);
  const panelOpen = useStore((s) => s.panelOpen);
  const canUndo = useStore((s) => s.history.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const lang = useStore((s) => s.lang);
  const [pageInput, setPageInput] = useState("1");

  useEffect(() => setPageInput(String(page + 1)), [page]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); setState({ sidebar: "search" }); return; }
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); downloadCurrent(); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoom(1.15); }
      else if (mod && e.key === "-") { e.preventDefault(); zoom(1 / 1.15); }
      else if (e.key === "PageDown" && getState().mode === "single") go(getState().page + 1);
      else if (e.key === "PageUp" && getState().mode === "single") go(getState().page - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!doc) return null;
  const go = (p: number) => {
    const n = getState().doc?.numPages ?? 1;
    const q = Math.max(0, Math.min(n - 1, p));
    setState({ page: q, scrollTo: { page: q, nonce: Date.now() } });
  };
  function zoom(f: number) {
    setState({ scale: Math.max(0.2, Math.min(5, getState().scale * f)), fit: null });
  }
  const rtl = lang === "ar";
  const PrevIcon = rtl ? ChevronRight : ChevronLeft;
  const NextIcon = rtl ? ChevronLeft : ChevronRight;

  return (
    <div className="workspace">
      <header className="ws-bar" role="toolbar" aria-label={t("ws.toolbar")}>
        <div className="ws-group">
          <Logo onClick={() => setState({ route: "home" })} />
          <IconButton label={t("ws.home")} onClick={() => setState({ route: "home" })} className="hide-sm"><Home size={18} /></IconButton>
          <IconButton label={t("ws.sidebar")} active={!!sidebar} onClick={() => setState({ sidebar: sidebar ? null : "thumbs" })}>{rtl ? <PanelRight size={18} /> : <PanelLeft size={18} />}</IconButton>
          <span className="doc-name" title={doc.name} dir="auto">{doc.name}{doc.modified && <span className="dot" title={t("ws.modified")} aria-label={t("ws.modified")}>●</span>}</span>
        </div>
        <div className="ws-group">
          <IconButton label={t("ws.undo")} disabled={!canUndo} onClick={() => undo()}><Undo2 size={18} /></IconButton>
          <IconButton label={t("ws.redo")} disabled={!canRedo} onClick={() => redo()}><Redo2 size={18} /></IconButton>
          <span className="sep" />
          <IconButton label={t("ws.prev")} onClick={() => go(page - 1)} disabled={page <= 0}><PrevIcon size={18} /></IconButton>
          <form onSubmit={(e) => { e.preventDefault(); const n = parseInt(pageInput, 10); if (!isNaN(n)) go(n - 1); }} className="page-form">
            <input className="input page-input" value={pageInput} onChange={(e) => setPageInput(e.target.value)} aria-label={t("ws.pageNumber")} inputMode="numeric" />
            <span className="muted">/ {doc.numPages}</span>
          </form>
          <IconButton label={t("ws.next")} onClick={() => go(page + 1)} disabled={page >= doc.numPages - 1}><NextIcon size={18} /></IconButton>
          <span className="sep" />
          <IconButton label={t("ws.zoomOut")} onClick={() => zoom(1 / 1.2)}><ZoomOut size={18} /></IconButton>
          <select className="input zoom-select" aria-label={t("ws.zoom")} value={fit ? `fit-${fit}` : "custom"}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "fit-width") setState({ fit: "width" });
              else if (v === "fit-page") setState({ fit: "page" });
              else if (v !== "custom") setState({ scale: Number(v), fit: null });
            }}>
            <option value="custom">{Math.round(scale * 100)}%</option>
            <option value="fit-width">{t("ws.fitWidth")}</option>
            <option value="fit-page">{t("ws.fitPage")}</option>
            {ZOOMS.map((z) => <option key={z} value={z}>{z * 100}%</option>)}
          </select>
          <IconButton label={t("ws.zoomIn")} onClick={() => zoom(1.2)}><ZoomIn size={18} /></IconButton>
          <IconButton label={t("ws.fitWidth")} active={fit === "width"} onClick={() => setState({ fit: "width" })} className="hide-sm"><MoveHorizontal size={18} /></IconButton>
          <IconButton label={t("ws.fitPage")} active={fit === "page"} onClick={() => setState({ fit: "page" })} className="hide-sm"><Maximize size={18} /></IconButton>
          <span className="sep hide-sm" />
          <div className="hide-sm">
            <Segmented<ViewMode> label={t("ws.viewMode")} value={mode} onChange={(m) => setState({ mode: m })} options={[
              { value: "continuous", label: t("ws.continuous"), icon: <Rows3 size={16} /> },
              { value: "single", label: t("ws.single"), icon: <Square size={16} /> },
              { value: "double", label: t("ws.double"), icon: <Columns2 size={16} /> },
            ]} />
          </div>
        </div>
        <div className="ws-group">
          <IconButton label={t("side.search")} onClick={() => setState({ sidebar: "search" })}><Search size={18} /></IconButton>
          <IconButton label={t("ws.tools")} active={panelOpen} onClick={() => setState({ panelOpen: !panelOpen })}><Wrench size={18} /></IconButton>
          <IconButton label={t("ws.newFile")} onClick={() => setState({ route: "home" })} className="hide-sm"><FileStack size={18} /></IconButton>
          <IconButton label={t("ws.print")} onClick={printCurrent} className="hide-sm"><Printer size={18} /></IconButton>
          <button type="button" className="btn btn-primary btn-sm" onClick={downloadCurrent}><Download size={16} /><span className="hide-xs">{t("ws.download")}</span></button>
          <IconButton label={t("ws.close")} onClick={() => closeDoc()}><X size={18} /></IconButton>
          <span className="hide-md"><LangThemeButtons /></span>
        </div>
      </header>
      <NoTextBanner />
      <div className="ws-body" id="main">
        <Sidebar />
        <main className="ws-center">
          <Viewer />
        </main>
        <ToolPanel />
      </div>
    </div>
  );
}
