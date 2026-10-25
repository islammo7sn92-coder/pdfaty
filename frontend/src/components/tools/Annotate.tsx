import { useEffect, useState } from "react";
import {
  ArrowUpRight, Circle, Highlighter, Minus, MousePointer2, Pencil, Square, Stamp, StickyNote, Strikethrough, Trash2, Type, Underline, Waves,
} from "lucide-react";
import { useT } from "../../i18n";
import { runOnDoc } from "../../lib/actions";
import { setOverlay, type PageInfo } from "../../lib/overlay";
import { getState, toast } from "../../lib/store";
import { storage, uid } from "../../lib/utils";
import { Button, Field, IconButton } from "../ui";
import { pagePoint, PlacedBox, useRectDraw, type Pt } from "./common";

type Mode = "select" | "highlight" | "underline" | "strikeout" | "squiggly" | "note" | "freetext" | "ink" | "line" | "arrow" | "square" | "circle" | "stamp";
interface Item {
  id: string; type: Exclude<Mode, "select">; page: number; color: string;
  rects?: number[][]; x?: number; y?: number; w?: number; h?: number; x1?: number; y1?: number; x2?: number; y2?: number;
  paths?: number[][][]; text?: string; contents?: string; stroke_width?: number; size?: number; stamp?: string; fill?: string | null;
}

const STAMPS: [string, string, string][] = [
  ["approved", "stamp.approved", "#1a7f37"], ["rejected", "stamp.rejected", "#cf222e"], ["reviewed", "stamp.reviewed", "#0969da"],
  ["draft", "stamp.draft", "#9a6700"], ["confidential", "stamp.confidential", "#cf222e"], ["final", "stamp.final", "#1a7f37"],
  ["received", "stamp.received", "#8250df"], ["paid", "stamp.paid", "#1a7f37"],
];

/** Merge selection rectangles that lie on the same text line. */
function mergeRects(rs: number[][]): number[][] {
  const sorted = rs.filter((r) => r[2] > 0.5 && r[3] > 0.5).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out: number[][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - r[1]) < Math.max(2, r[3] * 0.4) && r[0] <= last[0] + last[2] + 4) {
      const x0 = Math.min(last[0], r[0]), y0 = Math.min(last[1], r[1]);
      const x1 = Math.max(last[0] + last[2], r[0] + r[2]), y1 = Math.max(last[1] + last[3], r[1] + r[3]);
      out[out.length - 1] = [x0, y0, x1 - x0, y1 - y0];
    } else out.push([...r]);
  }
  return out;
}

