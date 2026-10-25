import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Indent, Outdent, Paperclip, Plus, Trash2 } from "lucide-react";
import { useT } from "../../i18n";
import { confirmDialog, currentFile, docParams, runOnDoc, runOp } from "../../lib/actions";
import { getState, toast, useStore } from "../../lib/store";
import { formatBytes, uid } from "../../lib/utils";
import { Button, Empty, Field, IconButton } from "../ui";
import { Outputs, type OutFile } from "./common";

export default function Metadata() {
  const t = useT();
  const doc = useStore((s) => s.doc)!;
  const [m, setM] = useState<Record<string, string>>({ title: "", author: "", subject: "", keywords: "", creator: "", producer: "", lang: "" });
  useEffect(() => {
    doc.pdf.getMetadata().then((x: any) => {
      const i = x.info || {};
      setM({ title: i.Title ?? "", author: i.Author ?? "", subject: i.Subject ?? "", keywords: i.Keywords ?? "", creator: i.Creator ?? "", producer: i.Producer ?? "", lang: i.Language ?? "" });
    }).catch(() => undefined);
  }, [doc.pdf]);
  const apply = async () => {
    const res = await runOnDoc("metadata_set", { metadata: { ...m, display_title: !!m.title } }, t("tool.metadata"));
    if (res) toast("success", t("done.applied", { tool: t("tool.metadata") }));
  };
  return (
    <div className="form">
      {(["title", "author", "subject", "keywords", "creator", "producer"] as const).map((k) => (
        <Field key={k} label={t(`props.${k}`)}><input className="input" dir="auto" value={m[k]} onChange={(e) => setM({ ...m, [k]: e.target.value })} /></Field>
      ))}
      <Field label={t("inspect.docLang")} help={t("meta.langHelp")}><input className="input" dir="ltr" value={m.lang} onChange={(e) => setM({ ...m, lang: e.target.value })} placeholder="ar" /></Field>
      <div className="tool-actions"><Button variant="primary" onClick={apply}>{t("common.apply")}</Button></div>
      <p className="muted small">{t("meta.note")}</p>
    </div>
  );
}

interface BM { id: string; title: string; page: number; level: number }

export function Bookmarks() {
  const t = useT();
  const version = useStore((s) => s.doc?.version);
  const numPages = useStore((s) => s.doc?.numPages ?? 1);
  const page = useStore((s) => s.page);
  const [list, setList] = useState<BM[] | null>(null);
  const load = async () => {
    const f = currentFile();
    if (!f) return;
    const res = await runOp("bookmarks_get", [f], docParams(), t("tool.bookmarks"), { fetchOutputs: false });
    if (!res) return;
    const flat: BM[] = [];
    const walk = (items: any[], level: number) => items.forEach((b) => { flat.push({ id: uid(), title: b.title, page: b.page ?? 0, level }); walk(b.children ?? [], level + 1); });
    walk(res.result.bookmarks, 0);
    setList(flat);
  };
  useEffect(() => { load(); }, [version]);
  if (!list) return <div className="muted small">{t("common.loading")}</div>;
  const up = (id: string, patch: Partial<BM>) => setList(list.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= list.length) return; const n = list.slice(); [n[i], n[j]] = [n[j], n[i]]; setList(n); };
  const toTree = () => {
    const root: any[] = [];
    const stack: { level: number; children: any[] }[] = [{ level: -1, children: root }];
    for (const b of list) {
      while (stack.length > 1 && stack[stack.length - 1].level >= b.level) stack.pop();
      const node = { title: b.title, page: b.page, children: [] as any[] };
      stack[stack.length - 1].children.push(node);
      stack.push({ level: b.level, children: node.children });
    }
    return root;
  };
  const save = async () => {
    const res = await runOnDoc("bookmarks_set", { bookmarks: toTree() }, t("tool.bookmarks"));
    if (res) toast("success", t("bm.saved"));
  };
  return (
    <div className="form">
      {!list.length && <Empty title={t("side.noOutline")}>{t("bm.hint")}</Empty>}
      <ul className="bm-list">
        {list.map((b, i) => (
          <li key={b.id} style={{ paddingInlineStart: b.level * 16 }}>
            <input className="input" dir="auto" value={b.title} onChange={(e) => up(b.id, { title: e.target.value })} aria-label={t("bm.title")} />
            <input className="input small-num" type="number" min={1} max={numPages} value={b.page + 1} onChange={(e) => up(b.id, { page: Math.max(0, Math.min(numPages - 1, Number(e.target.value) - 1)) })} aria-label={t("bm.page")} />
            <div className="row-actions">
              <IconButton label={t("bm.outdent")} onClick={() => up(b.id, { level: Math.max(0, b.level - 1) })}><Outdent size={13} /></IconButton>
              <IconButton label={t("bm.indent")} onClick={() => up(b.id, { level: Math.min(i > 0 ? list[i - 1].level + 1 : 0, b.level + 1) })}><Indent size={13} /></IconButton>
              <IconButton label={t("bm.up")} onClick={() => move(i, -1)}><ArrowUp size={13} /></IconButton>
              <IconButton label={t("bm.down")} onClick={() => move(i, 1)}><ArrowDown size={13} /></IconButton>
              <IconButton label={t("common.delete")} onClick={() => setList(list.filter((x) => x.id !== b.id))}><Trash2 size={13} /></IconButton>
            </div>
          </li>
        ))}
      </ul>
      <Button small icon={<Plus size={14} />} onClick={() => setList([...list, { id: uid(), title: t("bm.newTitle", { n: page + 1 }), page, level: 0 }])}>{t("bm.add")}</Button>
      <div className="tool-actions"><Button variant="primary" onClick={save}>{t("common.save")}</Button></div>
    </div>
  );
}

