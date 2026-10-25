import { useEffect, useRef, useState } from "react";
import { CalendarDays, CheckSquare, ChevronDownSquare, CircleDot, Crosshair, MousePointer2, PenLine, Printer, TextCursorInput, Trash2 } from "lucide-react";
import { useT } from "../../i18n";
import { currentFile, docParams, printCurrent, runOnDoc, runOp } from "../../lib/actions";
import { setOverlay, type PageInfo } from "../../lib/overlay";
import { setState, toast, useStore } from "../../lib/store";
import { uid } from "../../lib/utils";
import { Button, Empty, Field, IconButton } from "../ui";
import { PlacedBox, useRectDraw } from "./common";

interface FormField { name: string; type: string; value: string; readonly: boolean; required: boolean; multiline: boolean; tooltip: string; options?: { value: string; label: string }[]; widgets: { page: number; rect: number[] }[] }

export default function FormsFill() {
  const t = useT();
  const version = useStore((s) => s.doc?.version);
  const [fields, setFields] = useState<FormField[] | null>(null);
  const [xfa, setXfa] = useState(false);
  const [values, setValues] = useState<Record<string, any>>({});
  const [flatten, setFlatten] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const refs = useRef<Record<string, HTMLElement | null>>({});

  const load = async () => {
    const f = currentFile();
    if (!f) return;
    const res = await runOp("forms_list", [f], docParams(), t("tool.forms_fill"), { fetchOutputs: false });
    if (!res) return;
    setFields(res.result.fields);
    setXfa(res.result.xfa);
    const v: Record<string, any> = {};
    for (const fl of res.result.fields as FormField[]) v[fl.name] = fl.type === "checkbox" ? !!fl.value && fl.value !== "Off" : fl.value === "Off" ? "" : fl.value;
    setValues(v);
  };
  useEffect(() => { load(); }, [version]);

  useEffect(() => {
    if (!fields) return;
    setOverlay({
      capture: false,
      render: (p: PageInfo) => (
        <div className="ov-fill">
          {fields.flatMap((f) => f.widgets.filter((w) => w.page === p.index).map((w, k) => (
            <button key={f.name + k} type="button" className={`widget-hl ${focus === f.name ? "on" : ""}`} title={f.name}
              style={{ left: w.rect[0] * p.scale, top: w.rect[1] * p.scale, width: w.rect[2] * p.scale, height: w.rect[3] * p.scale }}
              onClick={() => { setFocus(f.name); refs.current[f.name]?.focus(); }} aria-label={f.tooltip || f.name} />
          )))}
        </div>
      ),
    });
  }, [fields, focus]);
  useEffect(() => () => setOverlay(null), []);

  const apply = async () => {
    const changed: Record<string, any> = {};
    for (const f of fields ?? []) if (!f.readonly && f.type !== "signature" && f.type !== "button") changed[f.name] = values[f.name];
    const res = await runOnDoc("forms_fill", { values: changed, flatten }, t("tool.forms_fill"));
    if (res) toast("success", t("forms.filled", { n: res.result.filled }));
  };
  const locate = (f: FormField) => {
    setFocus(f.name);
    const w = f.widgets[0];
    if (w) setState({ scrollTo: { page: w.page, y: w.rect[1], nonce: Date.now() } });
  };

  if (!fields) return <div className="muted small">{t("common.loading")}</div>;
  if (!fields.length) return <Empty title={t("forms.none")}>{t("forms.noneHint")}<br /><Button small onClick={() => setState({ tool: "forms_create" })}>{t("tool.forms_create")}</Button></Empty>;
  return (
    <div className="form">
      {xfa && <p className="warn-text">{t("forms.xfa")}</p>}
      {fields.map((f) => {
        const set = (v: any) => setValues({ ...values, [f.name]: v });
        const common = { ref: (el: HTMLElement | null) => { refs.current[f.name] = el; }, onFocus: () => locate(f), disabled: f.readonly };
        return (
          <div key={f.name} className={`form-field ${focus === f.name ? "on" : ""}`}>
            <div className="ff-label">
              <span dir="auto">{f.tooltip || f.name}{f.required && <span className="req" aria-label={t("forms.required")}> *</span>}</span>
              <IconButton label={t("forms.locate")} onClick={() => locate(f)}><Crosshair size={13} /></IconButton>
            </div>
            {f.type === "text" && (f.multiline
              ? <textarea className="input" rows={3} dir="auto" value={values[f.name] ?? ""} onChange={(e) => set(e.target.value)} {...(common as any)} />
              : <input className="input" dir="auto" value={values[f.name] ?? ""} onChange={(e) => set(e.target.value)} {...(common as any)} />)}
            {f.type === "checkbox" && <label className="check"><input type="checkbox" checked={!!values[f.name]} onChange={(e) => set(e.target.checked)} {...(common as any)} />{t("forms.checked")}</label>}
            {f.type === "radio" && (
              <div className="chips">
                {(f.options ?? []).map((o) => <label key={o.value} className="check chip"><input type="radio" name={`r-${f.name}`} checked={values[f.name] === o.value} onChange={() => set(o.value)} disabled={f.readonly} />{o.label}</label>)}
                <button type="button" className="link small" onClick={() => set("")}>{t("common.clear")}</button>
              </div>
            )}
            {(f.type === "combo" || f.type === "list") && (
              <select className="input" value={values[f.name] ?? ""} onChange={(e) => set(e.target.value)} {...(common as any)}>
                <option value="">—</option>
                {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            )}
            {f.type === "signature" && <p className="muted small">{t("forms.sigField")}</p>}
          </div>
        );
      })}
      <label className="check"><input type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} />{t("forms.flatten")}</label>
      <div className="tool-actions">
        <Button icon={<Printer size={16} />} onClick={printCurrent}>{t("ws.print")}</Button>
        <Button variant="primary" onClick={apply}>{t("forms.save")}</Button>
      </div>
      <p className="muted small">{t("forms.note")}</p>
    </div>
  );
}

