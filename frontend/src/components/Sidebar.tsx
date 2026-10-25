import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Download, Edit3, MessageSquare, Paperclip, Search, Trash2 } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useT } from "../i18n";
import { confirmDialog, runOnDoc } from "../lib/actions";
import { renderThumb, resolveDest, type OutlineNode } from "../lib/pdf";
import { getTextCache, setHighlights, setTextCache, type Highlights, type TextItemLite } from "../lib/overlay";
import { setState, useStore, type SidebarTab } from "../lib/store";
import { cls, downloadBlob, formatBytes } from "../lib/utils";
import { Button, Empty, IconButton, Modal } from "./ui";

export default function Sidebar() {
  const tab = useStore((s) => s.sidebar);
  const t = useT();
  if (!tab) return null;
  const tabs: { id: SidebarTab; label: string }[] = [
    { id: "thumbs", label: t("side.thumbs") },
    { id: "outline", label: t("side.outline") },
    { id: "search", label: t("side.search") },
    { id: "comments", label: t("side.comments") },
    { id: "attachments", label: t("side.attachments") },
    { id: "info", label: t("side.info") },
  ];
  return (
    <aside className="sidebar" aria-label={t("side.label")}>
      <div className="side-tabs" role="tablist">
        {tabs.map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} className={cls(tab === x.id && "on")} onClick={() => setState({ sidebar: x.id })}>
            {x.label}
          </button>
        ))}
      </div>
      <div className="side-body">
        {tab === "thumbs" && <Thumbs />}
        {tab === "outline" && <Outline />}
        {tab === "search" && <SearchPanel />}
        {tab === "comments" && <Comments />}
        {tab === "attachments" && <Attachments />}
        {tab === "info" && <Properties />}
      </div>
    </aside>
  );
}

function Thumbs() {
  const doc = useStore((s) => s.doc)!;
  const page = useStore((s) => s.page);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`[data-thumb="${page}"]`)?.scrollIntoView({ block: "nearest" });
  }, [page]);
  return (
    <div className="thumbs" ref={listRef}>
      {Array.from({ length: doc.numPages }, (_, i) => (
        <Thumb key={`${doc.id}-${doc.version}-${i}`} pdf={doc.pdf} index={i} active={i === page} root={listRef} />
      ))}
    </div>
  );
}

