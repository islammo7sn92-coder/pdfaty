import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { confirmDialog, currentFile, docParams, runOnDoc, runOp } from "../../lib/actions";
import { toast, useStore } from "../../lib/store";
import { Badge, Button, Empty } from "../ui";

interface Cand { id: string; kind: string; source: string; label: string; pages: number[]; page_count: number; removable: boolean }

export default function WatermarkRemove() {
  const t = useT();
  const version = useStore((s) => s.doc?.version);
  const [data, setData] = useState<{ candidates: Cand[]; scanned_pages: number; pages: number } | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  const analyze = async () => {
    const f = currentFile();
    if (!f) return;
    const res = await runOp("watermark_analyze", [f], docParams(), t("wm.analyze"), { fetchOutputs: false });
    if (!res) return;
    setData(res.result as any);
    setChosen(new Set((res.result.candidates as Cand[]).filter((c) => ["pdfaty", "artifact", "layer", "annotation"].includes(c.source)).map((c) => c.id)));
  };
  useEffect(() => { setData(null); }, [version]);

  const remove = async () => {
    if (!chosen.size) return;
    if (!(await confirmDialog(t("tool.watermark_remove"), t("wm.confirm", { n: chosen.size })))) return;
    const res = await runOnDoc("watermark_remove", { ids: Array.from(chosen) }, t("tool.watermark_remove"));
    if (res) { toast("success", t("wm.removed")); setData(null); }
  };

  return (
    <div className="form">
      <p className="note">{t("wm.explain")}</p>
      <Button variant="primary" onClick={analyze}>{t("wm.analyze")}</Button>
      {data && !data.candidates.length && (
        <Empty title={t("wm.noneFound")}>{data.scanned_pages ? t("wm.embedded", { n: data.scanned_pages }) : t("wm.noneHint")}</Empty>
      )}
      {data && data.candidates.length > 0 && (
        <div className="cand-list">
          {data.candidates.map((c) => (
            <label key={c.id} className="cand">
              <input type="checkbox" checked={chosen.has(c.id)} onChange={(e) => { const n = new Set(chosen); e.target.checked ? n.add(c.id) : n.delete(c.id); setChosen(n); }} />
              <div>
                <div><Badge kind={c.kind === "background" ? "info" : "warn"}>{t(`wm.kind.${c.kind}`)}</Badge> <strong>{t(`wm.src.${c.source}`)}</strong></div>
                <div className="muted small" dir="auto">{c.label}</div>
                <div className="muted small">{t("wm.onPages", { n: c.page_count, of: data.pages })}</div>
                <div className="small">{t(`wm.srcHelp.${c.source}`)}</div>
              </div>
            </label>
          ))}
          {data.scanned_pages > 0 && <p className="warn-text">{t("wm.embedded", { n: data.scanned_pages })}</p>}
          <Button variant="danger" onClick={remove} disabled={!chosen.size}>{t("wm.removeSelected", { n: chosen.size })}</Button>
          <p className="muted small">{t("wm.after")}</p>
        </div>
      )}
    </div>
  );
}
