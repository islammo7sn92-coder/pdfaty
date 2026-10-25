import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { pdfjsLib, resolveDest } from "../lib/pdf";
import { getState, setState, useStore } from "../lib/store";
import { useHighlights, useOverlay, type PageInfo } from "../lib/overlay";
import { useT } from "../i18n";

interface Size { w: number; h: number }

const MAX_CANVAS_PIXELS = 16_000_000;

export default function Viewer() {
  const doc = useStore((s) => s.doc);
  const scale = useStore((s) => s.scale);
  const fit = useStore((s) => s.fit);
  const mode = useStore((s) => s.mode);
  const page = useStore((s) => s.page);
  const scrollTo = useStore((s) => s.scrollTo);
  const overlay = useOverlay();
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<Size[]>([]);

  // page sizes (points, after /Rotate), fetched progressively
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    const pdf = doc.pdf;
    (async () => {
      const first = await pdf.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      const init = Array.from({ length: pdf.numPages }, () => ({ w: vp.width, h: vp.height }));
      if (!cancelled) setSizes(init);
      const out = init.slice();
      for (let i = 1; i < pdf.numPages && !cancelled; i++) {
        const p = await pdf.getPage(i + 1);
        const v = p.getViewport({ scale: 1 });
        out[i] = { w: v.width, h: v.height };
        if (i % 50 === 0 || i === pdf.numPages - 1) if (!cancelled) setSizes(out.slice());
      }
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [doc?.pdf]);

  // fit to width/page
  const computeFit = useCallback(() => {
    const el = box.current;
    if (!el || !sizes.length || !fit) return;
    const maxW = Math.max(...sizes.slice(0, 50).map((s) => s.w));
    const cols = mode === "double" ? 2 : 1;
    const avail = el.clientWidth - 48;
    let s = (avail - (cols - 1) * 16) / (maxW * cols);
    if (fit === "page") {
      const h = sizes[getState().page]?.h ?? sizes[0].h;
      s = Math.min(s, (el.clientHeight - 32) / h);
    }
    s = Math.max(0.2, Math.min(4, s));
    if (Math.abs(s - getState().scale) > 0.005) setState({ scale: s });
  }, [sizes, fit, mode]);
  useLayoutEffect(() => { computeFit(); }, [computeFit]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => computeFit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [computeFit]);

  // rows of pages
  const rows = useMemo(() => {
    const n = sizes.length;
    if (mode === "single") return n ? [[Math.min(page, n - 1)]] : [];
    if (mode === "double") {
      const r: number[][] = [];
      for (let i = 0; i < n; i += 2) r.push(i + 1 < n ? [i, i + 1] : [i]);
      return r;
    }
    return Array.from({ length: n }, (_, i) => [i]);
  }, [sizes.length, mode, mode === "single" ? page : 0]);

  // scroll requests
  useEffect(() => {
    if (!scrollTo || !box.current) return;
    if (mode === "single") {
      setState({ page: scrollTo.page });
      box.current.scrollTop = scrollTo.y ? scrollTo.y * getState().scale - 40 : 0;
      return;
    }
    const el = box.current.querySelector<HTMLElement>(`[data-page="${scrollTo.page}"]`);
    if (el) {
      const top = el.offsetTop - 16 + (scrollTo.y ? scrollTo.y * getState().scale - 60 : 0);
      box.current.scrollTo({ top: Math.max(0, top) });
    }
  }, [scrollTo?.nonce, sizes.length > 0]);

  // track current page while scrolling
  const onScroll = useCallback(() => {
    const el = box.current;
    if (!el || mode === "single") return;
    const mid = el.scrollTop + el.clientHeight / 3;
    const nodes = el.querySelectorAll<HTMLElement>("[data-page]");
    let best = 0;
    for (const n of Array.from(nodes)) {
      if (n.offsetTop <= mid) best = Number(n.dataset.page);
      else break;
    }
    if (best !== getState().page) setState({ page: best });
  }, [mode]);

  // ctrl + wheel zoom
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const s = getState().scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
      setState({ scale: Math.max(0.2, Math.min(5, s)), fit: null });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  if (!doc) return null;
  return (
    <div className={`viewer ${overlay?.capture ? "drawing" : ""}`} ref={box} onScroll={onScroll} tabIndex={0} aria-label={t("viewer.label")}>
      {rows.map((r) => (
        <div className="page-row" key={r.join("-")}>
          {r.map((i) => (
            <PageView key={`${doc.id}-${doc.version}-${i}`} pdf={doc.pdf} index={i} scale={scale} size={sizes[i]} root={box} />
          ))}
        </div>
      ))}
    </div>
  );
}

function PageView({ pdf, index, scale, size, root }: { pdf: PDFDocumentProxy; index: number; scale: number; size: Size; root: React.RefObject<HTMLDivElement | null> }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [pageObj, setPageObj] = useState<PDFPageProxy | null>(null);
  const [links, setLinks] = useState<{ rect: number[]; url?: string; dest?: any }[]>([]);
  const [textDivs, setTextDivs] = useState<{ divs: HTMLElement[]; strs: string[] } | null>(null);
  const overlay = useOverlay();
  const highlights = useHighlights();
  const t = useT();
  const w = size.w * scale;
  const h = size.h * scale;

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setVisible(es[0].isIntersecting), { root: root.current, rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    pdf.getPage(index + 1).then((p) => alive && setPageObj(p)).catch(() => undefined);
    return () => { alive = false; };
  }, [visible, pdf, index]);

  // canvas: render into a fresh canvas and swap it in when complete, so a cancelled
  // render can never paint over a newer one (and the old image stays visible meanwhile)
  useEffect(() => {
    const holderEl = canvasRef.current;
    if (!visible || !pageObj || !holderEl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let rs = scale * dpr;
    const base = pageObj.getViewport({ scale: 1 });
    if (base.width * base.height * rs * rs > MAX_CANVAS_PIXELS) rs = Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height));
    const vp = pageObj.getViewport({ scale: rs });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    c.style.width = "100%";
    c.style.height = "100%";
    c.setAttribute("aria-hidden", "true");
    const task = pageObj.render({ canvasContext: c.getContext("2d")!, canvas: c, viewport: vp });
    let alive = true;
    task.promise.then(() => { if (alive) holderEl.replaceChildren(c); }).catch(() => undefined);
    return () => { alive = false; task.cancel(); };
  }, [visible, pageObj, scale]);

  // text layer + links
  useEffect(() => {
    if (!visible || !pageObj || !textRef.current) return;
    const div = textRef.current;
    div.replaceChildren();
    const vp = pageObj.getViewport({ scale });
    let alive = true;
    const tl = new pdfjsLib.TextLayer({ textContentSource: pageObj.streamTextContent(), container: div, viewport: vp });
    tl.render()
      .then(() => { if (alive) setTextDivs({ divs: tl.textDivs as HTMLElement[], strs: tl.textContentItemsStr as string[] }); })
      .catch(() => undefined);
    pageObj.getAnnotations({ intent: "display" }).then((anns) => {
      if (!alive) return;
      setLinks(anns.filter((a: any) => a.subtype === "Link" && (a.url || a.dest)).map((a: any) => ({ rect: vp.convertToViewportRectangle(a.rect), url: a.url, dest: a.dest })));
    }).catch(() => undefined);
    return () => { alive = false; tl.cancel(); };
  }, [visible, pageObj, scale]);

  // search highlights
  useEffect(() => {
    if (!textDivs) return;
    const marks = highlights.get(index);
    textDivs.divs.forEach((d, i) => {
      if (d.dataset.hl) {
        d.textContent = textDivs.strs[i];
        delete d.dataset.hl;
      }
    });
    if (!marks) return;
    const byItem = new Map<number, [number, number, boolean][]>();
    for (const [it, s, e, active] of marks) {
      if (!byItem.has(it)) byItem.set(it, []);
      byItem.get(it)!.push([s, e, active]);
    }
    for (const [it, ranges] of byItem) {
      const d = textDivs.divs[it];
      const str = textDivs.strs[it];
      if (!d || str == null) continue;
      d.replaceChildren();
      let pos = 0;
      for (const [s, e, active] of ranges.sort((a, b) => a[0] - b[0])) {
        if (s > pos) d.append(document.createTextNode(str.slice(pos, s)));
        const m = document.createElement("mark");
        m.className = active ? "hl active" : "hl";
        m.textContent = str.slice(s, e);
        d.append(m);
        pos = e;
      }
      if (pos < str.length) d.append(document.createTextNode(str.slice(pos)));
      d.dataset.hl = "1";
    }
  }, [highlights, textDivs, index]);

  const info: PageInfo | null = useMemo(
    () => (pageObj ? { index, scale, width: w, height: h, viewport: pageObj.getViewport({ scale }) } : null),
    [pageObj, scale, index, w, h],
  );

  const goDest = async (dest: any) => {
    const p = await resolveDest(pdf, dest);
    if (p != null) setState({ scrollTo: { page: p, nonce: Date.now() } });
  };

  return (
    <div className="page" data-page={index} ref={holder} style={{ width: w, height: h, ["--scale-factor" as any]: scale, ["--total-scale-factor" as any]: scale }}
      aria-label={t("viewer.page", { n: index + 1 })}>
      {visible && <div className="canvas-holder" ref={canvasRef} style={{ width: w, height: h }} />}
      {visible && <div className="textLayer" ref={textRef} />}
      {visible && !overlay?.capture && links.map((l, i) => {
        const [x1, y1, x2, y2] = l.rect;
        const style = { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
        return l.url ? (
          <a key={i} className="pdf-link" href={l.url} target="_blank" rel="noopener noreferrer nofollow" style={style} title={l.url} />
        ) : (
          <button key={i} type="button" className="pdf-link" style={style} onClick={() => goDest(l.dest)} aria-label={t("viewer.internalLink")} />
        );
      })}
      {visible && overlay && info && (
        <div className={`overlay ${overlay.capture ? "capture" : ""}`} style={{ cursor: overlay.cursor }}>
          {overlay.render(info)}
        </div>
      )}
      {!visible && <div className="page-ph">{index + 1}</div>}
    </div>
  );
}
