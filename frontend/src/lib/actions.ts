// Document-level actions: open, apply a new version, undo/redo, download, close, run server ops.
import { errorText, t } from "../i18n";
import { ApiError, runJob, type RunResult, type UploadFile } from "./api";
import { openPdf, PasswordNeeded, isPdf } from "./pdf";
import { getState, pushHistory, setState, toast } from "./store";
import { downloadBlob, stem, uid } from "./utils";

type PasswordAsk = (name: string, incorrect: boolean) => Promise<string | null>;
let askPassword: PasswordAsk = async () => null;
export function registerPasswordPrompt(fn: PasswordAsk): void {
  askPassword = fn;
}

type ConfirmAsk = (title: string, body: string, danger?: boolean) => Promise<boolean>;
let askConfirm: ConfirmAsk = async () => true;
export function registerConfirm(fn: ConfirmAsk): void {
  askConfirm = fn;
}
export function confirmDialog(title: string, body: string, danger = false): Promise<boolean> {
  return askConfirm(title, body, danger);
}

const CONVERTIBLE = /\.(docx?|odt|rtf|xlsx?|ods|csv|pptx?|odp|txt|md|html?|png|jpe?g|gif|bmp|tiff?|webp|svg)$/i;

export async function openFile(file: File): Promise<boolean> {
  if (!(await isPdf(file))) {
    if (CONVERTIBLE.test(file.name)) {
      const ok = await confirmDialog(t("open.convertTitle"), t("open.convertBody", { name: file.name }));
      if (!ok) return false;
      const res = await runOp("convert_to_pdf", [{ name: file.name, data: file }], {}, t("tool.convert_to_pdf"));
      if (!res || !res.files[0]) return false;
      const bytes = new Uint8Array(await res.files[0].blob.arrayBuffer());
      return openBytes(bytes, stem(file.name) + ".pdf");
    }
    toast("error", t("err.unsupported_file_type"), file.name);
    return false;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return openBytes(bytes, file.name);
}

export async function openBytes(bytes: Uint8Array, name: string, password = ""): Promise<boolean> {
  let pw = password;
  let incorrect = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      setState({ busy: { label: t("open.loading"), pct: -1, stage: "open" } });
      const pdf = await openPdf(bytes, pw);
      const old = getState().doc;
      if (old) old.pdf.destroy().catch(() => undefined);
      setState({
        doc: { id: uid(), name, bytes, password: pw, pdf, numPages: pdf.numPages, version: 0, modified: false, originalSize: bytes.byteLength },
        history: [],
        future: [],
        route: "workspace",
        page: 0,
        tool: null,
        busy: null,
        scrollTo: { page: 0, nonce: Date.now() },
      });
      return true;
    } catch (e) {
      setState({ busy: null });
      if (e instanceof PasswordNeeded) {
        incorrect = e.incorrect || attempt > 0;
        const p = await askPassword(name, incorrect && attempt > 0);
        if (p == null) return false;
        pw = p;
        continue;
      }
      toast("error", t("err.invalid_pdf"), name);
      return false;
    }
  }
  return false;
}

/** Replace the current document with a new version (keeps undo history). */
export async function applyBytes(bytes: Uint8Array, label: string, opts: { keepPassword?: boolean } = {}): Promise<void> {
  const d = getState().doc;
  if (!d) return;
  let password = opts.keepPassword === false ? "" : d.password;
  let pdf;
  try {
    pdf = await openPdf(bytes, password);
  } catch (e) {
    if (e instanceof PasswordNeeded && password) {
      pdf = await openPdf(bytes, "");
      password = "";
    } else if (e instanceof PasswordNeeded) {
      // result was encrypted with a new password (protect tool): ask for it to display
      const p = await askPassword(d.name, false);
      if (p == null) throw e;
      pdf = await openPdf(bytes, p);
      password = p;
    } else throw e;
  }
  pushHistory(label);
  const old = d.pdf;
  setState({
    doc: { ...d, bytes, pdf, password, numPages: pdf.numPages, version: d.version + 1, modified: true },
    page: Math.min(getState().page, pdf.numPages - 1),
  });
  setTimeout(() => old.destroy().catch(() => undefined), 500);
}

// Undo/redo swaps load asynchronously; downloads wait for any pending swap.
let pendingSwap: Promise<void> = Promise.resolve();

function swapTo(bytes: Uint8Array): Promise<void> {
  pendingSwap = pendingSwap.then(() => doSwap(bytes)).catch(() => undefined);
  return pendingSwap;
}

