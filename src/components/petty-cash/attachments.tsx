"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Loader2, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { prepareUpload } from "@/lib/uploads/upload-gate";
import {
  PC_ATTACHMENT_MAX_BYTES,
  PC_ATTACHMENT_MAX_FILES,
  type PcAttachmentKind,
} from "@/lib/petty-cash-attachments";

const ACCEPT = "image/*,application/pdf";

export type AttachmentTarget = { entryId: string } | { requestId: string };

export interface AttachmentFile {
  id: string;
  kind: PcAttachmentKind;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string;
  uploaded_by_name: string | null;
  created_at: string;
  url: string | null;
}

/** Uploads files one by one; returns how many failed so the caller can say so in plain words. */
export async function uploadAttachments(files: File[], target: AttachmentTarget, kind?: PcAttachmentKind): Promise<number> {
  let failed = 0;
  for (const original of files) {
    try {
      const prepared = await prepareUpload(original);
      if (!prepared) { failed++; continue; }
      const fd = new FormData();
      fd.append("file", prepared);
      if ("entryId" in target) fd.append("entry_id", target.entryId);
      else fd.append("request_id", target.requestId);
      if (kind) fd.append("kind", kind);
      const res = await fetch("/api/petty-cash/attachments", { method: "POST", body: fd });
      if (!res.ok) failed++;
    } catch {
      failed++;
    }
  }
  return failed;
}

function size(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Choose files now, upload them after the form is saved (the record has no id yet).
 * Entirely optional: nothing here blocks Submit.
 */
export function AttachmentPicker({
  files, onChange, label, help,
}: { files: File[]; onChange: (f: File[]) => void; label: string; help: string }) {
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (next.length >= PC_ATTACHMENT_MAX_FILES) { toast.error(`You can attach up to ${PC_ATTACHMENT_MAX_FILES} files.`); break; }
      if (!/^image\//.test(f.type) && f.type !== "application/pdf") { toast.error(`${f.name}: only photos or PDF files can be attached.`); continue; }
      next.push(f);
    }
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label} <span className="font-normal text-muted-foreground">(optional)</span></p>
      <p className="text-xs text-muted-foreground">{help}</p>
      <input ref={inputRef} type="file" accept={ACCEPT} multiple className="hidden"
        onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()}
        disabled={files.length >= PC_ATTACHMENT_MAX_FILES}>
        <Paperclip className="h-4 w-4 mr-1" />Choose photo or file
      </Button>
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-sm">
              <span className="truncate"><FileText className="inline h-3.5 w-3.5 mr-1 text-muted-foreground" />{f.name} <span className="text-xs text-muted-foreground">· {size(f.size)}</span></span>
              <button type="button" className="text-xs text-red-600 hover:underline shrink-0"
                onClick={() => onChange(files.filter((_, j) => j !== i))}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">Photos and PDFs, up to {PC_ATTACHMENT_MAX_FILES} files, {Math.round(PC_ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB each.</p>
    </div>
  );
}

/** The files already saved on one expense or request, with Add / Remove where this user is allowed. */
export function AttachmentList({
  target, kind, canAdd, canRemove, addLabel, emptyText, onChanged,
}: {
  target: AttachmentTarget;
  kind?: PcAttachmentKind;
  canAdd: boolean;
  canRemove: (f: AttachmentFile) => boolean;
  addLabel: string;
  emptyText: string;
  onChanged?: () => void;
}) {
  const [files, setFiles] = useState<AttachmentFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const qs = "entryId" in target ? `entry_id=${target.entryId}` : `request_id=${target.requestId}`;

  const load = useCallback(async () => {
    const res = await fetch(`/api/petty-cash/attachments?${qs}`);
    const json = await res.json();
    if (!res.ok) { toast.error(json.error || "Could not load files"); setFiles([]); return; }
    setFiles(json.data);
  }, [qs]);

  useEffect(() => { load(); }, [load]);

  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    const failed = await uploadAttachments(Array.from(list), target, kind);
    setBusy(false);
    if (failed) toast.error(`${failed} file${failed > 1 ? "s" : ""} could not be uploaded. Try again, or use a smaller file.`);
    else toast.success("File added");
    await load();
    onChanged?.();
  };

  const remove = async (f: AttachmentFile) => {
    if (!window.confirm(`Remove "${f.file_name}"? This deletes the file.`)) return;
    const res = await fetch(`/api/petty-cash/attachments/${f.id}`, { method: "DELETE" });
    if (!res.ok) { toast.error((await res.json()).error || "Could not remove"); return; }
    toast.success("File removed");
    await load();
    onChanged?.();
  };

  if (files === null) return <div className="h-12 animate-pulse rounded bg-muted" />;

  return (
    <div className="space-y-3">
      {files.length === 0 ? (
        <p className="text-sm text-muted-foreground rounded border border-dashed p-4 text-center">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {files.map((f) => (
            <li key={f.id} className="rounded border p-2 text-sm">
              {f.mime_type.startsWith("image/") && f.url && (
                // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not optimisable
                <a href={f.url} target="_blank" rel="noreferrer"><img src={f.url} alt={f.file_name} className="mb-2 max-h-56 rounded border object-contain" /></a>
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">{f.file_name} <span className="text-xs text-muted-foreground">· {size(f.size_bytes)}{f.uploaded_by_name ? ` · added by ${f.uploaded_by_name}` : ""}</span></span>
                <span className="flex gap-3 shrink-0">
                  {f.url && <a href={f.url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">Open full size</a>}
                  {canRemove(f) && <button type="button" onClick={() => remove(f)} className="text-xs text-red-600 hover:underline">Remove</button>}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <div className="space-y-1">
          <input ref={inputRef} type="file" accept={ACCEPT} multiple className="hidden"
            onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
          <Button type="button" size="sm" variant="outline" disabled={busy || (files.length >= PC_ATTACHMENT_MAX_FILES)}
            onClick={() => inputRef.current?.click()}>
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Paperclip className="h-4 w-4 mr-1" />}{addLabel}
          </Button>
          <p className="text-xs text-muted-foreground">The file is saved straight away when you pick it.</p>
        </div>
      )}
    </div>
  );
}

/** Dialog wrapper so list rows can open "view / add bills" with one clearly named button. */
export function AttachmentDialog({
  open, onOpenChange, title, description, ...listProps
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
} & React.ComponentProps<typeof AttachmentList>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {open && <AttachmentList {...listProps} />}
      </DialogContent>
    </Dialog>
  );
}
