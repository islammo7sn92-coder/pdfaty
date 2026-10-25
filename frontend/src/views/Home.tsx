import { useEffect, useRef, useState } from "react";
import { Cpu, Lock, Server, Timer, Wifi } from "lucide-react";
import { useT } from "../i18n";
import { getCapabilities } from "../lib/api";
import { openFile } from "../lib/actions";
import { getState, setState, useStore } from "../lib/store";
import { DropZone } from "../components/ui";
import { CATEGORIES, VISIBLE_TOOLS, toolById } from "../components/tools/registry";
import { openTool } from "../components/ToolPanel";
import Header from "./Header";

export default function Home() {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const [limits, setLimits] = useState<{ mb: number; ok: boolean } | null>(null);
  const pending = useRef<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getCapabilities().then((c) => setLimits({ mb: c.limits.max_upload_mb, ok: true })).catch(() => setLimits({ mb: 0, ok: false }));
  }, []);

  const onFiles = async (fs: File[]) => {
    const ok = await openFile(fs[0]);
    if (ok && pending.current) {
      openTool(pending.current);
      pending.current = null;
    }
  };

  const launch = (id: string) => {
    const tool = toolById(id)!;
    if (!tool.needsDoc) return openTool(id);
    if (getState().doc) {
      setState({ route: "workspace" });
      openTool(id);
      return;
    }
    pending.current = id;
    picker.current?.click();
  };

  return (
    <div className="home">
      <Header />
      <main id="main">
        <section className="hero">
          <h1>{t("home.title")}</h1>
          <p className="lead">{t("home.subtitle")}</p>
          <div className="hero-drop">
            <DropZone onFiles={onFiles} accept=".pdf,application/pdf,.docx,.doc,.odt,.rtf,.xlsx,.xls,.ods,.csv,.pptx,.ppt,.odp,.txt,.html,.htm,image/*" label={t("home.drop")} hint={limits?.ok ? t("home.dropHint", { mb: limits.mb }) : undefined} />
            {limits && !limits.ok && <p className="error-text">{t("home.serverDown")}</p>}
            {doc && <button type="button" className="link" onClick={() => setState({ route: "workspace" })}>{t("home.backToDoc", { name: doc.name })}</button>}
          </div>
          <ul className="trust">
            <li><Lock size={16} /> {t("home.trust1")}</li>
            <li><Timer size={16} /> {t("home.trust2")}</li>
            <li><Cpu size={16} /> {t("home.trust3")}</li>
            <li><Wifi size={16} /> {t("home.trust4")}</li>
          </ul>
        </section>
        <input ref={picker} type="file" hidden accept=".pdf,application/pdf" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onFiles([f]); }} />
        <section className="cats" aria-label={t("home.allTools")}>
          <h2>{t("home.allTools")}</h2>
          <div className="cat-grid">
            {CATEGORIES.map((c) => (
              <div className="cat-card" key={c}>
                <h3>{t(`cat.${c}`)}</h3>
                <ul>
                  {VISIBLE_TOOLS.filter((x) => x.cat === c).map((x) => (
                    <li key={x.id}>
                      <button type="button" onClick={() => launch(x.id)}>
                        <x.icon size={16} />
                        <span>{t(`tool.${x.id}`)}</span>
                        {x.serverSide && <Server size={11} className="srv" aria-label={t("panel.serverSide")} />}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="muted small">{t("panel.serverHint")}</p>
        </section>
      </main>
      <footer className="footer">
        <span>PDFATY — {t("footer.free")}</span>
        <span className="muted">{t("footer.oss")}</span>
      </footer>
    </div>
  );
}
