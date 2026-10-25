import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, Upload, X, XCircle } from "lucide-react";
import { useT } from "../../i18n";
import { registerConfirm, registerPasswordPrompt } from "../../lib/actions";
import { dismissToast, useStore } from "../../lib/store";
import { cls } from "../../lib/utils";

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "default"; icon?: ReactNode; small?: boolean }) {
  const { variant = "default", icon, small, className, children, ...rest } = props;
  return (
    <button type="button" {...rest} className={cls("btn", `btn-${variant}`, small && "btn-sm", className)}>
      {icon}
      {children != null && <span>{children}</span>}
    </button>
  );
}

export function IconButton(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  const { label, active, className, children, ...rest } = props;
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={active} {...rest} className={cls("icon-btn", active && "active", className)}>
      {children}
    </button>
  );
}

export function Modal({ open, title, onClose, children, footer, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("input,select,textarea,button:not(.modal-close)");
    (first ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && el) {
        const items = Array.from(el.querySelectorAll<HTMLElement>("button,input,select,textarea,a[href],[tabindex]:not([tabindex='-1'])")).filter((x) => !x.hasAttribute("disabled"));
        if (!items.length) return;
        const a = items[0], b = items[items.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
        else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cls("modal", wide && "modal-wide")} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <div className="modal-head">
          <h2>{title}</h2>
          <IconButton label={t("common.close")} className="modal-close" onClick={onClose}><X size={18} /></IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const t = useT();
  const icons = { success: <CheckCircle2 size={18} />, error: <XCircle size={18} />, info: <Info size={18} />, warning: <AlertTriangle size={18} /> };
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={cls("toast", `toast-${x.kind}`)}>
          {icons[x.kind]}
          <div className="toast-text">
            <div>{x.text}</div>
            {x.detail && <div className="muted small">{x.detail}</div>}
          </div>
          <IconButton label={t("common.close")} onClick={() => dismissToast(x.id)}><X size={14} /></IconButton>
        </div>
      ))}
    </div>
  );
}

export function Progress({ pct }: { pct: number }) {
  const indeterminate = pct < 0;
  return (
    <div className={cls("progress", indeterminate && "indeterminate")} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : Math.round(pct)}>
      <div style={{ width: indeterminate ? "35%" : `${Math.max(2, Math.min(100, pct))}%` }} />
    </div>
  );
}

export function BusyOverlay() {
  const busy = useStore((s) => s.busy);
  const t = useT();
  if (!busy) return null;
  return (
    <div className="busy-backdrop" aria-live="assertive">
      <div className="busy-card">
        <div className="spinner" aria-hidden />
        <div className="busy-label">{busy.label}</div>
        <div className="muted small">{busy.stage}{busy.pct >= 0 ? ` — ${Math.round(busy.pct)}%` : ""}</div>
        <Progress pct={busy.pct} />
        {busy.cancel && <Button variant="ghost" small onClick={busy.cancel}>{t("common.cancel")}</Button>}
      </div>
    </div>
  );
}

export function DialogHosts() {
  const t = useT();
  const [pw, setPw] = useState<{ name: string; incorrect: boolean; resolve: (v: string | null) => void } | null>(null);
  const [pwValue, setPwValue] = useState("");
  const [cf, setCf] = useState<{ title: string; body: string; danger: boolean; resolve: (v: boolean) => void } | null>(null);
  useEffect(() => {
    registerPasswordPrompt((name, incorrect) => new Promise((resolve) => { setPwValue(""); setPw({ name, incorrect, resolve }); }));
    registerConfirm((title, body, danger) => new Promise((resolve) => setCf({ title, body, danger: !!danger, resolve })));
  }, []);
  return (
    <>
      <Modal open={!!pw} title={t("pw.title")} onClose={() => { pw?.resolve(null); setPw(null); }}
        footer={<>
          <Button onClick={() => { pw?.resolve(null); setPw(null); }}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={!pwValue} onClick={() => { pw?.resolve(pwValue); setPw(null); }}>{t("pw.open")}</Button>
        </>}>
        <p>{t("pw.body", { name: pw?.name ?? "" })}</p>
        {pw?.incorrect && <p className="error-text">{t("pw.incorrect")}</p>}
        <form onSubmit={(e) => { e.preventDefault(); if (pwValue) { pw?.resolve(pwValue); setPw(null); } }}>
          <input type="password" className="input" autoComplete="off" value={pwValue} onChange={(e) => setPwValue(e.target.value)} aria-label={t("pw.label")} placeholder={t("pw.label")} />
        </form>
        <p className="muted small">{t("pw.note")}</p>
      </Modal>
      <Modal open={!!cf} title={cf?.title ?? ""} onClose={() => { cf?.resolve(false); setCf(null); }}
        footer={<>
          <Button onClick={() => { cf?.resolve(false); setCf(null); }}>{t("common.cancel")}</Button>
          <Button variant={cf?.danger ? "danger" : "primary"} onClick={() => { cf?.resolve(true); setCf(null); }}>{t("common.confirm")}</Button>
        </>}>
        <p style={{ whiteSpace: "pre-line" }}>{cf?.body}</p>
      </Modal>
    </>
  );
}

export function DropZone({ onFiles, accept, multiple, label, hint, compact }: { onFiles: (f: File[]) => void; accept?: string; multiple?: boolean; label?: string; hint?: string; compact?: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const t = useT();
  return (
    <div
      className={cls("dropzone", over && "over", compact && "compact")}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const fs = Array.from(e.dataTransfer.files); if (fs.length) onFiles(multiple ? fs : fs.slice(0, 1)); }}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }}
      role="button"
      tabIndex={0}
      aria-label={label ?? t("drop.label")}
    >
      <Upload size={compact ? 22 : 36} aria-hidden />
      <div className="dz-label">{label ?? t("drop.label")}</div>
      {!compact && <div className="muted small">{hint ?? t("drop.hint")}</div>}
      <span className="btn btn-primary btn-sm">{t("drop.choose")}</span>
      <input ref={input} type="file" hidden accept={accept} multiple={multiple}
        onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; if (fs.length) onFiles(fs); }} />
    </div>
  );
}

export function Field({ label, help, children, inline }: { label: string; help?: string; children: ReactNode; inline?: boolean }) {
  return (
    <label className={cls("field", inline && "field-inline")}>
      <span className="field-label">{label}</span>
      {children}
      {help && <span className="field-help">{help}</span>}
    </label>
  );
}

export function Badge({ kind, children }: { kind: "pass" | "warn" | "fail" | "info"; children: ReactNode }) {
  return <span className={cls("badge", `badge-${kind}`)}>{children}</span>;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <div className="empty-title">{title}</div>
      {children && <div className="muted small">{children}</div>}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; icon?: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={cls(value === o.value && "on")} onClick={() => onChange(o.value)} title={o.label}>
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}