type FType = "text" | "checkbox" | "radio" | "dropdown" | "signature" | "date";
interface NewField { id: string; type: FType; page: number; x: number; y: number; w: number; h: number; name: string; options?: string; export?: string; required?: boolean; multiline?: boolean; tooltip?: string; value?: any }

export function FormsCreate() {
  const t = useT();
  const [mode, setMode] = useState<FType | "select">("text");
  const [items, setItems] = useState<NewField[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const counter = useRef(1);
  const rect = useRectDraw((page, r) => {
    if (mode === "select") return;
    const def: Record<FType, [number, number]> = { text: [180, 22], checkbox: [16, 16], radio: [16, 16], dropdown: [150, 22], signature: [180, 50], date: [110, 22] };
    if (r.w < 4) r = { x: r.x, y: r.y, w: def[mode][0], h: def[mode][1] };
    const n = counter.current++;
    const prevRadio = [...items].reverse().find((i) => i.type === "radio");
    const f: NewField = { id: uid(), type: mode, page, ...r, name: mode === "radio" && prevRadio ? prevRadio.name : `${mode}_${n}`, options: mode === "dropdown" ? "Option 1, Option 2" : undefined, export: mode === "radio" ? `opt${n}` : undefined };
    setItems((x) => [...x, f]);
    setSel(f.id);
  });
  useEffect(() => {
    setOverlay({
      capture: mode !== "select",
      cursor: mode !== "select" ? "crosshair" : undefined,
      render: (p: PageInfo) => (
        <div className="ov-fill" {...(mode !== "select" ? rect.handlers(p.index, p.scale) : {})}>
          {items.filter((i) => i.page === p.index).map((i) => (
            <PlacedBox key={i.id} x={i.x} y={i.y} w={i.w} h={i.h} scale={p.scale} selected={sel === i.id} onSelect={() => setSel(i.id)} className="newfield" label={i.name}
              onChange={(r) => setItems((x) => x.map((q) => (q.id === i.id ? { ...q, ...r } : q)))} onDelete={() => setItems((x) => x.filter((q) => q.id !== i.id))}>
              <span className="nf-label">{i.name}</span>
            </PlacedBox>
          ))}
          {rect.draftRect(p.index, p.scale)}
        </div>
      ),
    });
  }, [items, mode, sel, rect]);
  useEffect(() => () => setOverlay(null), []);
  const up = (id: string, patch: Partial<NewField>) => setItems((x) => x.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  const it = items.find((i) => i.id === sel);
  const apply = async () => {
    const fields = items.map((i) => ({ type: i.type, name: i.name, page: i.page, x: i.x, y: i.y, w: i.w, h: i.h, options: i.options?.split(/[,،]/).map((s) => s.trim()).filter(Boolean), export: i.export, required: i.required, multiline: i.multiline, tooltip: i.tooltip, value: i.value }));
    const res = await runOnDoc("forms_create", { fields }, t("tool.forms_create"));
    if (res) { setItems([]); toast("success", t("forms.created", { n: res.result.created })); }
  };
  const modes: [FType | "select", any][] = [["text", TextCursorInput], ["checkbox", CheckSquare], ["radio", CircleDot], ["dropdown", ChevronDownSquare], ["date", CalendarDays], ["signature", PenLine], ["select", MousePointer2]];
  return (
    <div className="form">
      <div className="mode-grid" role="radiogroup" aria-label={t("annot.mode")}>
        {modes.map(([m, Icon]) => <IconButton key={m} label={t(`fieldm.${m}`)} active={mode === m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)}><Icon size={18} /></IconButton>)}
      </div>
      <p className="muted small">{t("forms.createHint")}</p>
      {it && (
        <div className="item-editor">
          <Field label={t("forms.fieldName")}><input className="input" dir="auto" value={it.name} onChange={(e) => up(it.id, { name: e.target.value })} /></Field>
          <Field label={t("forms.tooltip")}><input className="input" dir="auto" value={it.tooltip ?? ""} onChange={(e) => up(it.id, { tooltip: e.target.value })} /></Field>
          {it.type === "dropdown" && <Field label={t("forms.options")} help={t("forms.optionsHelp")}><input className="input" dir="auto" value={it.options ?? ""} onChange={(e) => up(it.id, { options: e.target.value })} /></Field>}
          {it.type === "radio" && <Field label={t("forms.exportValue")} help={t("forms.radioHelp")}><input className="input" value={it.export ?? ""} onChange={(e) => up(it.id, { export: e.target.value })} /></Field>}
          {it.type === "text" && <label className="check"><input type="checkbox" checked={!!it.multiline} onChange={(e) => up(it.id, { multiline: e.target.checked })} />{t("forms.multiline")}</label>}
          <label className="check"><input type="checkbox" checked={!!it.required} onChange={(e) => up(it.id, { required: e.target.checked })} />{t("forms.required")}</label>
          <Button small variant="ghost" icon={<Trash2 size={14} />} onClick={() => setItems(items.filter((q) => q.id !== it.id))}>{t("common.delete")}</Button>
        </div>
      )}
      <div className="pending"><strong>{t("forms.newCount", { n: items.length })}</strong></div>
      <div className="tool-actions">
        <Button variant="primary" disabled={!items.length} onClick={apply}>{t("common.apply")}</Button>
      </div>
      <p className="muted small">{t("forms.sigNote")}</p>
    </div>
  );
}
