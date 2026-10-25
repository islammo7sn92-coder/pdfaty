import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Circle, Eraser, Image as ImageIcon, Link2, Minus, MousePointer2, Square, Trash2, Type } from "lucide-react";
import { useT } from "../../i18n";
import { runOnDoc } from "../../lib/actions";
import { setOverlay, type PageInfo } from "../../lib/overlay";
import { toast, useStore } from "../../lib/store";
import { uid } from "../../lib/utils";
import { Button, Field, IconButton } from "../ui";
import { pagePoint, PlacedBox, useRectDraw, type Pt } from "./common";

type Mode = "select" | "text" | "image" | "rect" | "ellipse" | "line" | "arrow" | "whiteout" | "link";
export interface EditItem {
  id: string; type: Exclude<Mode, "select">; page: number;
  x: number; y: number; w: number; h: number; x1?: number; y1?: number; x2?: number; y2?: number;
  text?: string; size?: number; color?: string; bold?: boolean; family?: string; align?: string; bg?: string | null;
  stroke?: string | null; fill?: string | null; stroke_width?: number; opacity?: number; imageKey?: string;
  url?: string; dest_page?: number | null; pages?: string; rotation?: number;
}

export interface ImageAsset { key: string; file: File; url: string; w: number; h: number }

export async function loadImageAsset(f: File): Promise<ImageAsset> {
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.src = url;
  await img.decode();
  return { key: uid(), file: f, url, w: img.naturalWidth, h: img.naturalHeight };
}

export function itemsPayload(items: EditItem[], assets: ImageAsset[]) {
  const used = assets.filter((a) => items.some((i) => i.imageKey === a.key));
  const files = used.map((a) => ({ name: a.file.name || "image.png", data: a.file as Blob }));
  const payload = items.map(({ id, imageKey, ...rest }) => {
    void id;
    const out: Record<string, any> = { ...rest };
    if (rest.type === "image") out.file = 1 + used.findIndex((a) => a.key === imageKey);
    if (rest.pages) { out.pages = rest.pages; delete out.page; }
    else delete out.pages;
    return out;
  });
  return { payload, files };
}

