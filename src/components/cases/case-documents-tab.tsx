"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Upload,
  FileText,
  CheckCircle,
  XCircle,
  Clock,
  Loader2,
  Eye,
  Ban,
  RotateCcw,
} from "lucide-react";
import { StatusBadge } from "@/components/shared/status-badge";
import { useCaseDocuments } from "@/hooks/use-cases";
import { prepareUpload, UploadTooLargeError } from "@/lib/uploads/upload-gate";
import { toast } from "sonner";

interface CaseDocumentsTabProps {
  caseId: string;
}

export function CaseDocumentsTab({ caseId }: CaseDocumentsTabProps) {
  const { data: documents, loading, refetch } = useCaseDocuments(caseId);
  const [uploading, setUploading] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewDocId, setReviewDocId] = useState<string | null>(null);
  const [reviewAction, setReviewAction] = useState<"approved" | "rejected">("approved");
  const [rejectionReason, setRejectionReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);

  // Waiver state — a permanent decision not to collect a requirement.
  const [waiveDocId, setWaiveDocId] = useState<string | null>(null);
  const [waiveLabel, setWaiveLabel] = useState("");
  const [waiveReason, setWaiveReason] = useState("");
  const [waiving, setWaiving] = useState(false);
  const [unwaiving, setUnwaiving] = useState<string | null>(null);

  const handleWaive = async () => {
    if (!waiveDocId || !waiveReason.trim()) return;
    setWaiving(true);
    const res = await fetch(`/api/cases/${caseId}/documents/${waiveDocId}/waive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: waiveReason.trim() }),
    });
    setWaiving(false);
    if (res.ok) {
      toast.success("Requirement waived — it will no longer be chased");
      setWaiveDocId(null);
      setWaiveReason("");
      refetch();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to waive document");
    }
  };

  const handleUnwaive = async (docId: string) => {
    setUnwaiving(docId);
    const res = await fetch(`/api/cases/${caseId}/documents/${docId}/waive`, { method: "DELETE" });
    setUnwaiving(null);
    if (res.ok) {
      toast.success("Waiver removed — document is now pending");
      refetch();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to remove the waiver");
    }
  };

  const handleView = async (docId: string) => {
    setViewing(docId);
    try {
      const res = await fetch(`/api/cases/${caseId}/documents/${docId}/view`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to get document URL");
      }
      const { url } = await res.json();
      window.open(url, "_blank");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to view document");
    } finally {
      setViewing(null);
    }
  };

  const handleUpload = async (docId: string, raw: File) => {
    setUploading(docId);
    try {
      // Normalize before sending: images → JPEG 2048px, PDFs → stripped.
      const file = await prepareUpload(raw);
      if (!file) return;

      const formData = new FormData();
      formData.append("file", file);
      formData.append("document_id", docId);

      const res = await fetch(`/api/cases/${caseId}/documents`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Upload failed");
      }

      toast.success("Document uploaded successfully");
      refetch();
    } catch (err) {
      if (err instanceof UploadTooLargeError) {
        toast.error(err.message);
      } else {
        toast.error(err instanceof Error ? err.message : "Upload failed");
      }
    } finally {
      setUploading(null);
    }
  };

  const handleReview = async () => {
    if (!reviewDocId) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/documents/${reviewDocId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: reviewAction,
          rejection_reason: reviewAction === "rejected" ? rejectionReason : undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Review failed");
      }

      toast.success(`Document ${reviewAction}`);
      setReviewOpen(false);
      setRejectionReason("");
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Review failed");
    } finally {
      setSubmitting(false);
    }
  };

  const required = documents.filter((d) => d.is_required);
  const optional = documents.filter((d) => !d.is_required);
  const approvedCount = documents.filter((d) => d.status === "approved").length;
  const totalRequired = required.length;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted-foreground">
            {approvedCount}/{totalRequired} required documents approved
          </span>
          <div className="w-32 h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-teal-500 rounded-full transition-all"
              style={{ width: `${totalRequired > 0 ? (approvedCount / totalRequired) * 100 : 0}%` }}
            />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-8 text-muted-foreground">Loading documents...</div>
      ) : documents.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground text-sm">
          No documents required for this case.
        </div>
      ) : (
        <div className="space-y-3">
          {documents.map((doc) => (
            <Card key={doc.id}>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <FileText className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{doc.label}</span>
                        {doc.is_required && (
                          <Badge variant="outline" className="text-xs">Required</Badge>
                        )}
                        <StatusBadge type="case_doc_status" value={doc.status} />
                      </div>
                      {doc.rejection_reason && (
                        <p className="text-xs text-red-500 mt-1">Reason: {doc.rejection_reason}</p>
                      )}
                      {doc.status === "waived" && (
                        <p className="text-xs text-slate-600 mt-1 italic">
                          Will not be collected{doc.waived_reason ? ` — “${doc.waived_reason}”` : ""}
                        </p>
                      )}
                      {(doc.status === "approved" || doc.status === "rejected") && doc.reviewed_at && (
                        <p className={`text-xs mt-1 ${doc.status === "approved" ? "text-green-600" : "text-red-500"}`}>
                          {doc.status === "approved" ? "Approved" : "Rejected"}
                          {doc.reviewer?.full_name && <> by <span className="font-medium">{doc.reviewer.full_name}</span></>}
                          {" on "}
                          {new Date(doc.reviewed_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}
                          {" at "}
                          {new Date(doc.reviewed_at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {/* View button — visible for any doc with an uploaded file */}
                    {doc.document_id && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={viewing === doc.id}
                        onClick={() => handleView(doc.id)}
                      >
                        {viewing === doc.id ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Eye className="mr-2 h-4 w-4" />
                        )}
                        View
                      </Button>
                    )}
                    {(doc.status === "pending" || doc.status === "rejected") && (
                      <>
                        <input
                          type="file"
                          ref={activeDocId === doc.id ? fileInputRef : undefined}
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleUpload(doc.id, file);
                          }}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={uploading === doc.id}
                          onClick={() => {
                            setActiveDocId(doc.id);
                            setTimeout(() => fileInputRef.current?.click(), 0);
                          }}
                        >
                          {uploading === doc.id ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Upload className="mr-2 h-4 w-4" />
                          )}
                          Upload
                        </Button>
                      </>
                    )}
                    {doc.is_required && doc.status !== "approved" && doc.status !== "waived" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-slate-600"
                        onClick={() => {
                          setWaiveDocId(doc.id);
                          setWaiveLabel(doc.label);
                          setWaiveReason("");
                        }}
                      >
                        <Ban className="mr-1 h-4 w-4" />
                        Waive
                      </Button>
                    )}
                    {doc.status === "waived" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground"
                        disabled={unwaiving === doc.id}
                        onClick={() => handleUnwaive(doc.id)}
                      >
                        {unwaiving === doc.id
                          ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                          : <RotateCcw className="mr-1 h-4 w-4" />}
                        Remove waiver
                      </Button>
                    )}
                    {doc.status === "uploaded" && (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-green-600"
                          onClick={() => {
                            setReviewDocId(doc.id);
                            setReviewAction("approved");
                            setReviewOpen(true);
                          }}
                        >
                          <CheckCircle className="mr-1 h-4 w-4" />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-red-600"
                          onClick={() => {
                            setReviewDocId(doc.id);
                            setReviewAction("rejected");
                            setReviewOpen(true);
                          }}
                        >
                          <XCircle className="mr-1 h-4 w-4" />
                          Reject
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Waive Dialog */}
      <Dialog open={!!waiveDocId} onOpenChange={(v) => { if (!v) setWaiveDocId(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Ban className="h-4 w-4 text-slate-600" />
              Waive Requirement
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md bg-muted/50 border px-3 py-2 text-sm font-medium">
              {waiveLabel}
            </div>
            <Textarea
              rows={3}
              value={waiveReason}
              onChange={(e) => setWaiveReason(e.target.value)}
              placeholder="e.g. Proprietorship — no MOA/AOA exists for this entity type"
            />
            <p className="text-xs text-muted-foreground">
              A waiver has no expiry date. This document will never be collected and drops out of
              the weekly KYC reminders permanently.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWaiveDocId(null)}>Cancel</Button>
            <Button
              onClick={handleWaive}
              disabled={waiving || !waiveReason.trim()}
              className="bg-slate-700 hover:bg-slate-800 text-white"
            >
              {waiving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Waive Requirement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Review Dialog */}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewAction === "approved" ? "Approve Document" : "Reject Document"}
            </DialogTitle>
          </DialogHeader>
          {reviewAction === "rejected" && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Rejection Reason</label>
              <Textarea
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                placeholder="Please specify why this document is being rejected..."
                rows={3}
              />
            </div>
          )}
          {reviewAction === "approved" && (
            <p className="text-sm text-muted-foreground">
              Are you sure you want to approve this document?
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleReview}
              disabled={submitting}
              variant={reviewAction === "rejected" ? "destructive" : "default"}
            >
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {reviewAction === "approved" ? "Approve" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
