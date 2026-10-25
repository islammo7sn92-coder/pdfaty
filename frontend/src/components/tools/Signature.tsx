import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { useT } from "../../i18n";
import { runOnDoc } from "../../lib/actions";
import { setOverlay, type PageInfo } from "../../lib/overlay";
import { toast } from "../../lib/store";
import { dataUrlToBlob, storage, uid } from "../../lib/utils";
import { Button, Field, IconButton, Segmented } from "../ui";
import { PlacedBox, pagePoint } from "./common";

interface Placement { id: string; page: number; x: number; y: number; w: number; h: number }

/** Crop transparent/white margins and optionally make near-white pixels transparent. */
function cleanup(src: HTMLCanvasElement, removeWhite: boolean, threshold = 235): HTMLCanvasElement {
  const ctx = src.getContext("2d")!;
  const { width: w, height: h } = src;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (removeWhite && d[i] >= threshold && d[i + 1] >= threshold && d[i + 2] >= threshold) d[i + 3] = 0;
      if (d[i + 3] > 20) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
  }
  ctx.putImageData(img, 0, 0);
  if (maxX < 0) return src;
  const pad = 4;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad); maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d")!.drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

export default function Signature() {
  const t = useT();
  const [tab, setTab] = useState<"draw" | "upload" | "type">("draw");
  const [sig, setSig] = useState<{ url: string; w: number; h: number } | null>(null);
  const [saved, setSaved] = useState<string[]>(() => storage.get("pdfaty.signatures", []));
  const [remember, setRemember] = useState(false);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [opacity, setOpacity] = useState(1);
  const [pages, setPages] = useState("");
  const [pen, setPen] = useState({ color: "#0b2e83", width: 3 });
  const [typed, setTyped] = useState({ text: "", font: "cursive", color: "#0b2e83" });
  const [removeWhite, setRemoveWhite] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const uploadRaw = useRef<HTMLImageElement | null>(null);

  const useCanvas = (c: HTMLCanvasElement, white: boolean) => {
    const out = cleanup(c, white);
    setSig({ url: out.toDataURL("image/png"), w: out.width, h: out.height });
  };

  // ---- draw pad
  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) * e.currentTarget.width) / r.width, ((e.clientY - r.top) * e.currentTarget.height) / r.height];
  };
  const clearPad = () => {
    const c = canvas.current;
    if (c) c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
  };

  // ---- typed
  useEffect(() => {
    if (tab !== "type" || !typed.text.trim()) return;
    const c = document.createElement("canvas");
    c.width = 1200; c.height = 300;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = typed.color;
    ctx.font = `italic 140px ${typed.font === "cursive" ? "cursive" : `"IBM Plex Sans Arabic", serif`}`;
    ctx.textBaseline = "middle";
    ctx.direction = /[؀-ۿ]/.test(typed.text) ? "rtl" : "ltr";
    ctx.textAlign = "center";
    ctx.fillText(typed.text, 600, 150, 1150);
    useCanvas(c, false);
  }, [typed, tab]);

  const onUpload = async (f: File) => {
    const img = new Image();
    img.src = URL.createObjectURL(f);
    await img.decode();
    uploadRaw.current = img;
    processUpload(removeWhite);
  };
  const processUpload = (white: boolean) => {
    const img = uploadRaw.current;
    if (!img) return;
    const c = document.createElement("canvas");
    const s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    c.width = img.naturalWidth * s; c.height = img.naturalHeight * s;
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    useCanvas(c, white);
  };
  useEffect(() => { if (tab === "upload") processUpload(removeWhite); }, [removeWhite]);

  // ---- placement overlay
  useEffect(() => {
    setOverlay({
      capture: !!sig,
      cursor: sig ? "copy" : undefined,
      render: (p: PageInfo) => {
        const s = p.scale;
        return (
          <div className="ov-fill" onPointerDown={(e) => {
            if (!sig || e.target !== e.currentTarget) return;
            const pt = pagePoint(e, e.currentTarget, s);
            const w = 150, h = (150 * sig.h) / sig.w;
            const pl = { id: uid(), page: p.index, x: pt.x - w / 2, y: pt.y - h / 2, w, h };
            setPlacements((x) => [...x, pl]);
            setSel(pl.id);
          }}>
            {placements.filter((x) => x.page === p.index).map((pl) => (
              <PlacedBox key={pl.id} {...pl} scale={s} selected={sel === pl.id} onSelect={() => setSel(pl.id)} label={t("tool.signature")}
                onChange={(r) => setPlacements((x) => x.map((q) => (q.id === pl.id ? { ...q, ...r, h: sig ? (r.w * sig.h) / sig.w : r.h } : q)))}
                onDelete={() => setPlacements((x) => x.filter((q) => q.id !== pl.id))}>
                {sig && <img src={sig.url} alt="" draggable={false} style={{ width: "100%", height: "100%", opacity }} />}
              </PlacedBox>
            ))}
          </div>
        );
      },
    });
  }, [sig, placements, sel, opacity]);
  useEffect(() => () => setOverlay(null), []);

  const apply = async () => {
    if (!sig || !placements.length) { toast("info", t("sig.placeFirst")); return; }
    if (remember && !saved.includes(sig.url)) {
      const next = [...saved, sig.url].slice(-5);
      setSaved(next);
      storage.set("pdfaty.signatures", next);
    }
    const blob = await dataUrlToBlob(sig.url);
    const items = placements.map((pl) => ({ type: "image", page: pl.page, x: pl.x, y: pl.y, w: pl.w, h: pl.h, file: 1, opacity, ...(pages.trim() ? { pages: pages.trim() } : {}) }));
    const uniq = pages.trim() ? items.slice(0, 1) : items;
    const res = await runOnDoc("edit_overlay", { items: uniq }, t("tool.signature"), [{ name: "signature.png", data: blob }]);
    if (res) { setPlacements([]); toast("success", t("sig.done")); }
  };

  return (
    <div className="form">
      <p className="note">{t("sig.legal")}</p>
      <Segmented label={t("sig.source")} value={tab} onChange={setTab} options={[{ value: "draw", label: t("sig.draw") }, { value: "upload", label: t("sig.upload") }, { value: "type", label: t("sig.type") }]} />
      {tab === "draw" && (
        <div>
          <canvas ref={canvas} className="sigpad" width={900} height={300} aria-label={t("sig.padLabel")}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drawing.current = true; const ctx = e.currentTarget.getContext("2d")!; const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); }}
            onPointerMove={(e) => { if (!drawing.current) return; const ctx = e.currentTarget.getContext("2d")!; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.strokeStyle = pen.color; ctx.lineWidth = pen.width * 2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke(); }}
            onPointerUp={() => { drawing.current = false; }} />
          <div className="row wrap">
            <Field label={t("f.color")} inline><input type="color" value={pen.color} onChange={(e) => setPen({ ...pen, color: e.target.value })} /></Field>
            <Field label={t("f.strokeWidth")} inline><input type="range" min={1} max={8} value={pen.width} onChange={(e) => setPen({ ...pen, width: Number(e.target.value) })} /></Field>
            <Button small onClick={clearPad}>{t("common.clear")}</Button>
            <Button small variant="primary" onClick={() => canvas.current && useCanvas(canvas.current, false)}>{t("sig.use")}</Button>
          </div>
        </div>
      )}
      {tab === "upload" && (
        <div>
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }} aria-label={t("sig.upload")} />
          <label className="check"><input type="checkbox" checked={removeWhite} onChange={(e) => setRemoveWhite(e.target.checked)} />{t("sig.removeWhite")}</label>
          <p className="muted small">{t("sig.cropNote")}</p>
        </div>
      )}
      {tab === "type" && (
        <div>
          <input className="input" dir="auto" value={typed.text} onChange={(e) => setTyped({ ...typed, text: e.target.value })} placeholder={t("sig.typePh")} aria-label={t("sig.type")} />
          <div className="row wrap">
            <Field label={t("f.font")} inline><select className="input" value={typed.font} onChange={(e) => setTyped({ ...typed, font: e.target.value })}><option value="cursive">{t("sig.fontCursive")}</option><option value="plex">{t("sig.fontPlain")}</option></select></Field>
            <Field label={t("f.color")} inline><input type="color" value={typed.color} onChange={(e) => setTyped({ ...typed, color: e.target.value })} /></Field>
          </div>
        </div>
      )}
      {saved.length > 0 && (
        <div>
          <strong className="small">{t("sig.saved")}</strong>
          <div className="asset-row">
            {saved.map((u, i) => (
              <span key={i} className="asset-wrap">
                <button type="button" className="asset" onClick={() => { const im = new Image(); im.onload = () => setSig({ url: u, w: im.width, h: im.height }); im.src = u; }}><img src={u} alt={t("sig.saved")} /></button>
                <IconButton label={t("common.delete")} onClick={() => { const n = saved.filter((_, k) => k !== i); setSaved(n); storage.set("pdfaty.signatures", n); }}><Trash2 size={12} /></IconButton>
              </span>
            ))}
          </div>
        </div>
      )}
      {sig && (
        <div className="sig-preview">
          <img src={sig.url} alt={t("sig.preview")} />
          <p className="muted small">{t("sig.clickToPlace")}</p>
        </div>
      )}
      <Field label={`${t("f.opacity")}: ${opacity}`}><input type="range" min={0.2} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} /></Field>
      <Field label={t("sig.pages")} help={t("sig.pagesHelp")}><input className="input" dir="ltr" value={pages} onChange={(e) => setPages(e.target.value)} placeholder={t("f.pagesPlaceholder")} /></Field>
      <label className="check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{t("sig.remember")}</label>
      <div className="tool-actions">
        <Button onClick={() => setPlacements([])} disabled={!placements.length}>{t("common.clear")}</Button>
        <Button variant="primary" onClick={apply} disabled={!sig || !placements.length}>{t("sig.apply", { n: placements.length })}</Button>
      </div>
    </div>
  );
}
