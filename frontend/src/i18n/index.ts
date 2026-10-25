import { useStore, getState, type Lang } from "../lib/store";
import ar from "./ar";
import en from "./en";

export type Dict = Record<string, string>;
const dicts: Record<Lang, Dict> = { ar, en };

export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  let s = dicts[lang][key] ?? dicts.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Non-hook translation (uses the current language). */
export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(getState().lang, key, vars);
}

export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const lang = useStore((s) => s.lang);
  return (key, vars) => translate(lang, key, vars);
}

export function errorText(code: string, detail?: string | null): string {
  const lang = getState().lang;
  const key = `err.${code}`;
  const msg = dicts[lang][key] ?? dicts.en[key];
  if (msg) return translate(lang, key, { detail: detail ?? "" });
  return translate(lang, "err.generic", { code });
}
