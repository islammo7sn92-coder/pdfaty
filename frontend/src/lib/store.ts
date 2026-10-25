// Small global store (useSyncExternalStore). Holds the open document, its version
// history (undo/redo), view settings and UI state. Documents live only in memory.
import { useSyncExternalStore } from "react";
import type { PDFDocumentProxy } from "./pdf";
import { storage, uid } from "./utils";

export type Lang = "ar" | "en";
export type ViewMode = "continuous" | "single" | "double";
export type SidebarTab = "thumbs" | "outline" | "search" | "comments" | "attachments" | "info";

export interface DocVersion {
  bytes: Uint8Array;
  label: string;
}

export interface OpenDoc {
  id: string;
  name: string;
  bytes: Uint8Array;
  password: string;
  pdf: PDFDocumentProxy;
  numPages: number;
  version: number;
  modified: boolean; // changed since last download
  originalSize: number;
}

export interface Toast {
  id: string;
  kind: "success" | "error" | "info" | "warning";
  text: string;
  detail?: string;
}

export interface Busy {
  label: string;
  pct: number;
  stage: string;
  cancel?: () => void;
}

export interface State {
  lang: Lang;
  theme: "light" | "dark" | "system";
  route: "home" | "workspace" | "standalone";
  standalone: string | null;
  doc: OpenDoc | null;
  history: DocVersion[];
  future: DocVersion[];
  scale: number;
  fit: "width" | "page" | null;
  mode: ViewMode;
  page: number; // 0-based current page
  sidebar: SidebarTab | null;
  panelOpen: boolean;
  tool: string | null;
  busy: Busy | null;
  toasts: Toast[];
  scrollTo: { page: number; y?: number; nonce: number } | null;
  searchHits: { page: number; nonce: number } | null;
}

const prefs = storage.get<{ lang?: Lang; theme?: State["theme"] }>("pdfaty.prefs", {});

let state: State = {
  lang: prefs.lang ?? "ar",
  theme: prefs.theme ?? "system",
  route: "home",
  standalone: null,
  doc: null,
  history: [],
  future: [],
  scale: 1,
  fit: "width",
  mode: "continuous",
  page: 0,
  sidebar: typeof window !== "undefined" && window.innerWidth > 900 ? "thumbs" : null,
  panelOpen: typeof window !== "undefined" && window.innerWidth > 1100,
  tool: null,
  busy: null,
  toasts: [],
  scrollTo: null,
  searchHits: null,
};

const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  if ("lang" in p || "theme" in p) storage.set("pdfaty.prefs", { lang: state.lang, theme: state.theme });
  listeners.forEach((l) => l());
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state), () => sel(state));
}

export function toast(kind: Toast["kind"], text: string, detail?: string): void {
  const t: Toast = { id: uid(), kind, text, detail };
  setState((s) => ({ toasts: [...s.toasts.slice(-3), t] }));
  setTimeout(() => dismissToast(t.id), kind === "error" ? 9000 : 5000);
}

export function dismissToast(id: string): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

const MAX_HISTORY = 12;
const MAX_HISTORY_BYTES = 400 * 1024 * 1024;

export function pushHistory(label: string): void {
  const d = state.doc;
  if (!d) return;
  let history = [...state.history, { bytes: d.bytes, label }];
  let total = history.reduce((n, v) => n + v.bytes.byteLength, 0);
  while (history.length > MAX_HISTORY || (total > MAX_HISTORY_BYTES && history.length > 1)) {
    total -= history[0].bytes.byteLength;
    history = history.slice(1);
  }
  setState({ history, future: [] });
}
