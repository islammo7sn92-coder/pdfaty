import { Suspense, lazy, useEffect } from "react";
import { BusyOverlay, DialogHosts, Toasts } from "./components/ui";
import Home from "./views/Home";
import Workspace from "./views/Workspace";
import { useStore, getState } from "./lib/store";
import { useT } from "./i18n";

const Standalone = lazy(() => import("./views/Standalone"));

export default function App() {
  const route = useStore((s) => s.route);
  const lang = useStore((s) => s.lang);
  const theme = useStore((s) => s.theme);
  const t = useT();

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.title = t("app.title");
  }, [lang]);
  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if (getState().doc?.modified) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBefore);
    return () => window.removeEventListener("beforeunload", onBefore);
  }, []);

  return (
    <>
      <a href="#main" className="skip-link">{t("a11y.skip")}</a>
      {route === "home" && <Home />}
      {route === "workspace" && <Workspace />}
      {route === "standalone" && (
        <Suspense fallback={<div className="center-msg">{t("common.loading")}</div>}>
          <Standalone />
        </Suspense>
      )}
      <BusyOverlay />
      <DialogHosts />
      <Toasts />
    </>
  );
}
