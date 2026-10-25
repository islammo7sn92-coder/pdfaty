// Client for the PDFATY job API. Every server operation is: upload -> poll -> fetch outputs -> delete.

export interface JobOutput {
  index: number;
  name: string;
  size: number;
  mime: string;
}

export interface JobStatus {
  id: string;
  op: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  message: string;
  error: string | null;
  error_detail: string | null;
  outputs: JobOutput[];
  result: Record<string, any>;
}

export interface RunResult {
  result: Record<string, any>;
  files: { name: string; mime: string; blob: Blob }[];
}

export class ApiError extends Error {
  code: string;
  detail?: string | null;
  constructor(code: string, detail?: string | null) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

export interface UploadFile {
  name: string;
  data: Blob;
}

export interface Capabilities {
  version: string;
  ops: string[];
  ocr: boolean;
  ocr_languages: string[];
  office: boolean;
  limits: { max_upload_mb: number; max_total_mb: number; max_files: number; max_pages: number; job_timeout: number; result_ttl: number };
}

let capsPromise: Promise<Capabilities> | null = null;

export function getCapabilities(): Promise<Capabilities> {
  if (!capsPromise) {
    capsPromise = fetch("/api/capabilities")
      .then((r) => (r.ok ? r.json() : Promise.reject(new ApiError("server_unreachable"))))
      .catch((e) => {
        capsPromise = null;
        throw e instanceof ApiError ? e : new ApiError("server_unreachable");
      });
  }
  return capsPromise;
}

async function parseError(r: Response): Promise<ApiError> {
  try {
    const j = await r.json();
    return new ApiError(j.error || `http_${r.status}`, j.detail);
  } catch {
    return new ApiError(r.status === 413 ? "file_too_large" : r.status >= 500 ? "server_error" : `http_${r.status}`);
  }
}

export interface RunOptions {
  onProgress?: (pct: number, stage: "upload" | "queue" | "process" | "download") => void;
  signal?: AbortSignal;
  fetchOutputs?: boolean | ((o: JobOutput) => boolean);
}

function upload(op: string, files: UploadFile[], params: Record<string, any>, opts: RunOptions): Promise<string> {
  // XMLHttpRequest gives upload progress events; fetch does not.
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("op", op);
    fd.append("params", JSON.stringify(params ?? {}));
    for (const f of files) fd.append("files", f.data, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/jobs");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.((e.loaded / e.total) * 100, "upload");
    };
    xhr.onload = () => {
      const body = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300 && body.id) resolve(body.id);
      else reject(new ApiError(body.error || (xhr.status === 413 ? "file_too_large" : `http_${xhr.status}`), body.detail));
    };
    xhr.onerror = () => reject(new ApiError("network_error"));
    xhr.onabort = () => reject(new ApiError("cancelled"));
    opts.signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(fd);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runJob(op: string, files: UploadFile[], params: Record<string, any> = {}, opts: RunOptions = {}): Promise<RunResult> {
  const id = await upload(op, files, params, opts);
  let status: JobStatus | null = null;
  let delay = 250;
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new ApiError("cancelled");
      const r = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
      if (!r.ok) throw await parseError(r);
      status = (await r.json()) as JobStatus;
      if (status.status === "done" || status.status === "error") break;
      opts.onProgress?.(status.progress, status.status === "queued" ? "queue" : "process");
      await sleep(delay);
      delay = Math.min(1000, delay + 100);
    }
    if (status.status === "error") throw new ApiError(status.error || "processing_failed", status.error_detail);
    const files_: RunResult["files"] = [];
    const want = opts.fetchOutputs ?? true;
    const outs = status.outputs.filter((o) => (typeof want === "function" ? want(o) : want));
    for (let i = 0; i < outs.length; i++) {
      const o = outs[i];
      opts.onProgress?.((i / outs.length) * 100, "download");
      const r = await fetch(`/api/jobs/${id}/files/${o.index}`, { cache: "no-store" });
      if (!r.ok) throw await parseError(r);
      files_.push({ name: o.name, mime: o.mime, blob: await r.blob() });
    }
    return { result: status.result || {}, files: files_ };
  } finally {
    // results are deleted from the server as soon as we have them
    fetch(`/api/jobs/${id}`, { method: "DELETE" }).catch(() => undefined);
  }
}
