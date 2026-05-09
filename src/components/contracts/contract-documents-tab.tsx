"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Upload,
  CheckCircle2,
  XCircle,
  Eye,
  Loader2,
  FileText,
  AlertTriangle,
  Clock,
  MoreHorizontal,
  RotateCcw,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { prepareUpload, UploadTooLargeError } from "@/lib/uploads/upload-gate";
import { formatDate } from "@/lib/utils";
import type { ContractDocument } from "@/types";

interface ContractDocumentsTabProps {
  contractId: string;
  userRole?: string | null;
  onKycStatusChange?: (
    allSatisfied: boolean,
    total: number,
    approved: number,
    deferred: number
  ) => void;
}

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  uploaded: "bg-blue-100 text-blue-700",
  approved: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
  deferred: "bg-amber-100 text-amber-700",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  uploaded: "Uploaded",
  approved: "Approved",
  rejected: "Rejected",
  deferred: "Deferred",
};

function isOverdue(deferredUntil?: string): boolean {
  if (!deferredUntil) return false;
  return new Date(deferredUntil) < new Date();
}

export function ContractDocumentsTab({
  contractId,
  userRole,
  onKycStatusChange,
}: ContractDocumentsTabProps) {
  const [docs, setDocs] = useState<ContractDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadDocId, setUploadDocId] = useState<string | null>(null);

  // Review state
  const [reviewingDoc, setReviewingDoc] = useState<ContractDocument | null>(null);
  const [reviewStatus, setReviewStatus] = useState<"approved" | "rejected">("approved");
  const [rejectionReason, setRejectionReason] = useState("");
  const [reviewing, setReviewing] = useState(false);

  // Defer state
  const [deferringDoc, setDeferringDoc] = useState<ContractDocument | null>(null);
  const [deferReason, setDeferReason] = useState("");
  const [deferUntil, setDeferUntil] = useState("");
  const [deferAcknowledged, setDeferAcknowledged] = useState(false);
  const [deferring, setDeferring] = useState(false);

  // Un-defer state
  const [undeferringId, setUndeferringId] = useState<string | null>(null);

  const canDefer = userRole === "admin" || userRole === "manager";

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/contracts/${contractId}/documents`);
    if (res.ok) {
      const json = await res.json();
      const data: ContractDocument[] = json.data || [];
      setDocs(data);

      // Auto-initialize if empty
      if (data.length === 0) {
        const initRes = await fetch(`/api/contracts/${contractId}/documents/init`, { method: "POST" });
        if (initRes.ok) {
          const res2 = await fetch(`/api/contracts/${contractId}/documents`);
          if (res2.ok) {
            const json2 = await res2.json();
            setDocs(json2.data || []);
          }
        }
      }
    }
    setLoading(false);
  }, [contractId]);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  // Report KYC status to parent: deferred docs count as "satisfied" for activation
  useEffect(() => {
    if (!onKycStatusChange || docs.length === 0) return;
    const required = docs.filter(d => d.is_required);
    const approved = required.filter(d => d.status === "approved").length;
    const deferred = required.filter(d => d.status === "deferred").length;
    const allSatisfied = required.length > 0 && (approved + deferred) >= required.length;
    onKycStatusChange(allSatisfied, required.length, approved, deferred);
  }, [docs, onKycStatusChange]);

  const handleUpload = async (docId: string, raw: File) => {
    setUploading(docId);
    try {
      // Normalize before upload: images → JPEG 2048px, PDFs → stripped.
      const file = await prepareUpload(raw);
      if (!file) return;

      const urlRes = await fetch("/api/documents/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type,
          path: `contract-documents/${contractId}`,
        }),
      });
      if (!urlRes.ok) throw new Error("Failed to get upload URL");
      const { token, path: filePath } = await urlRes.json();

      const supabase = createBrowserClient();
      const { error: storageError } = await supabase.storage
        .from("crm-documents")
        .uploadToSignedUrl(filePath, token, file, { contentType: file.type || "application/octet-stream" });
      if (storageError) throw new Error(storageError.message);

      const res = await fetch(`/api/contracts/${contractId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document_id: docId,
          filePath,
          fileName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        }),
      });

      if (res.ok) {
        toast.success("Document uploaded");
        fetchDocs();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Upload failed");
      }
    } catch (e) {
      if (e instanceof UploadTooLargeError) {
        toast.error(e.message);
      } else {
        toast.error(e instanceof Error ? e.message : "Upload failed");
      }
    } finally {
      setUploading(null);
    }
  };

  const handleReview = async () => {
    if (!reviewingDoc) return;
    if (reviewStatus === "rejected" && !rejectionReason.trim()) {
      toast.error("Rejection reason is required");
      return;
    }
    setReviewing(true);
    const res = await fetch(`/api/contracts/${contractId}/documents/${reviewingDoc.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: reviewStatus,
        rejection_reason: reviewStatus === "rejected" ? rejectionReason.trim() : undefined,
      }),
    });
    setReviewing(false);
    if (res.ok) {
      toast.success(reviewStatus === "approved" ? "Document approved" : "Document rejected");
      setReviewingDoc(null);
      setRejectionReason("");
      fetchDocs();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Review failed");
    }
  };

  const handleDefer = async () => {
    if (!deferringDoc) return;
    if (!deferReason.trim()) {
      toast.error("Please enter a deferral reason");
      return;
    }
    if (!deferAcknowledged) {
      toast.error("Please acknowledge that this is a temporary deferral");
      return;
    }
    setDeferring(true);
    const res = await fetch(`/api/contracts/${contractId}/documents/${deferringDoc.id}/defer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: deferReason.trim(), defer_until: deferUntil || undefined }),
    });
    setDeferring(false);
    if (res.ok) {
      toast.success("Document deferred — compliance still required");
      setDeferringDoc(null);
      setDeferReason("");
      setDeferUntil("");
      setDeferAcknowledged(false);
      fetchDocs();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to defer document");
    }
  };

  const handleUndeferr = async (doc: ContractDocument) => {
    setUndeferringId(doc.id);
    const res = await fetch(`/api/contracts/${contractId}/documents/${doc.id}/defer`, {
      method: "DELETE",
    });
    setUndeferringId(null);
    if (res.ok) {
      toast.success("Deferral removed — document is now pending");
      fetchDocs();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to un-defer document");
    }
  };

  const handleViewDoc = async (doc: ContractDocument) => {
    if (!doc.document?.id) return;
    const res = await fetch(`/api/documents/${doc.document.id}/view`);
    if (res.ok) {
      const json = await res.json();
      if (json.signedUrl) window.open(json.signedUrl, "_blank");
    } else {
      toast.error("Failed to load document");
    }
  };

  const requiredDocs = docs.filter(d => d.is_required);
  const approvedCount = requiredDocs.filter(d => d.status === "approved").length;
  const deferredCount = requiredDocs.filter(d => d.status === "deferred").length;
  const totalRequired = requiredDocs.length;
  const allSatisfied = totalRequired > 0 && (approvedCount + deferredCount) >= totalRequired;
  const approvedPct = totalRequired > 0 ? (approvedCount / totalRequired) * 100 : 0;
  const deferredPct = totalRequired > 0 ? (deferredCount / totalRequired) * 100 : 0;

  if (loading) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">KYC Documents</CardTitle></CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-3">
            {[1, 2, 3].map(i => <div key={i} className="h-12 rounded bg-muted" />)}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (docs.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">KYC Documents</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground py-4 text-center">
            No KYC documents required. Set the entity type on the lead profile to see required documents.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Check if any deferred docs are overdue
  const overdueCount = requiredDocs.filter(
    d => d.status === "deferred" && isOverdue(d.deferred_until)
  ).length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4" />
          KYC Documents
          <Badge
            variant="secondary"
            className={
              allSatisfied && deferredCount === 0
                ? "bg-green-100 text-green-700"
                : allSatisfied
                ? "bg-amber-100 text-amber-700"
                : "bg-amber-100 text-amber-700"
            }
          >
            {approvedCount}/{totalRequired} approved
            {deferredCount > 0 && ` · ${deferredCount} deferred`}
          </Badge>
        </CardTitle>
        {!allSatisfied && (
          <div className="flex items-center gap-1 text-xs text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5" />
            Incomplete
          </div>
        )}
      </CardHeader>

      <CardContent>
        {/* Overdue deferral banner */}
        {overdueCount > 0 && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5">
            <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
            <div className="text-xs text-red-800">
              <p className="font-semibold">
                {overdueCount} deferred document{overdueCount > 1 ? "s are" : " is"} overdue
              </p>
              <p className="mt-0.5">The collection deadline has passed. Please follow up immediately.</p>
            </div>
          </div>
        )}

        {/* Three-segment progress bar: green = approved, amber = deferred, gray = remaining */}
        <div className="w-full bg-gray-200 rounded-full h-1.5 mb-4 flex overflow-hidden">
          {approvedPct > 0 && (
            <div
              className="h-1.5 bg-green-500 transition-all"
              style={{ width: `${approvedPct}%` }}
            />
          )}
          {deferredPct > 0 && (
            <div
              className="h-1.5 bg-amber-400 transition-all"
              style={{ width: `${deferredPct}%` }}
            />
          )}
        </div>

        {/* Deferred-docs general note */}
        {deferredCount > 0 && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5">
            <Clock className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-800">
              <span className="font-semibold">
                {deferredCount} document{deferredCount > 1 ? "s" : ""} deferred — compliance pending.
              </span>{" "}
              These must be collected to achieve full KYC compliance.
            </p>
          </div>
        )}

        <div className="space-y-2">
          {docs.map((doc) => {
            const deferred = doc.status === "deferred";
            const overdue = deferred && isOverdue(doc.deferred_until);

            return (
              <div
                key={doc.id}
                className={`flex items-start justify-between gap-3 rounded-lg border p-3 transition-colors ${
                  overdue
                    ? "border-orange-300 bg-orange-50/40"
                    : deferred
                    ? "border-amber-200 bg-amber-50/30"
                    : ""
                }`}
              >
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {deferred ? (
                      <Clock className={`h-3.5 w-3.5 shrink-0 ${overdue ? "text-orange-500" : "text-amber-500"}`} />
                    ) : doc.status === "approved" ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600" />
                    ) : doc.status === "rejected" ? (
                      <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                    ) : null}
                    <span className="text-sm font-medium">{doc.label}</span>
                    {doc.is_required && (
                      <Badge variant="outline" className="text-[10px] px-1">Required</Badge>
                    )}
                    <Badge
                      variant="secondary"
                      className={`${STATUS_BADGE[doc.status] || ""} ${overdue ? "!bg-orange-100 !text-orange-700" : ""}`}
                    >
                      {overdue ? "Overdue" : STATUS_LABELS[doc.status] || doc.status}
                    </Badge>
                  </div>

                  {/* Rejection reason */}
                  {doc.status === "rejected" && doc.rejection_reason && (
                    <p className="text-xs text-red-600">
                      Rejected: {doc.rejection_reason}
                    </p>
                  )}

                  {/* Approved by */}
                  {doc.status === "approved" && doc.reviewer && (
                    <p className="text-xs text-green-600">
                      Approved by {doc.reviewer.full_name}
                    </p>
                  )}

                  {/* Carried from parent contract (renewal) */}
                  {doc.notes && doc.notes.includes("Carried from") && (
                    <p className="text-xs text-blue-600 flex items-center gap-1">
                      <RefreshCw className="h-2.5 w-2.5" />
                      {doc.notes}
                    </p>
                  )}

                  {/* Deferral details */}
                  {deferred && (
                    <div className={`text-xs space-y-0.5 ${overdue ? "text-orange-800" : "text-amber-800"}`}>
                      <p>
                        <span className="font-medium">Deferred</span>
                        {doc.deferrer && <span> by {doc.deferrer.full_name}</span>}
                        {doc.deferred_at && <span> · {formatDate(doc.deferred_at)}</span>}
                      </p>
                      {doc.deferred_reason && (
                        <p className="italic">&ldquo;{doc.deferred_reason}&rdquo;</p>
                      )}
                      {doc.deferred_until && (
                        <p className={overdue ? "font-semibold text-orange-700" : ""}>
                          Collect by: {formatDate(doc.deferred_until)}
                          {overdue && " — OVERDUE"}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* Upload — pending, rejected, or deferred */}
                  {(doc.status === "pending" || doc.status === "rejected" || doc.status === "deferred") && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs h-7"
                      disabled={uploading === doc.id}
                      onClick={() => { setUploadDocId(doc.id); fileInputRef.current?.click(); }}
                    >
                      {uploading === doc.id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <Upload className="h-3 w-3 mr-1" />}
                      Upload
                    </Button>
                  )}

                  {/* View — when a document file exists */}
                  {doc.document_id && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs h-7"
                      onClick={() => handleViewDoc(doc)}
                    >
                      <Eye className="h-3 w-3 mr-1" />
                      View
                    </Button>
                  )}

                  {/* Approve/Reject — for uploaded docs (any role can trigger review request, but API enforces admin/manager) */}
                  {doc.status === "uploaded" && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-xs h-7 text-green-700 hover:text-green-800 hover:bg-green-50"
                        onClick={() => { setReviewingDoc(doc); setReviewStatus("approved"); }}
                      >
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-xs h-7 text-red-600 hover:text-red-700 hover:bg-red-50"
                        onClick={() => { setReviewingDoc(doc); setReviewStatus("rejected"); setRejectionReason(""); }}
                      >
                        <XCircle className="h-3 w-3 mr-1" />
                        Reject
                      </Button>
                    </>
                  )}

                  {/* ⋮ menu for admin/manager — defer or un-defer */}
                  {canDefer && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0">
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {doc.status !== "deferred" && doc.status !== "approved" && (
                          <>
                            <DropdownMenuItem
                              className="text-amber-700 focus:text-amber-700 focus:bg-amber-50"
                              onClick={() => {
                                setDeferringDoc(doc);
                                setDeferReason("");
                                setDeferUntil("");
                                setDeferAcknowledged(false);
                              }}
                            >
                              <Clock className="h-3.5 w-3.5 mr-2" />
                              Defer requirement
                            </DropdownMenuItem>
                          </>
                        )}
                        {doc.status === "deferred" && (
                          <>
                            <DropdownMenuItem
                              className="text-muted-foreground focus:bg-muted/50"
                              disabled={undeferringId === doc.id}
                              onClick={() => handleUndeferr(doc)}
                            >
                              {undeferringId === doc.id
                                ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                                : <RotateCcw className="h-3.5 w-3.5 mr-2" />}
                              Remove deferral
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => {
                                setDeferringDoc(doc);
                                setDeferReason(doc.deferred_reason || "");
                                setDeferUntil(doc.deferred_until || "");
                                setDeferAcknowledged(false);
                              }}
                            >
                              <Clock className="h-3.5 w-3.5 mr-2" />
                              Edit deferral
                            </DropdownMenuItem>
                          </>
                        )}
                        {doc.status === "uploaded" && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-amber-700 focus:text-amber-700 focus:bg-amber-50"
                              onClick={() => {
                                setDeferringDoc(doc);
                                setDeferReason("");
                                setDeferUntil("");
                                setDeferAcknowledged(false);
                              }}
                            >
                              <Clock className="h-3.5 w-3.5 mr-2" />
                              Defer requirement
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept="image/*,.pdf,.doc,.docx"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file && uploadDocId) handleUpload(uploadDocId, file);
            e.target.value = "";
          }}
        />

        {/* ── Review dialog ── */}
        <Dialog open={!!reviewingDoc} onOpenChange={(v) => { if (!v) setReviewingDoc(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {reviewStatus === "approved" ? "Approve" : "Reject"} Document
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <p className="text-sm">
                {reviewStatus === "approved"
                  ? `Approve "${reviewingDoc?.label}"?`
                  : `Reject "${reviewingDoc?.label}"? Please provide a reason.`}
              </p>
              {reviewStatus === "rejected" && (
                <Textarea
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="Reason for rejection..."
                  rows={3}
                />
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setReviewingDoc(null)}>Cancel</Button>
              <Button
                onClick={handleReview}
                disabled={reviewing}
                className={reviewStatus === "approved"
                  ? "bg-green-600 hover:bg-green-700"
                  : "bg-red-600 hover:bg-red-700"}
              >
                {reviewing && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                {reviewStatus === "approved" ? "Approve" : "Reject"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ── Defer dialog ── */}
        <Dialog
          open={!!deferringDoc}
          onOpenChange={(v) => { if (!v) { setDeferringDoc(null); setDeferAcknowledged(false); } }}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-amber-600" />
                Defer Requirement
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4 mt-1">
              <div className="rounded-md bg-muted/50 border px-3 py-2 text-sm font-medium">
                {deferringDoc?.label}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="defer-reason">
                  Reason <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="defer-reason"
                  rows={3}
                  placeholder="e.g. Original document is with legal, client to provide within 2 weeks"
                  value={deferReason}
                  onChange={(e) => setDeferReason(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="defer-until">Collect by (optional)</Label>
                <Input
                  id="defer-until"
                  type="date"
                  value={deferUntil}
                  onChange={(e) => setDeferUntil(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Setting a deadline enables overdue alerts.
                </p>
              </div>

              <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3">
                <Checkbox
                  id="defer-ack"
                  checked={deferAcknowledged}
                  onCheckedChange={(v) => setDeferAcknowledged(!!v)}
                  className="mt-0.5 border-amber-400"
                />
                <label htmlFor="defer-ack" className="text-xs text-amber-800 cursor-pointer leading-relaxed">
                  I understand this is a <strong>temporary deferral, not a waiver</strong>. This document
                  must still be collected. It will remain visible across all lead interactions
                  until fulfilled.
                </label>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => { setDeferringDoc(null); setDeferAcknowledged(false); }}>
                Cancel
              </Button>
              <Button
                onClick={handleDefer}
                disabled={deferring || !deferReason.trim() || !deferAcknowledged}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {deferring && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                Defer Requirement
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
