import { useState } from "react";
import { Languages, Moon, ShieldCheck, Sun, SunMoon } from "lucide-react";
import { useT } from "../i18n";
import { setState, useStore } from "../lib/store";
import { Button, IconButton, Modal } from "../components/ui";

export function Logo({ onClick }: { onClick?: () => void }) {
  return (
    <button type="button" className="logo" onClick={onClick} aria-label="PDFATY">
      <svg viewBox="0 0 64 64" width="28" height="28" aria-hidden>
        <rect width="64" height="64" rx="14" fill="var(--brand)" />
        <path d="M18 12h20l10 10v30a2 2 0 0 1-2 2H18a2 2 0 0 1-2-2V14a2 2 0 0 1 2-2z" fill="#fff" />
        <path d="M38 12v10h10" fill="#c9e9e1" />
        <text x="32" y="46" fontFamily="Arial" fontWeight="700" fontSize="13" textAnchor="middle" fill="var(--brand)">PDF</text>
      </svg>
      <span>PDFATY</span>
    </button>
  );
}

export function LangThemeButtons() {
  const lang = useStore((s) => s.lang);
  const theme = useStore((s) => s.theme);
  const t = useT();
  const nextTheme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  return (
    <>
      <Button small variant="ghost" icon={<Languages size={16} />} onClick={() => setState({ lang: lang === "ar" ? "en" : "ar" })} aria-label={t("header.switchLang")}>
        {lang === "ar" ? "English" : "العربية"}
      </Button>
      <IconButton label={t(`theme.${theme}`)} onClick={() => setState({ theme: nextTheme })}>
        {theme === "dark" ? <Moon size={18} /> : theme === "light" ? <Sun size={18} /> : <SunMoon size={18} />}
      </IconButton>
    </>
  );
}

export function PrivacyButton() {
  const [open, setOpen] = useState(false);
  const t = useT();
  return (
    <>
      <Button small variant="ghost" icon={<ShieldCheck size={16} />} onClick={() => setOpen(true)}>{t("privacy.link")}</Button>
      <PrivacyModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function PrivacyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  return (
    <Modal open={open} title={t("privacy.title")} onClose={onClose} wide>
      <div className="prose">
        {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => <p key={i}>{t(`privacy.p${i}`)}</p>)}
      </div>
    </Modal>
  );
}

export default function Header() {
  const t = useT();
  return (
    <header className="topbar">
      <Logo onClick={() => setState({ route: "home", standalone: null })} />
      <nav className="topbar-actions" aria-label={t("header.nav")}>
        <PrivacyButton />
        <LangThemeButtons />
      </nav>
    </header>
  );
}
