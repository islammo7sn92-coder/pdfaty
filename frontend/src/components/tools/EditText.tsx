import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { currentFile, docParams, runOnDoc, runOp } from "../../lib/actions";
import { setOverlay, type PageInfo } from "../../lib/overlay";
import { toast, useStore } from "../../lib/store";
import { Button, Field } from "../ui";

interface TObj { index: number; rect: number[]; text: string; size: number; font: string; color: string; bold: boolean; baseline: number; origin_x: number; rotated: boolean }
interface Edit { page: number; ids: number[]; text: string; original: string; x: number; y: number; w: number; h: number; size: number; color: string; bold: boolean; family: string; baseline: number; align: string }

const AR = /[؀-ۿ]/;

export default function EditText() {
  const t = useT();
  const doc = useStore((s) => s.doc)!;
  const page = useStore((s) => s.page);
  const [objs, setObjs] = useState<Record<number, TObj[]>>({});
  const [sel, setSel] = useState<{ page: number; ids: number[] } | null>(null);
  const [edits, setEdits] = useState<Edit[]>([]);
  const [draft, setDraft] = useState<Edit | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (p: number) => {
    if (objs[p]) return;
    const f = currentFile();
    if (!f) return;
    setLoading(true);
    try {
      const res = await runOp("text_objects", [f], docParams({ page: p }), t("tool.edit_text"), { fetchOutputs: false });
      if (res) setObjs((o) => ({ ...o, [p]: res.result.objects }));
    } finally { setLoading(false); }
  };
  useEffect(() => { setObjs({}); setEdits([]); setSel(null); setDraft(null); }, [doc.version]);
  useEffect(() => { load(page); }, [page, doc.version, objs[page] == null]);

  const pick = (p: number, o: TObj, add: boolean) => {
    let ids = add && sel?.page === p ? (sel.ids.includes(o.index) ? sel.ids.filter((i) => i !== o.index) : [...sel.ids, o.index]) : [o.index];
    if (!ids.length) { setSel(null); setDraft(null); return; }
    setSel({ page: p, ids });
    const chosen = (objs[p] ?? []).filter((x) => ids.includes(x.index));
    const rtl = chosen.some((x) => AR.test(x.text));
    chosen.sort((a, b) => (rtl ? b.rect[0] - a.rect[0] : a.rect[0] - b.rect[0]));
    const text = chosen.map((x) => x.text).join(" ");
    const x0 = Math.min(...chosen.map((c) => c.rect[0])), y0 = Math.min(...chosen.map((c) => c.rect[1]));
    const x1 = Math.max(...chosen.map((c) => c.rect[0] + c.rect[2])), y1 = Math.max(...chosen.map((c) => c.rect[1] + c.rect[3]));
    const first = chosen[0];
    const font = first.font.toLowerCase();
    setDraft({
      page: p, ids, text, original: text, x: x0, y: y0, w: x1 - x0, h: y1 - y0, size: first.size || 12, color: first.color, bold: first.bold,
      family: /serif|times|naskh|roman|georgia/.test(font) && !/sans/.test(font) ? "serif" : /mono|courier/.test(font) ? "mono" : "sans",
      baseline: first.baseline, align: rtl ? "right" : "left",
    });
  };
  const selectLine = () => {
    if (!sel || !draft) return;
    const line = (objs[sel.page] ?? []).filter((o) => Math.abs(o.baseline - draft.baseline) < Math.max(1.5, draft.size * 0.2));
    if (!line.length) return;
    const rtl = line.some((x) => AR.test(x.text));
    const chosen = line.slice().sort((a, b) => (rtl ? b.rect[0] - a.rect[0] : a.rect[0] - b.rect[0]));
    const ids = chosen.map((c) => c.index);
    const x0 = Math.min(...chosen.map((c) => c.rect[0])), x1 = Math.max(...chosen.map((c) => c.rect[0] + c.rect[2]));
    const y0 = Math.min(...chosen.map((c) => c.rect[1])), y1 = Math.max(...chosen.map((c) => c.rect[1] + c.rect[3]));
    const text = chosen.map((c) => c.text).join(" ");
    setSel({ page: sel.page, ids });
    setDraft({ ...draft, ids, text, original: text, x: x0, y: y0, w: x1 - x0, h: y1 - y0, align: rtl ? "right" : "left" });
  };

  useEffect(() => {
    setOverlay({
      capture: true,
      cursor: "text",
      render: (p: PageInfo) => {
        const list = objs[p.index];
        const s = p.scale;
        const editedIds = new Set(edits.filter((e) => e.page === p.index).flatMap((e) => e.ids));
        if (!list) return <div className="ov-fill" onClick={() => load(p.index)} />;
        return (
          <div className="ov-fill">
            {list.map((o) => (
              <button key={o.index} type="button" className={`tobj ${sel?.page === p.index && sel.ids.includes(o.index) ? "on" : ""} ${editedIds.has(o.index) ? "edited" : ""}`}
                style={{ left: o.rect[0] * s, top: o.rect[1] * s, width: Math.max(4, o.rect[2] * s), height: Math.max(4, o.rect[3] * s) }}
                title={o.text} aria-label={o.text} onClick={(e) => pick(p.index, o, e.shiftKey || e.ctrlKey || e.metaKey)} />
            ))}
            {edits.filter((e) => e.page === p.index).map((e, k) => (
              <div key={k} className="edit-ghost" dir="auto" style={{ left: e.x * s, top: e.y * s, minWidth: e.w * s, height: e.h * s, fontSize: e.size * s, color: e.color, fontWeight: e.bold ? 700 : 400, textAlign: e.align as any }}>{e.text}</div>
            ))}
          </div>
        );
      },
    });
  }, [objs, sel, edits]);
  useEffect(() => () => setOverlay(null), []);

  const queue = () => {
    if (!draft) return;
    if (draft.text === draft.original) { toast("info", t("edittext.unchanged")); return; }
    const w = Math.max(draft.w, draft.size * draft.text.length * 0.6);
    const x = draft.align === "right" ? draft.x + draft.w - w : draft.x;
    setEdits((e) => [...e.filter((x0) => !(x0.page === draft.page && x0.ids.some((i) => draft.ids.includes(i)))), { ...draft, x, w }]);
    setSel(null);
    setDraft(null);
  };
  const apply = async () => {
    if (!edits.length) return;
    const payload = edits.map((e) => ({ page: e.page, ids: e.ids, text: e.text, x: e.x, y: e.y, w: e.w, h: e.h, size: e.size, color: e.color, bold: e.bold, family: e.family, baseline: e.baseline, align: e.align }));
    const res = await runOnDoc("replace_text", { edits: payload }, t("tool.edit_text"));
    if (res) toast("success", t("edittext.done", { n: res.result.removed_objects }));
  };

  const noText = objs[page] && objs[page].length === 0;
  return (
    <div className="form">
      <p className="note">{t("edittext.how")}</p>
      {loading && <p className="muted small">{t("common.loading")}</p>}
      {noText && <p className="warn-text">{t("edittext.noText")}</p>}
      {draft && (
        <div className="item-editor">
          <Field label={t("edittext.original")}><div className="orig-text" dir="auto">{draft.original}</div></Field>
          <Field label={t("edittext.new")}>
            <textarea className="input" rows={3} dir="auto" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} autoFocus />
          </Field>
          <div className="row wrap">
            <Field label={t("f.fontSize")} inline><input type="number" className="input small-num" min={4} max={200} step={0.5} value={draft.size} onChange={(e) => setDraft({ ...draft, size: Number(e.target.value) })} /></Field>
            <Field label={t("f.color")} inline><input type="color" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} /></Field>
            <label className="check"><input type="checkbox" checked={draft.bold} onChange={(e) => setDraft({ ...draft, bold: e.target.checked })} />{t("f.bold")}</label>
          </div>
          <div className="row wrap">
            <Field label={t("f.font")} inline>
              <select className="input" value={draft.family} onChange={(e) => setDraft({ ...draft, family: e.target.value })}>
                <option value="sans">{t("font.sans")}</option><option value="serif">{t("font.serif")}</option><option value="mono">{t("font.mono")}</option>
              </select>
            </Field>
            <Field label={t("f.align")} inline>
              <select className="input" value={draft.align} onChange={(e) => setDraft({ ...draft, align: e.target.value })}>
                <option value="right">{t("f.alignRight")}</option><option value="center">{t("f.alignCenter")}</option><option value="left">{t("f.alignLeft")}</option>
              </select>
            </Field>
          </div>
          <div className="tool-actions">
            <Button small onClick={selectLine}>{t("edittext.selectLine")}</Button>
            <Button small variant="primary" onClick={queue}>{t("edittext.queue")}</Button>
          </div>
        </div>
      )}
      <div className="pending">
        <strong>{t("edittext.pending", { n: edits.length })}</strong>
        <ul>{edits.map((e, i) => <li key={i}><span dir="auto">{t("viewer.page", { n: e.page + 1 })}: {e.original} → {e.text}</span><button type="button" className="link" onClick={() => setEdits(edits.filter((_, k) => k !== i))}>{t("common.delete")}</button></li>)}</ul>
      </div>
      <div className="tool-actions">
        <Button variant="primary" disabled={!edits.length} onClick={apply}>{t("common.apply")}</Button>
      </div>
      <p className="muted small">{t("edittext.limits")}</p>
    </div>
  );
}
