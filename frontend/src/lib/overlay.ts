// Lets the active tool draw an interactive layer above every rendered page.
import { useSyncExternalStore, type ReactNode } from "react";
import type { PageViewport } from "pdfjs-dist";

export interface PageInfo {
  index: number;
  scale: number; // css px per PDF point
  width: number; // css px
  height: number;
  viewport: PageViewport;
}

export interface OverlaySpec {
  render: (p: PageInfo) => ReactNode;
  /** when true the overlay captures pointer events (drawing tools); text selection is disabled */
  capture: boolean;
  cursor?: string;
}

let current: OverlaySpec | null = null;
const ls = new Set<() => void>();

export function setOverlay(spec: OverlaySpec | null): void {
  current = spec;
  ls.forEach((l) => l());
}

export function useOverlay(): OverlaySpec | null {
  return useSyncExternalStore(
    (l) => {
      ls.add(l);
      return () => ls.delete(l);
    },
    () => current,
  );
}

/** Text items cache for search/highlighting, keyed by document id + version. */
export interface TextItemLite {
  str: string;
  eol: boolean;
}
const textCache = new Map<string, TextItemLite[][]>();
export function getTextCache(key: string): TextItemLite[][] | undefined {
  return textCache.get(key);
}
export function setTextCache(key: string, v: TextItemLite[][]): void {
  if (textCache.size > 4) textCache.delete(textCache.keys().next().value as string);
  textCache.set(key, v);
}

/** Search highlights: page -> list of [itemIndex, start, end, isActive]. */
export type Highlights = Map<number, [number, number, number, boolean][]>;
let hl: Highlights = new Map();
const hls = new Set<() => void>();
export function setHighlights(h: Highlights): void {
  hl = h;
  hls.forEach((l) => l());
}
export function useHighlights(): Highlights {
  return useSyncExternalStore(
    (l) => {
      hls.add(l);
      return () => hls.delete(l);
    },
    () => hl,
  );
}
