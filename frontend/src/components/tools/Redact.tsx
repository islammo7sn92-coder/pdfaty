import { useEffect, useState } from "react";
import { Search, Square, Trash2 } from "lucide-react";
import { useT } from "../../i18n";
import { confirmDialog, currentFile, docParams, runOnDoc, runOp } from "../../lib/actions";
import { setOverlay, type PageInfo } from "../../lib/overlay";
import { setState, toast } from "../../lib/store";
import { uid } from "../../lib/utils";
import { Badge, Button, Field, IconButton, Segmented } from "../ui";
import { PlacedBox, useRectDraw } from "./common";

interface Area { id: string; page: number; x: number; y: number; w: number; h: number; source: "draw" | "search"; text?: string; on: boolean }
const PRESETS = ["email", "phone", "national_id", "iban", "card", "date", "amount"];

export default function Redact() {
  const t = useT();
  const [mode, setMode] = useState<"draw" | "search">("draw");
  const [areas, setAreas] = useState<Area[]>([]);
  const [terms, setTerms] = useState("");
  const [presets, setPresets] = useState<string[]>([]);
  const [regex, setRegex] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [opts, setOpts] = useState({ mode: "precise", color: "#000000", scrub_metadata: true, remove_javascript: true, remove_attachments: false });
  const [report, setReport] = useState<Record<string, any> | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  const rect = useRectDraw((page, r) => {
    if (r.w < 3) return;
    const a: Area = { id: uid(), page, ...r, source: "draw", on: true };
    setAreas((x) => [...x, a]);
    setSel(a.id);
  });

  useEffect(() => {
    setOverlay({
      capture: mode === "draw",
      cursor: mode === "draw" ? "crosshair" : undefined,
      render: (p: PageInfo) => {
        const s = p.scale;
        return (
          <div className="ov-fill" {...(mode === "draw" ? rect.handlers(p.index, s) : {})}>
            {areas.filter((a) => a.page === p.index).map((a) => a.source === "draw" ? (
              <PlacedBox key={a.id} x={a.x} y={a.y} w={a.w} h={a.h} scale={s} selected={sel === a.id} onSelect={() => setSel(a.id)} className="redact-box" label={t("redact.area")}
                onChange={(r) => setAreas((x) => x.map((q) => (q.id === a.id ? { ...q, ...r } : q)))} onDelete={() => setAreas((x) => x.filter((q) => q.id !== a.id))} />
            ) : (
              <button key={a.id} type="button" className={`redact-hit ${a.on ? "on" : ""}`} title={a.text} aria-pressed={a.on} aria-label={a.text}
                style={{ left: a.x * s, top: a.y * s, width: a.w * s, height: a.h * s }}
                onClick={() => setAreas((x) => x.map((q) => (q.id === a.id ? { ...q, on: !q.on } : q)))} />
            ))}
            {rect.draftRect(p.index, s)}
          </div>
        );
      },
    });
  }, [areas, mode, sel, rect]);
  useEffect(() => () => setOverlay(null), []);

  const search = async () => {
    const f = currentFile();
    if (!f) return;
    const list = terms.split("\n").map((x) => x.trim()).filter(Boolean);
    if (!list.length && !presets.length) { toast("info", t("redact.needTerms")); return; }
    const res = await runOp("redact_search", [f], docParams({ terms: list, presets, regex, match_case: matchCase }), t("redact.search"), { fetchOutputs: false });
    if (!res) return;
    const found: Area[] = [];
    for (const m of res.result.matches) for (const r of m.rects) found.push({ id: uid(), page: m.page, x: r[0], y: r[1], w: r[2], h: r[3], source: "search", text: m.text, on: true });
    setAreas((x) => [...x.filter((a) => a.source === "draw"), ...found]);
    toast(found.length ? "success" : "info", t("redact.found", { n: res.result.count }));
    if (found[0]) setState({ scrollTo: { page: found[0].page, y: found[0].y, nonce: Date.now() } });
  };

  const apply = async () => {
    const active = areas.filter((a) => a.on);
    if (!active.length) { toast("info", t("redact.none")); return; }
    if (!(await confirmDialog(t("tool.redact"), t("redact.confirm", { n: active.length }), true))) return;
    const res = await runOnDoc("redact_apply", { areas: active.map((a) => ({ page: a.page, rect: [a.x, a.y, a.w, a.h] })), padding: 0.5, ...opts }, t("tool.redact"));
    if (res) { setReport(res.result); setAreas([]); }
  };

  const active = areas.filter((a) => a.on);
  return (
    <div className="form">
      <p className="note">{t("redact.explain")}</p>
      <Segmented label={t("redact.mode")} value={mode} onChange={setMode} options={[{ value: "draw", label: t("redact.draw"), icon: <Square size={14} /> }, { value: "search", label: t("redact.search"), icon: <Search size={14} /> }]} />
      {mode === "search" && (
        <div>
          <Field label={t("redact.terms")} help={t("redact.termsHelp")}>
            <textarea className="input" rows={3} dir="auto" value={terms} onChange={(e) => setTerms(e.target.value)} />
          </Field>
          <fieldset className="field">
            <legend className="field-label">{t("redact.presets")}</legend>
            <div className="chips">
              {PRESETS.map((p) => (
                <label key={p} className="check chip"><input type="checkbox" checked={presets.includes(p)} onChange={(e) => setPresets(e.target.checked ? [...presets, p] : presets.filter((x) => x !== p))} />{t(`preset.${p}`)}</label>
              ))}
            </div>
          </fieldset>
          <div className="row wrap">
            <label className="check"><input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />{t("redact.regex")}</label>
            <label className="check"><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />{t("redact.matchCase")}</label>
          </div>
          <Button icon={<Search size={16} />} onClick={search}>{t("redact.findMatches")}</Button>
          <p className="muted small">{t("redact.toggleHint")}</p>
        </div>
      )}
      <div className="pending">
        <strong>{t("redact.selected", { n: active.length })}</strong>
        <ul>
          {areas.slice(0, 200).map((a) => (
            <li key={a.id}>
              <label className="check"><input type="checkbox" checked={a.on} onChange={() => setAreas((x) => x.map((q) => (q.id === a.id ? { ...q, on: !q.on } : q)))} />
                <button type="button" className="link" onClick={() => setState({ scrollTo: { page: a.page, y: a.y, nonce: Date.now() } })}>{t("viewer.page", { n: a.page + 1 })}{a.text ? `: ${a.text}` : ` — ${t("redact.area")}`}</button></label>
              <IconButton label={t("common.delete")} onClick={() => setAreas((x) => x.filter((q) => q.id !== a.id))}><Trash2 size={13} /></IconButton>
            </li>
          ))}
        </ul>
      </div>
      <details className="presets">
        <summary>{t("redact.options")}</summary>
        <Field label={t("redact.method")}>
          <select className="input" value={opts.mode} onChange={(e) => setOpts({ ...opts, mode: e.target.value })}>
            <option value="precise">{t("redact.precise")}</option>
            <option value="rasterize">{t("redact.rasterize")}</option>
          </select>
        </Field>
        <Field label={t("f.color")} inline><input type="color" value={opts.color} onChange={(e) => setOpts({ ...opts, color: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" checked={opts.scrub_metadata} onChange={(e) => setOpts({ ...opts, scrub_metadata: e.target.checked })} />{t("f.rmMetadata")}</label>
        <label className="check"><input type="checkbox" checked={opts.remove_javascript} onChange={(e) => setOpts({ ...opts, remove_javascript: e.target.checked })} />{t("f.rmJs")}</label>
        <label className="check"><input type="checkbox" checked={opts.remove_attachments} onChange={(e) => setOpts({ ...opts, remove_attachments: e.target.checked })} />{t("f.rmAttachments")}</label>
      </details>
      <div className="tool-actions">
        <Button onClick={() => setAreas([])} disabled={!areas.length}>{t("common.clear")}</Button>
        <Button variant="danger" onClick={apply} disabled={!active.length}>{t("redact.apply")}</Button>
      </div>
      {report && (
        <div className={`result-box ${report.verified ? "" : "warn"}`}>
          <p>{report.verified ? <Badge kind="pass">{t("redact.verified")}</Badge> : <Badge kind="warn">{t("redact.unverified")}</Badge>}</p>
          <p>{t("redact.reportAreas", { n: report.areas, pages: report.pages.join(", ") })}</p>
          <p>{t("redact.reportObjects", { text: report.stats.text_removed, img: report.stats.images_removed, patched: report.stats.patched_objects })}</p>
          {report.rasterized_pages.length > 0 && <p>{t("redact.reportRaster", { pages: report.rasterized_pages.join(", ") })}</p>}
          {report.annotations_removed > 0 && <p>{t("redact.reportAnnots", { n: report.annotations_removed })}</p>}
          {report.leaked_terms > 0 && <p className="warn-text">{t("redact.leaked", { n: report.leaked_terms })}</p>}
          {report.unverified_pages?.length > 0 && <p className="warn-text">{t("redact.unverifiedPages", { pages: report.unverified_pages.join(", ") })}</p>}
          <p className="muted small">{t("redact.reportNote")}</p>
        </div>
      )}
    </div>
  );
}