export default function AddContent() {
  const t = useT();
  const page = useStore((s) => s.page);
  const [mode, setMode] = useState<Mode>("text");
  const [items, setItems] = useState<EditItem[]>([]);
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const [current, setCurrent] = useState<string | null>(null); // image asset to place
  const [sel, setSel] = useState<string | null>(null);
  const [style, setStyle] = useState({ color: "#000000", size: 14, bold: false, family: "sans", stroke: "#d01010", fill: "", stroke_width: 2 });
  const [line, setLine] = useState<{ page: number; a: Pt; b: Pt } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const add = (it: Omit<EditItem, "id">) => {
    const item = { id: uid(), ...it };
    setItems((x) => [...x, item]);
    setSel(item.id);
  };
  const update = (id: string, patch: Partial<EditItem>) => setItems((x) => x.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const remove = (id: string) => setItems((x) => x.filter((i) => i.id !== id));

  const rect = useRectDraw((pg, r) => {
    const tiny = r.w < 4;
    if (mode === "text") add({ type: "text", page: pg, ...(tiny ? { x: r.x, y: r.y, w: 220, h: style.size * 2 } : r), text: "", color: style.color, size: style.size, bold: style.bold, family: style.family });
    else if (mode === "image") {
      const a = assets.find((x) => x.key === current);
      if (!a) { toast("info", t("edit.pickImageFirst")); return; }
      let box = r;
      if (tiny) { const w = Math.min(200, a.w); box = { x: r.x, y: r.y, w, h: (w * a.h) / a.w }; }
      else box = { ...r, h: (r.w * a.h) / a.w };
      add({ type: "image", page: pg, ...box, imageKey: a.key });
    } else if (tiny) return;
    else if (mode === "rect" || mode === "ellipse") add({ type: mode, page: pg, ...r, stroke: style.stroke, fill: style.fill || null, stroke_width: style.stroke_width });
    else if (mode === "whiteout") add({ type: "whiteout", page: pg, ...r, fill: "#ffffff" });
    else if (mode === "link") add({ type: "link", page: pg, ...r, url: "https://" });
  });

  useEffect(() => {
    const capture = mode !== "select";
    setOverlay({
      capture,
      cursor: capture ? "crosshair" : undefined,
      render: (p: PageInfo) => {
        const s = p.scale;
        const mine = items.filter((i) => i.page === p.index);
        const lineHandlers = {
          onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => { if (e.target !== e.currentTarget) return; e.currentTarget.setPointerCapture(e.pointerId); const a = pagePoint(e, e.currentTarget, s); setLine({ page: p.index, a, b: a }); },
          onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => { if (line?.page === p.index) setLine({ ...line, b: pagePoint(e, e.currentTarget, s) }); },
          onPointerUp: () => {
            if (line && Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y) > 4) {
              const x = Math.min(line.a.x, line.b.x), y = Math.min(line.a.y, line.b.y);
              add({ type: mode as "line", page: p.index, x, y, w: Math.abs(line.b.x - line.a.x), h: Math.abs(line.b.y - line.a.y), x1: line.a.x, y1: line.a.y, x2: line.b.x, y2: line.b.y, stroke: style.stroke, stroke_width: style.stroke_width });
            }
            setLine(null);
          },
        };
        const handlers = mode === "line" || mode === "arrow" ? lineHandlers : rect.handlers(p.index, s);
        return (
          <div className="ov-fill" {...(capture ? handlers : {})}>
            <svg className="ov-svg" width={p.width} height={p.height}>
              <defs><marker id="ah2" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill={style.stroke} /></marker></defs>
              {mine.filter((i) => i.x1 != null).map((i) => (
                <line key={i.id} x1={i.x1! * s} y1={i.y1! * s} x2={i.x2! * s} y2={i.y2! * s} stroke={i.stroke ?? "#d01010"} strokeWidth={(i.stroke_width ?? 2) * s} markerEnd={i.type === "arrow" ? "url(#ah2)" : undefined}
                  onClick={() => setSel(i.id)} style={{ pointerEvents: "stroke" }} />
              ))}
              {line?.page === p.index && <line x1={line.a.x * s} y1={line.a.y * s} x2={line.b.x * s} y2={line.b.y * s} stroke={style.stroke} strokeWidth={style.stroke_width * s} />}
            </svg>
            {mine.filter((i) => i.x1 == null).map((i) => {
              const a = assets.find((x) => x.key === i.imageKey);
              return (
                <PlacedBox key={i.id} x={i.x} y={i.y} w={i.w} h={i.h} scale={s} selected={sel === i.id} onSelect={() => setSel(i.id)} onDelete={() => remove(i.id)}
                  onChange={(r) => update(i.id, i.type === "image" && a ? { ...r, h: (r.w * a.h) / a.w } : r)} label={t(`editm.${i.type}`)} className={`edit-${i.type}`}>
                  {i.type === "text" && <div className="text-preview" dir="auto" style={{ fontSize: (i.size ?? 14) * s, color: i.color, fontWeight: i.bold ? 700 : 400, fontFamily: i.family === "serif" ? "serif" : i.family === "mono" ? "monospace" : undefined, textAlign: (i.align as any) || undefined }}>{i.text || t("annot.typeHere")}</div>}
                  {i.type === "image" && a && <img src={a.url} alt="" draggable={false} style={{ width: "100%", height: "100%", opacity: i.opacity ?? 1 }} />}
                  {(i.type === "rect" || i.type === "ellipse") && <div className="shape-preview" style={{ borderColor: i.stroke ?? "transparent", background: i.fill ?? "transparent", borderWidth: (i.stroke_width ?? 2) * s, borderRadius: i.type === "ellipse" ? "50%" : 0 }} />}
                  {i.type === "whiteout" && <div className="shape-preview" style={{ background: "#fff", outline: "1px dashed #999" }} />}
                  {i.type === "link" && <div className="shape-preview link-preview" title={i.url ?? ""} />}
                </PlacedBox>
              );
            })}
            {rect.draftRect(p.index, s)}
          </div>
        );
      },
    });
  }, [items, mode, sel, assets, current, style, line, rect]);
  useEffect(() => () => { setOverlay(null); }, []);
  useEffect(() => () => assets.forEach((a) => URL.revokeObjectURL(a.url)), []);

  const apply = async () => {
    const valid = items.filter((i) => !(i.type === "text" && !i.text?.trim()) && !(i.type === "link" && !(i.url && i.url.length > 8) && i.dest_page == null));
    if (!valid.length) { toast("info", t("edit.nothing")); return; }
    const { payload, files } = itemsPayload(valid, assets);
    const res = await runOnDoc("edit_overlay", { items: payload }, t("tool.add_content"), files);
    if (res) { setItems([]); toast("success", t("edit.applied")); }
  };

  const it = items.find((i) => i.id === sel);
  const modes: [Mode, any][] = [["text", Type], ["image", ImageIcon], ["rect", Square], ["ellipse", Circle], ["line", Minus], ["arrow", ArrowUpRight], ["whiteout", Eraser], ["link", Link2], ["select", MousePointer2]];
  return (
    <div className="form">
      <div className="mode-grid" role="radiogroup" aria-label={t("annot.mode")}>
        {modes.map(([m, Icon]) => <IconButton key={m} label={t(`editm.${m}`)} active={mode === m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)}><Icon size={18} /></IconButton>)}
      </div>
      <p className="muted small">{t(`edith.${mode}`)}</p>
      {mode === "image" && (
        <div>
          <Button onClick={() => fileRef.current?.click()} icon={<ImageIcon size={16} />}>{t("edit.chooseImage")}</Button>
          <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" onChange={async (e) => {
            const f = e.target.files?.[0]; e.target.value = "";
            if (!f) return;
            try { const a = await loadImageAsset(f); setAssets((x) => [...x, a]); setCurrent(a.key); } catch { toast("error", t("err.image_required")); }
          }} />
          <div className="asset-row">
            {assets.map((a) => <button key={a.key} type="button" className={`asset ${current === a.key ? "on" : ""}`} onClick={() => setCurrent(a.key)}><img src={a.url} alt={a.file.name} /></button>)}
          </div>
        </div>
      )}
      {["text"].includes(mode) && !it && (
        <div className="row wrap">
          <Field label={t("f.fontSize")} inline><input type="number" className="input small-num" min={5} max={144} value={style.size} onChange={(e) => setStyle({ ...style, size: Number(e.target.value) })} /></Field>
          <Field label={t("f.color")} inline><input type="color" value={style.color} onChange={(e) => setStyle({ ...style, color: e.target.value })} /></Field>
        </div>
      )}
      {["rect", "ellipse", "line", "arrow"].includes(mode) && (
        <div className="row wrap">
          <Field label={t("f.stroke")} inline><input type="color" value={style.stroke} onChange={(e) => setStyle({ ...style, stroke: e.target.value })} /></Field>
          <Field label={t("f.strokeWidth")} inline><input type="number" className="input small-num" min={0.5} max={30} step={0.5} value={style.stroke_width} onChange={(e) => setStyle({ ...style, stroke_width: Number(e.target.value) })} /></Field>
          {(mode === "rect" || mode === "ellipse") && (
            <label className="check"><input type="checkbox" checked={!!style.fill} onChange={(e) => setStyle({ ...style, fill: e.target.checked ? "#ffe9a8" : "" })} />{t("f.fill")}
              {style.fill && <input type="color" value={style.fill} onChange={(e) => setStyle({ ...style, fill: e.target.value })} />}</label>
          )}
        </div>
      )}
      {it && (
        <div className="item-editor">
          <strong>{t(`editm.${it.type}`)} — {t("viewer.page", { n: it.page + 1 })}</strong>
          {it.type === "text" && (
            <>
              <textarea className="input" rows={3} dir="auto" value={it.text ?? ""} onChange={(e) => update(it.id, { text: e.target.value })} placeholder={t("annot.typeHere")} aria-label={t("annot.text")} autoFocus />
              <div className="row wrap">
                <Field label={t("f.fontSize")} inline><input type="number" className="input small-num" min={5} max={144} value={it.size ?? 14} onChange={(e) => update(it.id, { size: Number(e.target.value) })} /></Field>
                <Field label={t("f.color")} inline><input type="color" value={it.color ?? "#000000"} onChange={(e) => update(it.id, { color: e.target.value })} /></Field>
                <label className="check"><input type="checkbox" checked={!!it.bold} onChange={(e) => update(it.id, { bold: e.target.checked })} />{t("f.bold")}</label>
              </div>
              <div className="row wrap">
                <Field label={t("f.font")} inline>
                  <select className="input" value={it.family ?? "sans"} onChange={(e) => update(it.id, { family: e.target.value })}>
                    <option value="sans">{t("font.sans")}</option><option value="serif">{t("font.serif")}</option><option value="mono">{t("font.mono")}</option>
                  </select>
                </Field>
                <Field label={t("f.align")} inline>
                  <select className="input" value={it.align ?? ""} onChange={(e) => update(it.id, { align: e.target.value })}>
                    <option value="">{t("f.alignAuto")}</option><option value="right">{t("f.alignRight")}</option><option value="center">{t("f.alignCenter")}</option><option value="left">{t("f.alignLeft")}</option>
                  </select>
                </Field>
              </div>
            </>
          )}
          {it.type === "link" && (
            <>
              <Field label={t("edit.linkUrl")}><input className="input" dir="ltr" value={it.url ?? ""} onChange={(e) => update(it.id, { url: e.target.value, dest_page: null })} placeholder="https://example.com" /></Field>
              <Field label={t("edit.linkPage")}><input className="input small-num" type="number" min={1} value={it.dest_page != null ? it.dest_page + 1 : ""} onChange={(e) => update(it.id, { dest_page: e.target.value ? Number(e.target.value) - 1 : null, url: e.target.value ? "" : it.url })} /></Field>
            </>
          )}
          {(it.type === "image" || it.type === "text") && (
            <Field label={t("edit.repeatPages")} help={t("edit.repeatHelp")}>
              <input className="input" dir="ltr" value={it.pages ?? ""} onChange={(e) => update(it.id, { pages: e.target.value })} placeholder={`${page + 1}`} />
            </Field>
          )}
          {it.type === "image" && (
            <Field label={`${t("f.opacity")}: ${it.opacity ?? 1}`}><input type="range" min={0.1} max={1} step={0.05} value={it.opacity ?? 1} onChange={(e) => update(it.id, { opacity: Number(e.target.value) })} /></Field>
          )}
          <Button small variant="ghost" icon={<Trash2 size={14} />} onClick={() => remove(it.id)}>{t("common.delete")}</Button>
        </div>
      )}
      {mode === "whiteout" && <p className="note">{t("edit.whiteoutWarn")}</p>}
      <div className="pending">
        <strong>{t("annot.pending", { n: items.length })}</strong>
        <ul>{items.map((i) => <li key={i.id} className={sel === i.id ? "on" : ""}><button type="button" className="link" onClick={() => setSel(i.id)}>{t(`editm.${i.type}`)} · {t("viewer.page", { n: i.page + 1 })}</button><IconButton label={t("common.delete")} onClick={() => remove(i.id)}><Trash2 size={13} /></IconButton></li>)}</ul>
      </div>
      <div className="tool-actions">
        <Button onClick={() => setItems([])} disabled={!items.length}>{t("common.clear")}</Button>
        <Button variant="primary" onClick={apply} disabled={!items.length}>{t("common.apply")}</Button>
      </div>
    </div>
  );
}
