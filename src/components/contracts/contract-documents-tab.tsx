"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Upload, CheckCircle2, XCircle, Eye, Loader2, FileText, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import type { ContractDocument } from "@/types";

interface ContractDocumentsTabProps {
  contractId: string;
  onKycStatusChange?: (allApproved: boolean, total: number, approved: number) => void;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  uploaded: "bg-blue-100 text-blue-700",
  approved: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
};

export function ContractDocumentsTab({ contractId, onKycStatusChange }: ContractDocumentsTabProps) {
  const [docs, setDocs] = useState<ContractDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<string | null>(null);
  const [reviewingDoc, setReviewingDoc] = useState<ContractDocument | null>(null);
  const [reviewStatus, setReviewStatus] = useState<"approved" | "rejected">("approved");
  const [rejectionReason, setRejectionReason] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadDocId, setUploadDocId] = useState<string | null>(null);

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/contracts/${contractId}/documents`);
    if (res.ok) {
      const json = await res.json();
      const data = json.data || [];
      setDocs(data);

      // If no docs exist, initialize from KYC_DOCUMENTS
      if (data.length === 0) {
        const initRes = await fetch(`/api/contracts/${contractId}/documents/init`, { method: "POST" });
        if (initRes.ok) {
          // Refetch after initialization
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

  // Report KYC status to parent
  useEffect(() => {
    if (onKycStatusChange && docs.length > 0) {
      const required = docs.filter(d => d.is_required);
      const approved = required.filter(d => d.status === "approved");
      onKycStatusChange(approved.length >= required.length, required.length, approved.length);
    }
  }, [docs, onKycStatusChange]);

  const handleUpload = async (docId: string, file: File) => {
    setUploading(docId);
    try {
      // Step 1: get a signed upload URL (bypasses Vercel 4.5MB body limit)
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
      const { signedUrl, path: filePath } = await urlRes.json();

      // Step 2: upload directly to Supabase Storage
      const uploadRes = await fetch(signedUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!uploadRes.ok) throw new Error("Storage upload failed");

      // Step 3: register document + link to KYC slot via API
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
      toast.error(e instanceof Error ? e.message : "Upload failed");
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
  const totalRequired = requiredDocs.length;
  const allApproved = totalRequired > 0 && approvedCount >= totalRequired;

  if (loading) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">KYC Documents</CardTitle></CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-3">{[1, 2, 3].map(i => <div key={i} className="h-12 rounded bg-muted" />)}</div>
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

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4" />
          KYC Documents
          <Badge variant="secondary" className={allApproved ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}>
            {approvedCount} / {totalRequired}
          </Badge>
        </CardTitle>
        {!allApproved && (
          <div className="flex items-center gap-1 text-xs text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5" />
            Incomplete
          </div>
        )}
      </CardHeader>
      <CardContent>
        {/* Progress bar */}
        <div className="w-full bg-gray-200 rounded-full h-1.5 mb-4">
          <div
            className={`h-1.5 rounded-full transition-all ${allApproved ? "bg-green-500" : "bg-amber-500"}`}
            style={{ width: `${totalRequired > 0 ? (approvedCount / totalRequired) * 100 : 0}%` }}
          />
        </div>

        <div className="space-y-2">
          {docs.map((doc) => (
            <div key={doc.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{doc.label}</span>
                  {doc.is_required && <Badge variant="outline" className="text-[10px] px-1">Required</Badge>}
                </div>
                {doc.status === "rejected" && doc.rejection_reason && (
                  <p className="text-xs text-red-600 mt-1">Rejected: {doc.rejection_reason}</p>
                )}
                {doc.status === "approved" && doc.reviewer && (
                  <p className="text-xs text-green-600 mt-1">Approved by {doc.reviewer.full_name}</p>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <Badge variant="secondary" className={STATUS_COLORS[doc.status] || ""}>
                  {doc.status}
                </Badge>

                {/* Upload button — for pending or rejected */}
                {(doc.status === "pending" || doc.status === "rejected") && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs h-7"
                    disabled={uploading === doc.id}
                    onClick={() => { setUploadDocId(doc.id); fileInputRef.current?.click(); }}
                  >
                    {uploading === doc.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3 mr-1" />}
                    Upload
                  </Button>
                )}

                {/* View button — when document exists */}
                {doc.document_id && (
                  <Button size="sm" variant="ghost" className="text-xs h-7" onClick={() => handleViewDoc(doc)}>
                    <Eye className="h-3 w-3 mr-1" />View
                  </Button>
                )}

                {/* Approve/Reject — for uploaded docs */}
                {doc.status === "uploaded" && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs h-7 text-green-700 hover:text-green-800 hover:bg-green-50"
                      onClick={() => { setReviewingDoc(doc); setReviewStatus("approved"); }}
                    >
                      <CheckCircle2 className="h-3 w-3 mr-1" />Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs h-7 text-red-600 hover:text-red-700 hover:bg-red-50"
                      onClick={() => { setReviewingDoc(doc); setReviewStatus("rejected"); setRejectionReason(""); }}
                    >
                      <XCircle className="h-3 w-3 mr-1" />Reject
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
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

        {/* Review dialog */}
        <Dialog open={!!reviewingDoc} onOpenChange={(v) => { if (!v) setReviewingDoc(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{reviewStatus === "approved" ? "Approve" : "Reject"} Document</DialogTitle>
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
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setReviewingDoc(null)}>Cancel</Button>
                <Button
                  onClick={handleReview}
                  disabled={reviewing}
                  className={reviewStatus === "approved" ? "bg-green-600 hover:bg-green-700" : "bg-red-600 hover:bg-red-700"}
                >
                  {reviewing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                  {reviewStatus === "approved" ? "Approve" : "Reject"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
