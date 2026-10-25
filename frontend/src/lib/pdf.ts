import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjsLib };
export type { PDFDocumentProxy };

export class PasswordNeeded extends Error {
  incorrect: boolean;
  constructor(incorrect: boolean) {
    super("password");
    this.incorrect = incorrect;
  }
}

/** Open a PDF from bytes. The bytes are copied because pdf.js transfers the buffer to its worker. */
export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  const task = pdfjsLib.getDocument({
    data: bytes.slice(),
    password: password || undefined,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
    isEvalSupported: false,
    enableXfa: false,
  });
  let pwError: PasswordNeeded | null = null;
  task.onPassword = (_update: (p: string) => void, reason: number) => {
    pwError = new PasswordNeeded(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
    task.destroy();
  };
  try {
    return await task.promise;
  } catch (e) {
    if (pwError) throw pwError;
    const name = (e as Error)?.name;
    if (name === "PasswordException") throw new PasswordNeeded(!!password);
    throw e;
  }
}

export async function isPdf(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const s = new TextDecoder("latin1").decode(head);
  return s.includes("%PDF-");
}

/** Render one page to a canvas at the given CSS width. Returns the canvas. */
export async function renderThumb(pdf: PDFDocumentProxy, pageIndex: number, width: number, rotate = 0): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1, rotation: (page.rotate + rotate) % 360 });
  const scale = width / base.width;
  const vp = page.getViewport({ scale: scale * Math.min(2, window.devicePixelRatio || 1), rotation: (page.rotate + rotate) % 360 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext("2d")!;
  await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
  return canvas;
}

export async function resolveDest(pdf: PDFDocumentProxy, dest: any): Promise<number | null> {
  try {
    let d = dest;
    if (typeof d === "string") d = await pdf.getDestination(d);
    if (!Array.isArray(d) || !d.length) return null;
    const ref = d[0];
    if (typeof ref === "number") return ref;
    return await pdf.getPageIndex(ref);
  } catch {
    return null;
  }
}

export interface OutlineNode {
  title: string;
  dest: any;
  url?: string | null;
  items: OutlineNode[];
}