export function Thumb({ pdf, index, active, root, width = 120, onClick, rotate = 0 }: { pdf: PDFDocumentProxy; index: number; active?: boolean; root?: React.RefObject<HTMLElement | null>; width?: number; onClick?: () => void; rotate?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const t = useT();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let done = false;
    const io = new IntersectionObserver(async (es) => {
      if (!es[0].isIntersecting || done) return;
      done = true;
      try {
        const c = await renderThumb(pdf, index, width, rotate);
        setSrc(c.toDataURL("image/jpeg", 0.8));
      } catch { /* page failed to render */ }
    }, { root: root?.current ?? null, rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [pdf, index, width, rotate, root]);
  return (
    <div className={cls("thumb", active && "active")} ref={ref} data-thumb={index}>
      <button type="button" onClick={onClick ?? (() => setState({ scrollTo: { page: index, nonce: Date.now() }, page: index }))} aria-label={t("viewer.page", { n: index + 1 })}>
        {src ? <img src={src} alt="" style={{ width }} /> : <div className="thumb-ph" style={{ width, height: width * 1.3 }} />}
      </button>
      <span className="thumb-n">{index + 1}</span>
    </div>
  );
}

function Outline() {
  const doc = useStore((s) => s.doc)!;
  const [items, setItems] = useState<OutlineNode[] | null>(null);
  const t = useT();
  useEffect(() => {
    doc.pdf.getOutline().then((o) => setItems((o as OutlineNode[]) || [])).catch(() => setItems([]));
  }, [doc.pdf]);
  if (items == null) return <div className="muted small pad">{t("common.loading")}</div>;
  if (!items.length) return <Empty title={t("side.noOutline")}>{t("side.noOutlineHint")}</Empty>;
  return <ul className="outline">{items.map((n, i) => <OutlineItem key={i} node={n} pdf={doc.pdf} />)}</ul>;
}

function OutlineItem({ node, pdf }: { node: OutlineNode; pdf: PDFDocumentProxy }) {
  const [open, setOpen] = useState(false);
  const rtl = useStore((s) => s.lang) === "ar";
  const go = async () => {
    if (node.url) { window.open(node.url, "_blank", "noopener,noreferrer"); return; }
    const p = await resolveDest(pdf, node.dest);
    if (p != null) setState({ scrollTo: { page: p, nonce: Date.now() } });
  };
  return (
    <li>
      <div className="outline-row">
        {node.items?.length ? (
          <button type="button" className="tw" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={node.title}>
            {open ? <ChevronDown size={14} /> : rtl ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : <span className="tw" />}
        <button type="button" className="outline-title" onClick={go}>{node.title}</button>
      </div>
      {open && node.items?.length > 0 && <ul>{node.items.map((c, i) => <OutlineItem key={i} node={c} pdf={pdf} />)}</ul>}
    </li>
  );
}

// ------------------------------------------------------------------- search
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
function normChar(c: string): string {
  let i = AR_DIGITS.indexOf(c);
  if (i >= 0) return String(i);
  i = FA_DIGITS.indexOf(c);
  if (i >= 0) return String(i);
  if ("أإآٱ".includes(c)) return "ا";
  if (c === "ى") return "ي";
  if (c === "ة") return "ه";
  if (/[ً-ٰٟـ]/.test(c)) return "";
  return c.normalize("NFKC").toLowerCase();
}

function normalizeWithMap(s: string): { n: string; map: number[] } {
  let n = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const r = normChar(s[i]);
    for (const ch of r) {
      n += ch;
      map.push(i);
    }
  }
  return { n, map };
}

export async function loadText(pdf: PDFDocumentProxy, key: string, onProgress?: (p: number) => void): Promise<TextItemLite[][]> {
  const cached = getTextCache(key);
  if (cached) return cached;
  const pages: TextItemLite[][] = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const p = await pdf.getPage(i + 1);
    const tc = await p.getTextContent();
    pages.push(tc.items.map((it: any) => ({ str: it.str ?? "", eol: !!it.hasEOL })));
    onProgress?.((i + 1) / pdf.numPages);
  }
  setTextCache(key, pages);
  return pages;
}

interface Hit { page: number; ranges: [number, number, number][]; snippet: string }

function searchPages(pages: TextItemLite[][], q: string): Hit[] {
  const nq = normalizeWithMap(q.trim()).n;
  if (!nq) return [];
  const hits: Hit[] = [];
  pages.forEach((items, p) => {
    let joined = "";
    const starts: number[] = [];
    items.forEach((it) => {
      starts.push(joined.length);
      joined += it.str + (it.eol ? " " : "");
    });
    const { n, map } = normalizeWithMap(joined);
    let from = 0;
    for (;;) {
      const k = n.indexOf(nq, from);
      if (k < 0 || hits.length > 5000) break;
      from = k + nq.length;
      const s = map[k];
      const e = map[k + nq.length - 1] + 1;
      const ranges: [number, number, number][] = [];
      for (let it = 0; it < items.length; it++) {
        const a = starts[it];
        const b = a + items[it].str.length;
        const lo = Math.max(a, s), hi = Math.min(b, e);
        if (lo < hi) ranges.push([it, lo - a, hi - a]);
      }
      hits.push({ page: p, ranges, snippet: joined.slice(Math.max(0, s - 30), Math.min(joined.length, e + 30)) });
    }
  });
  return hits;
}

function SearchPanel() {
  const doc = useStore((s) => s.doc)!;
  const t = useT();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const key = `${doc.id}-${doc.version}`;
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => () => setHighlights(new Map()), []);
  useEffect(() => { setHits(null); setHighlights(new Map()); }, [key]);

  const run = async () => {
    if (!q.trim()) return;
    setLoading(0);
    const pages = await loadText(doc.pdf, key, (p) => setLoading(p));
    setLoading(null);
    const h = searchPages(pages, q);
    setHits(h);
    setActive(0);
    show(h, 0);
  };
  const show = (h: Hit[], i: number) => {
    const m: Highlights = new Map();
    h.forEach((hit, k) => {
      const arr = m.get(hit.page) ?? [];
      for (const [it, s, e] of hit.ranges) arr.push([it, s, e, k === i]);
      m.set(hit.page, arr);
    });
    setHighlights(m);
    if (h[i]) setState({ scrollTo: { page: h[i].page, nonce: Date.now() } });
  };
  const move = (d: number) => {
    if (!hits?.length) return;
    const i = (active + d + hits.length) % hits.length;
    setActive(i);
    show(hits, i);
  };
  const noText = useMemo(() => {
    const c = getTextCache(key);
    return c ? c.every((p) => p.every((it) => !it.str.trim())) : false;
  }, [hits, key]);

  return (
    <div className="search-panel">
      <form className="search-row" onSubmit={(e) => { e.preventDefault(); run(); }} role="search">
        <input ref={input} className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search.placeholder")} aria-label={t("search.placeholder")} />
        <IconButton label={t("search.go")} type="submit"><Search size={16} /></IconButton>
      </form>
      {loading != null && <div className="muted small">{t("search.indexing")} {Math.round(loading * 100)}%</div>}
      {hits && (
        <div className="search-nav">
          <span>{hits.length ? t("search.count", { i: active + 1, n: hits.length }) : t("search.none")}</span>
          <Button small onClick={() => move(-1)} disabled={!hits.length}>{t("search.prev")}</Button>
          <Button small onClick={() => move(1)} disabled={!hits.length}>{t("search.next")}</Button>
        </div>
      )}
      {hits && !hits.length && noText && <p className="muted small">{t("search.scannedHint")}</p>}
      <ol className="search-hits">
        {hits?.slice(0, 500).map((h, i) => (
          <li key={i}>
            <button type="button" className={cls(i === active && "on")} onClick={() => { setActive(i); show(hits, i); }}>
              <span className="muted small">{t("viewer.page", { n: h.page + 1 })}</span>
              <span className="snippet" dir="auto">{h.snippet}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ------------------------------------------------------------------- comments
interface Ann { id: string; page: number; subtype: string; contents: string; author: string; rect: number[] }

function Comments() {
  const doc = useStore((s) => s.doc)!;
  const t = useT();
  const [list, setList] = useState<Ann[] | null>(null);
  const [edit, setEdit] = useState<Ann | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      const out: Ann[] = [];
      for (let i = 0; i < doc.numPages && i < 2000; i++) {
        const p = await doc.pdf.getPage(i + 1);
        const anns = await p.getAnnotations();
        for (const a of anns as any[]) {
          if (["Link", "Widget", "Popup"].includes(a.subtype)) continue;
          out.push({ id: a.id, page: i, subtype: a.subtype, contents: a.contentsObj?.str ?? "", author: a.titleObj?.str ?? "", rect: a.rect });
        }
      }
      if (alive) setList(out);
    })().catch(() => alive && setList([]));
    return () => { alive = false; };
  }, [doc.pdf]);
  if (!list) return <div className="muted small pad">{t("common.loading")}</div>;
  if (!list.length) return <Empty icon={<MessageSquare size={28} />} title={t("comments.none")}>{t("comments.hint")}</Empty>;
  const del = async (a: Ann) => {
    if (!(await confirmDialog(t("comments.deleteTitle"), t("comments.deleteBody")))) return;
    await runOnDoc("annot_edit", { actions: [{ id: a.id, action: "delete" }] }, t("comments.delete"));
  };
  return (
    <>
      <ul className="comment-list">
        {list.map((a) => (
          <li key={a.id}>
            <button type="button" className="comment-main" onClick={() => setState({ scrollTo: { page: a.page, nonce: Date.now() } })}>
              <span className="badge badge-info">{t(`annot.${a.subtype}`) === `annot.${a.subtype}` ? a.subtype : t(`annot.${a.subtype}`)}</span>
              <span className="muted small"> {t("viewer.page", { n: a.page + 1 })}{a.author ? ` — ${a.author}` : ""}</span>
              {a.contents && <div className="comment-text" dir="auto">{a.contents}</div>}
            </button>
            <div className="row-actions">
              <IconButton label={t("comments.edit")} onClick={() => { setEdit(a); setText(a.contents); }}><Edit3 size={14} /></IconButton>
              <IconButton label={t("comments.delete")} onClick={() => del(a)}><Trash2 size={14} /></IconButton>
            </div>
          </li>
        ))}
      </ul>
      <Modal open={!!edit} title={t("comments.edit")} onClose={() => setEdit(null)}
        footer={<><Button onClick={() => setEdit(null)}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={async () => { const a = edit!; setEdit(null); await runOnDoc("annot_edit", { actions: [{ id: a.id, action: "update", contents: text }] }, t("comments.edit")); }}>{t("common.save")}</Button></>}>
        <textarea className="input" rows={5} value={text} onChange={(e) => setText(e.target.value)} dir="auto" aria-label={t("comments.text")} />
      </Modal>
    </>
  );
}

function Attachments() {
  const doc = useStore((s) => s.doc)!;
  const t = useT();
  const lang = useStore((s) => s.lang);
  const [items, setItems] = useState<{ filename: string; content: Uint8Array }[] | null>(null);
  useEffect(() => {
    doc.pdf.getAttachments().then((a: any) => setItems(a ? Object.values(a) as any : [])).catch(() => setItems([]));
  }, [doc.pdf]);
  if (!items) return <div className="muted small pad">{t("common.loading")}</div>;
  return (
    <div>
      {!items.length && <Empty icon={<Paperclip size={28} />} title={t("attach.none")} />}
      <ul className="attach-list">
        {items.map((a, i) => (
          <li key={i}>
            <Paperclip size={14} />
            <span className="grow" dir="auto">{a.filename}</span>
            <span className="muted small">{formatBytes(a.content.byteLength, lang)}</span>
            <IconButton label={t("common.download")} onClick={() => downloadBlob(new Blob([a.content]), a.filename)}><Download size={14} /></IconButton>
          </li>
        ))}
      </ul>
      <p className="muted small">{t("attach.manageHint")}</p>
      <Button small onClick={() => setState({ tool: "attachments", panelOpen: true })}>{t("tool.attachments")}</Button>
    </div>
  );
}

function Properties() {
  const doc = useStore((s) => s.doc)!;
  const lang = useStore((s) => s.lang);
  const t = useT();
  const [meta, setMeta] = useState<Record<string, any> | null>(null);
  const [perm, setPerm] = useState<number[] | null>(null);
  const [size, setSize] = useState<string>("");
  useEffect(() => {
    doc.pdf.getMetadata().then((m: any) => setMeta(m.info || {})).catch(() => setMeta({}));
    doc.pdf.getPermissions().then((p) => setPerm(p)).catch(() => setPerm(null));
    doc.pdf.getPage(1).then((p) => {
      const v = p.getViewport({ scale: 1 });
      setSize(`${Math.round(v.width * 0.3528)} × ${Math.round(v.height * 0.3528)} mm`);
    });
  }, [doc.pdf]);
  const fmtDate = (s?: string) => {
    if (!s) return "-";
    const m = s.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
    return m ? `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"} ${m[4] ?? "00"}:${m[5] ?? "00"}` : s;
  };
  const rows: [string, string][] = [
    [t("props.file"), doc.name],
    [t("props.size"), formatBytes(doc.bytes.byteLength, lang)],
    [t("props.pages"), String(doc.numPages)],
    [t("props.pageSize"), size],
    [t("props.version"), meta?.PDFFormatVersion ?? "-"],
    [t("props.title"), meta?.Title || "-"],
    [t("props.author"), meta?.Author || "-"],
    [t("props.subject"), meta?.Subject || "-"],
    [t("props.keywords"), meta?.Keywords || "-"],
    [t("props.creator"), meta?.Creator || "-"],
    [t("props.producer"), meta?.Producer || "-"],
    [t("props.created"), fmtDate(meta?.CreationDate)],
    [t("props.modified"), fmtDate(meta?.ModDate)],
    [t("props.encrypted"), doc.password || meta?.IsEncrypted ? t("common.yes") : t("common.no")],
    [t("props.restrictions"), perm ? t("props.restricted") : t("props.none")],
    [t("props.forms"), meta?.IsAcroFormPresent ? t("common.yes") : t("common.no")],
    [t("props.linearized"), meta?.IsLinearized ? t("common.yes") : t("common.no")],
  ];
  return (
    <div>
      <dl className="props">
        {rows.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd dir="auto">{v}</dd></div>
        ))}
      </dl>
      <Button small onClick={() => setState({ tool: "metadata", panelOpen: true })}>{t("tool.metadata")}</Button>
      <Button small onClick={() => setState({ tool: "inspect", panelOpen: true })}>{t("tool.inspect")}</Button>
      <p className="muted small">{t("props.serverNote")}</p>
    </div>
  );
}
