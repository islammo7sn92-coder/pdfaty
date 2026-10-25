import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { currentFile, docParams, runOnDoc, runOp } from "../../lib/actions";
import { setOverlay, type PageInfo } from "../../lib/overlay";
import { toast, useStore } from "../../lib/store";
import { Badge, Button, Empty, Field } from "../ui";
import { PlacedBox, useRectDraw } from "./common";

export default function DigitalSign() {
  const t = useT();
  const version = useStore((s) => s.doc?.version);
  const [cert, setCert] = useState<File | null>(null);
  const [pw, setPw] = useState("");
  const [meta, setMeta] = useState({ reason: "", location: "", contact: "" });
  const [visible, setVisible] = useState(true);
  const [box, setBox] = useState<{ page: number; x: number; y: number; w: number; h: number } | null>(null);
  const [fields, setFields] = useState<string[]>([]);
  const [field, setField] = useState("");
  const [result, setResult] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    const f = currentFile();
    if (!f) return;
    runOp("forms_list", [f], docParams(), t("tool.digital_sign"), { fetchOutputs: false, silent: true })
      .then((r) => setFields((r?.result.fields ?? []).filter((x: any) => x.type === "signature" && !x.value).map((x: any) => x.name)))
      .catch(() => setFields([]));
  }, [version]);

  const rect = useRectDraw((page, r) => setBox(r.w < 4 ? { page, x: r.x - 90, y: r.y - 25, w: 180, h: 50 } : { page, ...r }));
  useEffect(() => {
    const active = visible && !field;
    setOverlay({
      capture: active,
      cursor: active ? "crosshair" : undefined,
      render: (p: PageInfo) => (
        <div className="ov-fill" {...(active ? rect.handlers(p.index, p.scale) : {})}>
          {box && box.page === p.index && active && (
            <PlacedBox {...box} scale={p.scale} selected label={t("tool.digital_sign")} onChange={(r) => setBox({ ...box, ...r })} onDelete={() => setBox(null)}>
              <div className="sigbox-preview">Digitally signed</div>
            </PlacedBox>
          )}
          {rect.draftRect(p.index, p.scale)}
        </div>
      ),
    });
  }, [box, visible, field, rect]);
  useEffect(() => () => setOverlay(null), []);

  const sign = async () => {
    if (!cert) { toast("info", t("dsig.needCert")); return; }
    if (visible && !field && !box) { toast("info", t("dsig.needBox")); return; }
    const params: Record<string, any> = { cert_password: pw, ...meta, visible, field_name: field || undefined };
    if (box && !field) { params.page = box.page; params.rect = [box.x, box.y, box.w, box.h]; }
    const res = await runOnDoc("sign_certificate", params, t("tool.digital_sign"), [{ name: cert.name.endsWith(".pfx") || cert.name.endsWith(".p12") ? cert.name : "cert.p12", data: cert }]);
    if (res) { setResult(res.result); setPw(""); toast("success", t("dsig.done")); }
  };

  return (
    <div className="form">
      <p className="note">{t("dsig.explain")}</p>
      <Field label={t("dsig.cert")} help={t("dsig.certHelp")}>
        <input type="file" accept=".p12,.pfx,application/x-pkcs12" onChange={(e) => setCert(e.target.files?.[0] ?? null)} />
      </Field>
      <Field label={t("dsig.certPw")}><input className="input" type="password" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
      {fields.length > 0 && (
        <Field label={t("dsig.field")}>
          <select className="input" value={field} onChange={(e) => setField(e.target.value)}>
            <option value="">{t("dsig.newField")}</option>
            {fields.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </Field>
      )}
      {!field && <label className="check"><input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />{t("dsig.visible")}</label>}
      {visible && !field && <p className="muted small">{t("dsig.drawBox")}</p>}
      <Field label={t("dsig.reason")}><input className="input" dir="auto" value={meta.reason} onChange={(e) => setMeta({ ...meta, reason: e.target.value })} /></Field>
      <Field label={t("dsig.location")}><input className="input" dir="auto" value={meta.location} onChange={(e) => setMeta({ ...meta, location: e.target.value })} /></Field>
      <div className="tool-actions"><Button variant="primary" onClick={sign} disabled={!cert}>{t("dsig.sign")}</Button></div>
      {result && (
        <div className="result-box">
          <p><Badge kind="pass">{t("dsig.validSig")}</Badge> {result.trusted ? <Badge kind="pass">{t("dsig.trusted")}</Badge> : <Badge kind="warn">{t("dsig.untrusted")}</Badge>}</p>
          <p dir="auto">{t("dsig.signer")}: {result.signer}</p>
          <p dir="auto">{t("dsig.issuer")}: {result.issuer}</p>
          <p>{t("dsig.validUntil")}: {String(result.valid_until).slice(0, 10)}</p>
          {result.visible_fallback && <p className="warn-text">{t("dsig.fallback")}</p>}
        </div>
      )}
      <p className="muted small">{t("dsig.privacy")}</p>
    </div>
  );
}

export function VerifySignatures() {
  const t = useT();
  const version = useStore((s) => s.doc?.version);
  const [list, setList] = useState<any[] | null>(null);
  useEffect(() => {
    const f = currentFile();
    if (!f) return;
    runOp("signatures_verify", [f], docParams(), t("tool.verify_signatures"), { fetchOutputs: false }).then((r) => setList(r?.result.signatures ?? []));
  }, [version]);
  if (!list) return <div className="muted small">{t("common.loading")}</div>;
  if (!list.length) return <Empty title={t("dsig.noneFound")}>{t("dsig.noneHint")}</Empty>;
  return (
    <div className="form">
      {list.map((s) => (
        <div key={s.index} className="item-editor">
          <strong>{s.field}</strong>
          {s.error ? <p className="error-text">{t("dsig.checkError")}</p> : (
            <>
              <p>
                {s.intact && s.valid ? <Badge kind="pass">{t("dsig.validSig")}</Badge> : <Badge kind="fail">{t("dsig.invalidSig")}</Badge>}{" "}
                {s.trusted ? <Badge kind="pass">{t("dsig.trusted")}</Badge> : <Badge kind="warn">{t("dsig.untrusted")}</Badge>}
              </p>
              <p dir="auto" className="small">{t("dsig.signer")}: {s.signer}</p>
              <p dir="auto" className="small">{t("dsig.issuer")}: {s.issuer}</p>
              {s.signing_time && <p className="small">{t("dsig.time")}: {String(s.signing_time).replace("T", " ").slice(0, 19)}</p>}
              <p className="small">{s.coverage === "ENTIRE_FILE" ? t("dsig.coverAll") : t("dsig.coverPartial")}</p>
            </>
          )}
        </div>
      ))}
      <p className="muted small">{t("dsig.trustNote")}</p>
    </div>
  );
}