export default function Annotate({ only }: { only?: "stamp" }) {
  const t = useT();
  const [mode, setMode] = useState<Mode>(only ? "stamp" : "highlight");
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [color, setColor] = useState(only ? "#1a7f37" : "#ffd400");
  const [width, setWidth] = useState(2);
  const [author, setAuthor] = useState<string>(() => storage.get("pdfaty.author", ""));
  const [stamp, setStamp] = useState("approved");
  const [stampText, setStampText] = useState("");
  const [inkDraft, setInkDraft] = useState<{ page: number; pts: Pt[] } | null>(null);
  const [lineDraft, setLineDraft] = useState<{ page: number; a: Pt; b: Pt } | null>(null);
  const textMarkup = ["highlight", "underline", "strikeout", "squiggly"].includes(mode);

  const add = (it: Omit<Item, "id" | "color"> & { color?: string }) => {
    const item = { id: uid(), color, ...it } as Item;
    setItems((x) => [...x, item]);
    setSelected(item.id);
  };
  const update = (id: string, patch: Partial<Item>) => setItems((x) => x.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const remove = (id: string) => setItems((x) => x.filter((i) => i.id !== id));

  // text selection -> markup annotations
  useEffect(() => {
    if (!textMarkup) return;
    const onUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const scale = getState().scale;
      const byPage = new Map<number, number[][]>();
      for (let i = 0; i < sel.rangeCount; i++) {
        const range = sel.getRangeAt(i);
        for (const r of Array.from(range.getClientRects())) {
          const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest<HTMLElement>(".page")
            ?? (range.startContainer.parentElement?.closest<HTMLElement>(".page") ?? null);
          if (!el) continue;
          const pr = el.getBoundingClientRect();
          const p = Number(el.dataset.page);
          if (!byPage.has(p)) byPage.set(p, []);
          byPage.get(p)!.push([(r.left - pr.left) / scale, (r.top - pr.top) / scale, r.width / scale, r.height / scale]);
        }
      }
      for (const [page, rs] of byPage) {
        const merged = mergeRects(rs);
        if (merged.length) add({ type: mode as Item["type"], page, rects: merged, contents: sel.toString().slice(0, 500) });
      }
      sel.removeAllRanges();
    };
    document.addEventListener("pointerup", onUp);
    return () => document.removeEventListener("pointerup", onUp);
  }, [mode, color, textMarkup]);

  const rect = useRectDraw((page, r) => {
    if (mode === "note") { add({ type: "note", page, x: r.x, y: r.y, contents: "" }); return; }
    if (r.w < 4) {
      if (mode === "stamp") r = { x: r.x - 70, y: r.y - 22, w: 140, h: 44 };
      else if (mode === "freetext") r = { x: r.x, y: r.y, w: 180, h: 40 };
      else return;
    }
    if (mode === "freetext") add({ type: "freetext", page, ...r, text: "", size: 12 });
    else if (mode === "square" || mode === "circle") add({ type: mode, page, ...r, stroke_width: width, fill: null });
    else if (mode === "stamp") {
      const s = STAMPS.find((x) => x[0] === stamp);
      add({ type: "stamp", page, ...r, stamp, text: stamp === "custom" ? stampText || "OK" : t(s![1]), color: s ? (only ? color : s[2]) : color });
    }
  });

  // overlay renderer
  useEffect(() => {
    const capture = !textMarkup && mode !== "select";
    setOverlay({
      capture,
      cursor: capture ? "crosshair" : undefined,
      render: (p: PageInfo) => {
        const s = p.scale;
        const mine = items.filter((i) => i.page === p.index);
        const h = rect.handlers(p.index, s);
        const drawHandlers = mode === "ink" ? {
          onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => { if (e.target !== e.currentTarget) return; e.currentTarget.setPointerCapture(e.pointerId); setInkDraft({ page: p.index, pts: [pagePoint(e, e.currentTarget, s)] }); },
          onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => { if (inkDraft?.page === p.index) setInkDraft({ page: p.index, pts: [...inkDraft.pts, pagePoint(e, e.currentTarget, s)] }); },
          onPointerUp: () => {
            if (inkDraft && inkDraft.pts.length > 1) {
              const last = items[items.length - 1];
              const path = inkDraft.pts.map((q) => [q.x, q.y]);
              if (last && last.type === "ink" && last.page === p.index && last.id === selected) update(last.id, { paths: [...(last.paths ?? []), path] });
              else add({ type: "ink", page: p.index, paths: [path], stroke_width: width });
            }
            setInkDraft(null);
          },
        } : mode === "line" || mode === "arrow" ? {
          onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => { if (e.target !== e.currentTarget) return; e.currentTarget.setPointerCapture(e.pointerId); const a = pagePoint(e, e.currentTarget, s); setLineDraft({ page: p.index, a, b: a }); },
          onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => { if (lineDraft?.page === p.index) setLineDraft({ ...lineDraft, b: pagePoint(e, e.currentTarget, s) }); },
          onPointerUp: () => {
            if (lineDraft && Math.hypot(lineDraft.b.x - lineDraft.a.x, lineDraft.b.y - lineDraft.a.y) > 4)
              add({ type: mode, page: p.index, x1: lineDraft.a.x, y1: lineDraft.a.y, x2: lineDraft.b.x, y2: lineDraft.b.y, stroke_width: width });
            setLineDraft(null);
          },
        } : h;
        return (
          <div className="ov-fill" {...(capture ? drawHandlers : {})}>
            <svg className="ov-svg" width={p.width} height={p.height}>
              {mine.map((i) => {
                if (i.rects) return i.rects.map((r, k) => (
                  i.type === "highlight"
                    ? <rect key={i.id + k} x={r[0] * s} y={r[1] * s} width={r[2] * s} height={r[3] * s} fill={i.color} opacity={0.4} />
                    : <line key={i.id + k} x1={r[0] * s} x2={(r[0] + r[2]) * s} y1={(i.type === "strikeout" ? r[1] + r[3] / 2 : r[1] + r[3] - 1) * s} y2={(i.type === "strikeout" ? r[1] + r[3] / 2 : r[1] + r[3] - 1) * s} stroke={i.color} strokeWidth={Math.max(1, r[3] * s / 12)} strokeDasharray={i.type === "squiggly" ? "3 2" : undefined} />
                ));
                if (i.paths) return i.paths.map((path, k) => <polyline key={i.id + k} points={path.map((q) => `${q[0] * s},${q[1] * s}`).join(" ")} fill="none" stroke={i.color} strokeWidth={(i.stroke_width ?? 2) * s} strokeLinecap="round" strokeLinejoin="round" />);
                if (i.x1 != null) return (
                  <g key={i.id}>
                    <line x1={i.x1 * s} y1={i.y1! * s} x2={i.x2! * s} y2={i.y2! * s} stroke={i.color} strokeWidth={(i.stroke_width ?? 2) * s} markerEnd={i.type === "arrow" ? "url(#arrowhead)" : undefined} />
                  </g>
                );
                return null;
              })}
              {inkDraft?.page === p.index && <polyline points={inkDraft.pts.map((q) => `${q.x * s},${q.y * s}`).join(" ")} fill="none" stroke={color} strokeWidth={width * s} strokeLinecap="round" />}
              {lineDraft?.page === p.index && <line x1={lineDraft.a.x * s} y1={lineDraft.a.y * s} x2={lineDraft.b.x * s} y2={lineDraft.b.y * s} stroke={color} strokeWidth={width * s} />}
              <defs><marker id="arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill={color} /></marker></defs>
            </svg>
            {mine.filter((i) => i.x != null && i.w != null).map((i) => (
              <PlacedBox key={i.id} x={i.x!} y={i.y!} w={i.w!} h={i.h!} scale={s} selected={selected === i.id} onSelect={() => setSelected(i.id)}
                onChange={(r) => update(i.id, r)} onDelete={() => remove(i.id)} label={t(`annotm.${i.type}`)} className={`ann-${i.type}`}>
                {i.type === "freetext" && <div className="ft-preview" dir="auto" style={{ fontSize: (i.size ?? 12) * s, color: i.color, borderColor: i.color }}>{i.text || t("annot.typeHere")}</div>}
                {i.type === "stamp" && <div className="stamp-preview" style={{ color: i.color, borderColor: i.color, fontSize: Math.min(i.h! * 0.45, i.w! / Math.max(3, (i.text ?? "").length * 0.6)) * s }}>{i.text}</div>}
                {(i.type === "square" || i.type === "circle") && <div className="shape-preview" style={{ borderColor: i.color, borderWidth: (i.stroke_width ?? 2) * s, borderRadius: i.type === "circle" ? "50%" : 0 }} />}
              </PlacedBox>
            ))}
            {mine.filter((i) => i.type === "note").map((i) => (
              <button key={i.id} type="button" className={`note-pin ${selected === i.id ? "selected" : ""}`} style={{ left: i.x! * s, top: i.y! * s }} onClick={() => setSelected(i.id)} aria-label={t("annotm.note")}>
                <StickyNote size={16} />
              </button>
            ))}
            {rect.draftRect(p.index, s)}
          </div>
        );
      },
    });
  }, [items, mode, color, width, inkDraft, lineDraft, selected, stamp, stampText, rect]);
  useEffect(() => () => setOverlay(null), []);

  const apply = async () => {
    if (!items.length) return;
    storage.set("pdfaty.author", author);
    const payload = items.map(({ id, ...rest }) => { void id; return rest.type === "stamp" ? { ...rest, stamp: rest.stamp } : rest; });
    const res = await runOnDoc("annotate", { items: payload, author }, t("tool.annotate"));
    if (res) { setItems([]); toast("success", t("annot.saved", { n: res.result.created })); }
  };

  const modes: [Mode, any][] = only ? [["stamp", Stamp], ["select", MousePointer2]] : [
    ["highlight", Highlighter], ["underline", Underline], ["strikeout", Strikethrough], ["squiggly", Waves], ["note", StickyNote],
    ["freetext", Type], ["ink", Pencil], ["line", Minus], ["arrow", ArrowUpRight], ["square", Square], ["circle", Circle], ["stamp", Stamp], ["select", MousePointer2],
  ];
  const sel = items.find((i) => i.id === selected);

  return (
    <div className="form">
      <div className="mode-grid" role="radiogroup" aria-label={t("annot.mode")}>
        {modes.map(([m, Icon]) => (
          <IconButton key={m} label={t(`annotm.${m}`)} active={mode === m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)}><Icon size={18} /></IconButton>
        ))}
      </div>
      <p className="muted small">{t(`annoth.${mode}`)}</p>
      <div className="row">
        <Field label={t("f.color")} inline><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></Field>
        {["ink", "line", "arrow", "square", "circle"].includes(mode) && (
          <Field label={t("f.strokeWidth")} inline><input type="number" className="input small-num" min={0.5} max={20} step={0.5} value={width} onChange={(e) => setWidth(Number(e.target.value))} /></Field>
        )}
      </div>
      {mode === "stamp" && (
        <Field label={t("annot.stampType")}>
          <select className="input" value={stamp} onChange={(e) => setStamp(e.target.value)}>
            {STAMPS.map(([v, k]) => <option key={v} value={v}>{t(k)}</option>)}
            <option value="custom">{t("stamp.custom")}</option>
          </select>
          {stamp === "custom" && <input className="input" dir="auto" value={stampText} onChange={(e) => setStampText(e.target.value)} placeholder={t("stamp.customText")} />}
        </Field>
      )}
      {sel && (
        <div className="item-editor">
          <strong>{t(`annotm.${sel.type}`)} — {t("viewer.page", { n: sel.page + 1 })}</strong>
          {sel.type === "freetext" ? (
            <>
              <textarea className="input" rows={3} dir="auto" value={sel.text ?? ""} onChange={(e) => update(sel.id, { text: e.target.value })} placeholder={t("annot.typeHere")} aria-label={t("annot.text")} />
              <Field label={t("f.fontSize")} inline><input type="number" className="input small-num" min={6} max={72} value={sel.size ?? 12} onChange={(e) => update(sel.id, { size: Number(e.target.value) })} /></Field>
            </>
          ) : sel.type !== "stamp" && (
            <textarea className="input" rows={2} dir="auto" value={sel.contents ?? ""} onChange={(e) => update(sel.id, { contents: e.target.value })} placeholder={t("annot.comment")} aria-label={t("annot.comment")} />
          )}
          <Button small variant="ghost" icon={<Trash2 size={14} />} onClick={() => remove(sel.id)}>{t("common.delete")}</Button>
        </div>
      )}
      <Field label={t("annot.author")}>
        <input className="input" dir="auto" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder={t("annot.authorPh")} />
      </Field>
      <div className="pending">
        <strong>{t("annot.pending", { n: items.length })}</strong>
        <ul>
          {items.map((i) => (
            <li key={i.id} className={selected === i.id ? "on" : ""}>
              <button type="button" className="link" onClick={() => setSelected(i.id)}>{t(`annotm.${i.type}`)} · {t("viewer.page", { n: i.page + 1 })}</button>
              <IconButton label={t("common.delete")} onClick={() => remove(i.id)}><Trash2 size={13} /></IconButton>
            </li>
          ))}
        </ul>
      </div>
      <div className="tool-actions">
        <Button onClick={() => setItems([])} disabled={!items.length}>{t("common.clear")}</Button>
        <Button variant="primary" onClick={apply} disabled={!items.length}>{t("annot.save")}</Button>
      </div>
      <p className="muted small">{t("annot.note")}</p>
    </div>
  );
}

export function StampTool() {
  return <Annotate only="stamp" />;
}