export function AttachmentsTool() {
  const t = useT();
  const doc = useStore((s) => s.doc)!;
  const lang = useStore((s) => s.lang);
  const [items, setItems] = useState<{ filename: string; content: Uint8Array }[]>([]);
  const [outs, setOuts] = useState<OutFile[]>([]);
  useEffect(() => { doc.pdf.getAttachments().then((a: any) => setItems(a ? Object.values(a) as any : [])).catch(() => setItems([])); }, [doc.pdf]);
  const add = async (files: File[]) => {
    const limit = 50 * 1024 * 1024;
    if (files.some((f) => f.size > limit)) { toast("error", t("err.file_too_large", { detail: "50" })); return; }
    const res = await runOnDoc("attachments_add", {}, t("tool.attachments"), files.map((f) => ({ name: f.name, data: f })));
    if (res) toast("success", t("attach.added", { n: res.result.added.length }));
  };
  const remove = async (name?: string) => {
    if (!(await confirmDialog(t("tool.attachments"), name ? t("attach.removeOne", { name }) : t("attach.removeAll")))) return;
    await runOnDoc("attachments_remove", name ? { names: [name] } : {}, t("tool.attachments"));
  };
  const extract = async () => {
    const f = currentFile();
    if (!f) return;
    const res = await runOp("attachments_extract", [f], docParams(), t("attach.extract"));
    if (res) setOuts(res.files);
  };
  void getState;
  return (
    <div className="form">
      {!items.length && <Empty icon={<Paperclip size={26} />} title={t("attach.none")} />}
      <ul className="attach-list">
        {items.map((a, i) => (
          <li key={i}><Paperclip size={14} /><span className="grow" dir="auto">{a.filename}</span><span className="muted small">{formatBytes(a.content.byteLength, lang)}</span>
            <IconButton label={t("common.delete")} onClick={() => remove(a.filename)}><Trash2 size={13} /></IconButton></li>
        ))}
      </ul>
      <label className="btn btn-default">
        <Plus size={16} /><span>{t("attach.add")}</span>
        <input type="file" hidden multiple onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; if (fs.length) add(fs); }} />
      </label>
      <div className="tool-actions">
        <Button onClick={extract} disabled={!items.length}>{t("attach.extract")}</Button>
        <Button variant="danger" onClick={() => remove()} disabled={!items.length}>{t("attach.removeAllBtn")}</Button>
      </div>
      <p className="muted small">{t("attach.warn")}</p>
      <Outputs files={outs} />
    </div>
  );
}
