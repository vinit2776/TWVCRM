"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  FileText, ExternalLink, Upload, Loader2, CheckCircle2, AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";
import type { AgreementDocumentVersion, AgreementReuploadReason } from "@/types";

const REASON_LABELS: Record<AgreementReuploadReason, string> = {
  name_change: "Customer name change",
  law_change: "Change of law / redocumentation",
  other: "Other",
};

interface AgreementDocumentHistoryProps {
  listUrl: string;
  reuploadUrl: string;
  reuploadExtraFields?: Record<string, string>;
  canManage: boolean;
  hasExistingDocument: boolean;
  onChanged?: () => void | Promise<void>;
}

export function AgreementDocumentHistory({
  listUrl,
  reuploadUrl,
  reuploadExtraFields,
  canManage,
  hasExistingDocument,
  onChanged,
}: AgreementDocumentHistoryProps) {
  const [versions, setVersions] = useState<AgreementDocumentVersion[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState<AgreementReuploadReason>("name_change");
  const [notes, setNotes] = useState("");
  const [isSignedSealed, setIsSignedSealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const fetchVersions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(listUrl);
      const json = await res.json();
      setVersions(res.ok ? json.data || [] : []);
    } catch {
      setVersions([]);
    } finally {
      setLoading(false);
    }
  }, [listUrl]);

  useEffect(() => {
    if (hasExistingDocument) fetchVersions();
    else { setVersions([]); setLoading(false); }
  }, [fetchVersions, hasExistingDocument]);

  function resetDialog() {
    setReason("name_change");
    setNotes("");
    setIsSignedSealed(false);
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSubmit() {
    if (!selectedFile) {
      toast.error("Please choose a PDF file");
      return;
    }
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append("file", selectedFile);
      form.append("reason", reason);
      if (notes.trim()) form.append("reason_notes", notes.trim());
      form.append("is_signed_sealed", String(isSignedSealed));
      if (reuploadExtraFields) {
        for (const [key, value] of Object.entries(reuploadExtraFields)) form.append(key, value);
      }

      const res = await fetch(reuploadUrl, { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to reupload agreement");
        return;
      }
      toast.success(
        isSignedSealed
          ? "New version uploaded and confirmed signed & sealed."
          : "New version uploaded — flagged as unconfirmed signed & sealed."
      );
      setDialogOpen(false);
      resetDialog();
      await fetchVersions();
      await onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setSubmitting(false);
    }
  }

  const current = versions?.find((v) => v.is_current);
  const currentUnconfirmed = current && current.is_signed_sealed === false;

  return (
    <div className="rounded-md border border-dashed px-3 py-2.5 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <FileText className="h-4 w-4 text-muted-foreground" />
          Agreement Documents
        </div>
        {canManage && hasExistingDocument && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setDialogOpen(true)}
          >
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            Reupload agreement
          </Button>
        )}
      </div>

      {currentUnconfirmed && (
        <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-100 px-2.5 py-2 text-xs text-amber-900">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-amber-600" />
          <span>Current version isn&apos;t confirmed signed &amp; sealed. Replace it once the fully executed copy is available.</span>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading document history…</p>
      ) : !hasExistingDocument ? (
        <p className="text-xs text-muted-foreground">No agreement document yet.</p>
      ) : (
        <div className="space-y-2">
          {(versions || []).map((v) => (
            <div key={v.id} className="flex items-start gap-2.5 py-1.5">
              <FileText className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-mono text-muted-foreground">v{v.version}</span>
                  <span className="text-xs font-medium truncate">{v.file_name}</span>
                  <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0 ${
                    v.is_current ? "bg-teal-50 text-primary" : "bg-muted text-muted-foreground"
                  }`}>
                    {v.is_current ? "Current" : "Superseded"}
                  </span>
                  {v.is_signed_sealed === true && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-green-50 text-green-700 flex-shrink-0">
                      <CheckCircle2 className="h-2.5 w-2.5" /> Signed &amp; sealed
                    </span>
                  )}
                  {v.is_signed_sealed === false && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 flex-shrink-0">
                      <AlertTriangle className="h-2.5 w-2.5" /> Not confirmed
                    </span>
                  )}
                </div>
                {v.reupload_reason && (
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    <span className="font-medium text-foreground">{REASON_LABELS[v.reupload_reason]}</span>
                    {v.reupload_notes ? ` — ${v.reupload_notes}` : ""}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {v.uploader?.full_name ?? "Unknown"} · {formatDate(v.created_at)}
                </p>
              </div>
              {v.view_url && (
                <a
                  href={v.view_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="h-7 w-7 flex items-center justify-center rounded-md text-primary hover:bg-primary/10 flex-shrink-0"
                  title="View"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="text-[10.5px] text-muted-foreground pt-1 border-t">
        Older versions are never deleted — reuploading is logged to the audit trail and only changes which version is current.
      </p>

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reupload agreement</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <Label>Reason for reupload</Label>
              <Select value={reason} onValueChange={(v) => setReason(v as AgreementReuploadReason)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.entries(REASON_LABELS) as [AgreementReuploadReason, string][]).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reupload-notes">Notes (optional)</Label>
              <Textarea
                id="reupload-notes"
                placeholder="e.g. Renamed per gazette notification dated 12 Aug 2026"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Document (PDF, max 20 MB)</Label>
              {submitting ? (
                <div className="flex items-center justify-center rounded-md border-2 border-dashed px-4 py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div
                  className="flex items-center justify-center rounded-md border-2 border-dashed border-muted-foreground/25 px-4 py-6 cursor-pointer hover:border-muted-foreground/50 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <div className="text-center">
                    <Upload className="h-6 w-6 text-muted-foreground mx-auto mb-1" />
                    <p className="text-sm text-muted-foreground">
                      {selectedFile ? selectedFile.name : "Click to choose a PDF file"}
                    </p>
                  </div>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf"
                className="sr-only"
                onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
              />
            </div>

            <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2.5">
              <Checkbox
                id="reupload-sealed"
                checked={isSignedSealed}
                onCheckedChange={(checked) => setIsSignedSealed(checked === true)}
                className="mt-0.5"
              />
              <div>
                <Label htmlFor="reupload-sealed" className="font-normal cursor-pointer">
                  This is the fully signed and sealed copy, executed by both parties.
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Leave unchecked for a draft or partially-signed copy — you can still upload it.
                </p>
              </div>
            </div>

            {!isSignedSealed && (
              <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-100 px-2.5 py-2 text-xs text-amber-900">
                <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-amber-600" />
                <span>
                  This will upload as <strong>unconfirmed signed &amp; sealed</strong>. It&apos;ll show a warning flag until a fully
                  executed copy replaces it. You can still continue.
                </span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={submitting || !selectedFile}>
              {submitting && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Upload new version
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
