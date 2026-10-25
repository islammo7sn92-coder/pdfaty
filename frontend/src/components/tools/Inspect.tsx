import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { currentFile, docParams, runOnDoc, runOp } from "../../lib/actions";
import { toast, useStore } from "../../lib/store";
import { downloadBlob } from "../../lib/utils";
import { Badge, Button, Field, Segmented } from "../ui";

type Tab = "summary" | "fonts" | "images" | "pdfa" | "pdfx" | "access";

export default function Inspect() {
  const t = useT();
  const version = useStore((s) => s.doc?.version);
  const name = useStore((s) => s.doc?.name ?? "document");
  const [r, setR] = useState<Record<string, any> | null>(null);
  const [tab, setTab] = useState<Tab>("summary");
  const [lang, setLang] = useState("ar");
  const [title, setTitle] = useState("");

  const run = async () => {
    const f = currentFile();
    if (!f) return;
    const res = await runOp("inspect", [f], docParams(), t("tool.inspect"), { fetchOutputs: false });
    if (res) { setR(res.result); setTitle(res.result.structure.title || ""); setLang(res.result.structure.lang || "ar"); }
  };
  useEffect(() => { run(); }, [version]);
  if (!r) return <div className="muted small">{t("common.loading")}</div>;

  const checks = (list: { id: string; status: "pass" | "warn" | "fail" }[]) => (
    <ul className="checks">
      {list.map((c) => (
        <li key={c.id}><Badge kind={c.status}>{t(`chk.status.${c.status}`)}</Badge> <span>{t(`chk.${c.id}`)}</span></li>
      ))}
    </ul>
  );
  const fix = async () => {
    const res = await runOnDoc("metadata_set", { metadata: { lang, title, display_title: true } }, t("inspect.fix"));
    if (res) toast("success", t("inspect.fixed"));
  };
  const exportReport = () => {
    downloadBlob(new Blob([JSON.stringify(r, null, 2)], { type: "application/json" }), `${name.replace(/\.pdf$/i, "")}_inspection.json`);
  };
  return (
    <div className="form">
      <p className="note">{t("inspect.disclaimer")}</p>
      <Segmented label={t("tool.inspect")} value={tab} onChange={setTab} options={[
        { value: "summary", label: t("inspect.summary") }, { value: "fonts", label: t("inspect.fonts") }, { value: "images", label: t("inspect.images") },
        { value: "pdfa", label: "PDF/A" }, { value: "pdfx", label: "PDF/X" }, { value: "access", label: t("inspect.access") },
      ]} />
      {tab === "summary" && (
        <dl className="props">
          <div><dt>{t("props.version")}</dt><dd>{r.pdf_version}</dd></div>
          <div><dt>{t("props.pages")}</dt><dd>{r.pages}</dd></div>
          <div><dt>{t("inspect.fonts")}</dt><dd>{r.fonts.length} ({t("inspect.unembedded", { n: r.fonts.filter((f: any) => !f.embedded).length })})</dd></div>
          <div><dt>{t("inspect.images")}</dt><dd>{r.images.length}</dd></div>
          <div><dt>{t("inspect.colorspaces")}</dt><dd dir="ltr">{Object.keys(r.colorspaces).join(", ") || "-"}</dd></div>
          <div><dt>{t("inspect.transparency")}</dt><dd>{r.transparency ? t("common.yes") : t("common.no")}</dd></div>
          <div><dt>{t("inspect.overprint")}</dt><dd>{r.overprint ? t("common.yes") : t("common.no")}</dd></div>
          <div><dt>{t("inspect.tagged")}</dt><dd>{r.structure.tagged ? t("common.yes") : t("common.no")}</dd></div>
          <div><dt>{t("inspect.claims")}</dt><dd dir="ltr">{[r.claims.pdfa, r.claims.pdfx].filter(Boolean).join(", ") || t("inspect.noClaims")}</dd></div>
          <div><dt>{t("props.forms")}</dt><dd>{r.forms.acroform ? "AcroForm" : "-"}{r.forms.xfa ? " + XFA" : ""}</dd></div>
          <div><dt>JavaScript</dt><dd>{r.javascript ? t("common.yes") : t("common.no")}</dd></div>
          <div><dt>{t("side.attachments")}</dt><dd>{r.attachments.length}</dd></div>
          <div><dt>{t("props.encrypted")}</dt><dd>{r.encrypted ? t("common.yes") : t("common.no")}</dd></div>
          <div><dt>TrimBox / BleedBox</dt><dd>{r.boxes.trim ? "✓" : "✗"} / {r.boxes.bleed ? "✓" : "✗"}</dd></div>
        </dl>
      )}
      {tab === "fonts" && (
        <div className="table-wrap">
          <table className="data"><thead><tr><th>{t("inspect.font")}</th><th>{t("inspect.type")}</th><th>{t("inspect.embedded")}</th><th>Unicode</th></tr></thead>
            <tbody>{r.fonts.map((f: any, i: number) => <tr key={i}><td dir="ltr">{f.name}{f.subset ? " (subset)" : ""}</td><td>{f.type}</td><td>{f.embedded ? "✓" : <span className="warn-text">✗</span>}</td><td>{f.unicode ? "✓" : "–"}</td></tr>)}</tbody></table>
        </div>
      )}
      {tab === "images" && (
        <div className="table-wrap">
          <table className="data"><thead><tr><th>px</th><th>DPI</th><th>{t("inspect.colorspace")}</th><th>{t("inspect.filter")}</th><th>{t("props.pages")}</th></tr></thead>
            <tbody>{r.images.map((im: any, i: number) => <tr key={i}><td>{im.width}×{im.height}</td><td className={im.dpi && im.dpi < 150 ? "warn-text" : ""}>{im.dpi ?? "-"}</td><td dir="ltr">{im.colorspace}</td><td dir="ltr">{im.filter}</td><td>{im.pages.join(",")}</td></tr>)}</tbody></table>
        </div>
      )}
      {tab === "pdfa" && checks(r.checks.pdfa)}
      {tab === "pdfx" && checks(r.checks.pdfx)}
      {tab === "access" && (
        <>
          {checks(r.checks.accessibility)}
          <p className="muted small">{t("inspect.figures", { n: r.structure.figures, alt: r.structure.figures_with_alt })}</p>
          <div className="item-editor">
            <strong>{t("inspect.quickFix")}</strong>
            <Field label={t("inspect.docLang")}><select className="input" value={lang} onChange={(e) => setLang(e.target.value)}><option value="ar">العربية (ar)</option><option value="en">English (en)</option><option value="fr">Français (fr)</option></select></Field>
            <Field label={t("props.title")}><input className="input" dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
            <Button onClick={fix}>{t("inspect.fix")}</Button>
            <p className="muted small">{t("inspect.tagsNote")}</p>
          </div>
        </>
      )}
      <Button small onClick={exportReport}>{t("inspect.export")}</Button>
    </div>
  );
}
