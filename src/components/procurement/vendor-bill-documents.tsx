"use client";

import { useRef, useState } from "react";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  FileText, ExternalLink, Pencil, Trash2, Plus, Loader2, Lock, Paperclip, X,
} from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";
import type { VendorBillDocument } from "@/types";

interface VendorBillDocumentsProps {
  billId: string;
  approvalStatus: string;
  approvedAt: string | null;
  documents: VendorBillDocument[];
  onChanged: () => void | Promise<void>;
}

// Documents can be added in any approval state. Editing or deleting an
// existing one is only allowed while the bill is pending/rejected — once
// approved, the approval was granted against those exact files, so the API
// route (and the RLS policy behind it) rejects the write. This mirrors that
// lock in the UI so the buttons are disabled with an explanation rather than
// failing silently.
export function VendorBillDocuments({ billId, approvalStatus, approvedAt, documents, onChanged }: VendorBillDocumentsProps) {
  const locked = approvalStatus === "approved";
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editFileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [editingDoc, setEditingDoc] = useState<VendorBillDocument | null>(null);
  const [editUploading, setEditUploading] = useState(false);
  const [deletingDoc, setDeletingDoc] = useState<VendorBillDocument | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function uploadToStorage(file: File) {
    const supabase = createBrowserClient();
    const ext = file.name.split(".").pop() ?? "pdf";
    const filePath = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const { error: uploadError } = await supabase.storage.from("vendor-invoices").upload(filePath, file);
    if (uploadError) throw new Error(uploadError.message);
    const { data: urlData } = supabase.storage.from("vendor-invoices").getPublicUrl(filePath);
    return urlData.publicUrl;
  }

  async function handleAdd(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setUploading(true);
    try {
      const fileUrl = await uploadToStorage(file);
      const res = await fetch(`/api/procurement/bills/${billId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_url: fileUrl, file_name: file.name }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to attach document"); return; }
      toast.success("Document attached");
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleReplace(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !editingDoc) return;

    setEditUploading(true);
    try {
      const fileUrl = await uploadToStorage(file);
      const res = await fetch(`/api/procurement/bills/${billId}/documents/${editingDoc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_url: fileUrl, file_name: file.name }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to update document"); return; }
      toast.success("Document updated");
      setEditingDoc(null);
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setEditUploading(false);
    }
  }

  async function handleDelete() {
    if (!deletingDoc) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/procurement/bills/${billId}/documents/${deletingDoc.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to delete document"); return; }
      toast.success("Document removed");
      setDeletingDoc(null);
      await onChanged();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="rounded-md border border-dashed px-3 py-2.5 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <FileText className="h-4 w-4 text-muted-foreground" />
          Supporting Documents
        </div>
      </div>

      {locked && (
        <div className="flex items-start gap-2 rounded-md bg-teal-50 border border-teal-100 px-2.5 py-2 text-xs text-teal-900">
          <Lock className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-primary" />
          <span>Approved — existing documents are locked. You can still attach new ones below.</span>
        </div>
      )}

      {documents.length === 0 ? (
        <p className="text-xs text-muted-foreground">No documents attached yet.</p>
      ) : (
        <div className="space-y-1">
          {documents.map((doc) => (
            <div key={doc.id} className="flex items-center gap-2.5 py-1.5 group">
              <FileText className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium truncate">{doc.file_name}</span>
                  {doc.doc_type === "invoice" && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-teal-50 text-primary flex-shrink-0">
                      Original
                    </span>
                  )}
                  {doc.doc_type === "supporting" && approvedAt && doc.created_at > approvedAt && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-green-50 text-green-700 flex-shrink-0">
                      Added after approval
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {doc.uploader?.full_name ?? "Unknown"} · {formatDate(doc.created_at)}
                </p>
              </div>
              <div className="flex items-center gap-0.5 flex-shrink-0">
                <a
                  href={doc.file_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="h-7 w-7 flex items-center justify-center rounded-md text-primary hover:bg-primary/10"
                  title="View"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => setEditingDoc(doc)}
                  title={locked ? "Locked after approval — attach a new document instead" : "Replace file"}
                  className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => setDeletingDoc(doc)}
                  title={locked ? "Can't delete after approval — preserves the approval trail" : "Delete"}
                  className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="pt-1 border-t">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs mt-2"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
          Add document
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,.webp"
          className="sr-only"
          onChange={handleAdd}
        />
      </div>

      {/* Replace-file dialog */}
      <Dialog open={!!editingDoc} onOpenChange={(open) => !open && setEditingDoc(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace document</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2 text-sm">
            <p className="text-xs text-muted-foreground">
              Choose a new file to replace <strong>{editingDoc?.file_name}</strong>. The old file will no longer be linked.
            </p>
            {editUploading ? (
              <div className="flex items-center justify-center rounded-md border-2 border-dashed px-4 py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div
                className="flex items-center justify-center rounded-md border-2 border-dashed border-muted-foreground/25 px-4 py-6 cursor-pointer hover:border-muted-foreground/50 transition-colors"
                onClick={() => editFileInputRef.current?.click()}
              >
                <div className="text-center">
                  <Paperclip className="h-6 w-6 text-muted-foreground mx-auto mb-1" />
                  <p className="text-sm text-muted-foreground">Click to choose a file (PDF, JPG, PNG — max 10 MB)</p>
                </div>
              </div>
            )}
            <input
              ref={editFileInputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              className="sr-only"
              onChange={handleReplace}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingDoc(null)} disabled={editUploading}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deletingDoc} onOpenChange={(open) => !open && setDeletingDoc(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete document?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            This removes <strong>{deletingDoc?.file_name}</strong> from the bill. This can&apos;t be undone.
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeletingDoc(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              <X className="h-4 w-4 mr-1" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