async function doSwap(bytes: Uint8Array): Promise<void> {
  const d = getState().doc!;
  let pdf;
  try {
    pdf = await openPdf(bytes, d.password);
  } catch {
    pdf = await openPdf(bytes, "");
  }
  const old = d.pdf;
  setState({ doc: { ...d, bytes, pdf, numPages: pdf.numPages, version: d.version + 1, modified: true }, page: Math.min(getState().page, pdf.numPages - 1) });
  setTimeout(() => old.destroy().catch(() => undefined), 500);
}

export async function undo(): Promise<void> {
  const s = getState();
  if (!s.doc || !s.history.length) return;
  const prev = s.history[s.history.length - 1];
  setState({ history: s.history.slice(0, -1), future: [...s.future, { bytes: s.doc.bytes, label: prev.label }] });
  await swapTo(prev.bytes);
}

export async function redo(): Promise<void> {
  const s = getState();
  if (!s.doc || !s.future.length) return;
  const next = s.future[s.future.length - 1];
  setState({ future: s.future.slice(0, -1), history: [...s.history, { bytes: s.doc.bytes, label: next.label }] });
  await swapTo(next.bytes);
}

export async function downloadCurrent(): Promise<void> {
  await pendingSwap;
  const d = getState().doc;
  if (!d) return;
  downloadBlob(new Blob([d.bytes], { type: "application/pdf" }), d.name);
  setState({ doc: { ...d, modified: false } });
}

export async function closeDoc(): Promise<void> {
  const d = getState().doc;
  if (d?.modified) {
    const ok = await confirmDialog(t("close.title"), t("close.body"), true);
    if (!ok) return;
  }
  d?.pdf.destroy().catch(() => undefined);
  setState({ doc: null, history: [], future: [], route: "home", tool: null, standalone: null });
}

export function currentFile(): UploadFile | null {
  const d = getState().doc;
  if (!d) return null;
  return { name: d.name, data: new Blob([d.bytes], { type: "application/pdf" }) };
}

/** Run a server operation with the global progress overlay and friendly errors. Returns null on failure. */
export async function runOp(op: string, files: UploadFile[], params: Record<string, any>, label: string,
                            opts: { silent?: boolean; fetchOutputs?: boolean } = {}): Promise<RunResult | null> {
  const ctrl = new AbortController();
  const stageLabel: Record<string, string> = { upload: t("busy.upload"), queue: t("busy.queue"), process: t("busy.process"), download: t("busy.download") };
  setState({ busy: { label, pct: 0, stage: stageLabel.upload, cancel: () => ctrl.abort() } });
  try {
    const res = await runJob(op, files, params, {
      signal: ctrl.signal,
      fetchOutputs: opts.fetchOutputs,
      onProgress: (pct, stage) => setState({ busy: { label, pct, stage: stageLabel[stage], cancel: () => ctrl.abort() } }),
    });
    return res;
  } catch (e) {
    if (!opts.silent) {
      const code = e instanceof ApiError ? e.code : "network_error";
      if (code !== "cancelled") toast("error", errorText(code, e instanceof ApiError ? e.detail : null));
    }
    if (opts.silent) throw e;
    return null;
  } finally {
    setState({ busy: null });
  }
}

/** Run an op on the current document and replace it with the first PDF output. */
export async function runOnDoc(op: string, params: Record<string, any>, label: string, extra: UploadFile[] = []): Promise<RunResult | null> {
  const f = currentFile();
  if (!f) return null;
  const d = getState().doc!;
  const res = await runOp(op, [f, ...extra], d.password ? { password: d.password, ...params } : params, label);
  if (!res) return null;
  const pdfOut = res.files.find((x) => x.mime === "application/pdf");
  if (pdfOut) {
    try {
      await applyBytes(new Uint8Array(await pdfOut.blob.arrayBuffer()), label);
    } catch {
      toast("error", t("err.invalid_pdf"));
      return null;
    }
  }
  return res;
}

export function docParams(params: Record<string, any> = {}): Record<string, any> {
  const d = getState().doc;
  return d?.password ? { password: d.password, ...params } : params;
}

/** Print the current document through the browser's PDF viewer (hidden iframe). */
export function printCurrent(): void {
  const d = getState().doc;
  if (!d) return;
  const url = URL.createObjectURL(new Blob([d.bytes], { type: "application/pdf" }));
  const frame = document.createElement("iframe");
  frame.style.position = "fixed";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.src = url;
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      window.open(url, "_blank", "noopener");
    }
    setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60_000);
  };
  document.body.appendChild(frame);
}
