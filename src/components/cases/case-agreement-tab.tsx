"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/shared/status-badge";
import {
  FileText,
  Send,
  CheckCircle,
  PenTool,
  Loader2,
  ExternalLink,
  Eye,
  Pencil,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";
import type { CaseAgreement } from "@/types";

interface CaseAgreementTabProps {
  caseId: string;
}

export function CaseAgreementTab({ caseId }: CaseAgreementTabProps) {
  const [agreement, setAgreement] = useState<CaseAgreement | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [acting, setActing] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editVars, setEditVars] = useState<Record<string, string>>({});

  const fetchAgreement = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/agreement`);
      if (res.ok) {
        const json = await res.json();
        setAgreement(json.data || null);
        setPdfUrl(json.pdf_url || null);
      } else {
        setAgreement(null);
        setPdfUrl(null);
      }
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    fetchAgreement();
  }, [fetchAgreement]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/agreement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to generate agreement");
      }
      toast.success("Agreement generated");
      fetchAgreement();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  };

  const handleViewPdf = async () => {
    if (pdfUrl) {
      window.open(pdfUrl, "_blank");
      return;
    }
    // Fallback: fetch fresh signed URL
    setViewing(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/agreement`);
      if (res.ok) {
        const json = await res.json();
        if (json.pdf_url) {
          window.open(json.pdf_url, "_blank");
          setPdfUrl(json.pdf_url);
        } else {
          toast.error("No PDF available for this agreement");
        }
      }
    } finally {
      setViewing(false);
    }
  };

  const openEditDialog = () => {
    if (!agreement?.variables) return;
    const vars = agreement.variables as Record<string, unknown>;
    setEditVars({
      client_name: String(vars.client_name || ""),
      client_company_name: String(vars.client_company_name || ""),
      client_address: String(vars.client_address || ""),
      client_gst_number: String(vars.client_gst_number || ""),
      client_pan_number: String(vars.client_pan_number || ""),
      client_cin_number: String(vars.client_cin_number || ""),
      client_email: String(vars.client_email || ""),
      client_phone: String(vars.client_phone || ""),
      rate: String(vars.rate || ""),
      tenure_months: String(vars.tenure_months || ""),
      security_deposit: String(vars.security_deposit || ""),
      start_date: String(vars.start_date || ""),
    });
    setEditOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!agreement) return;
    setSaving(true);
    try {
      // Build the updated variables — compute formatted values
      const rate = Number(editVars.rate) || 0;
      const securityDeposit = Number(editVars.security_deposit) || 0;
      const tenureMonths = Number(editVars.tenure_months) || 12;
      const startDate = editVars.start_date || new Date().toISOString();

      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + tenureMonths);

      const formatCurrency = (amt: number) =>
        "Rs. " +
        new Intl.NumberFormat("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amt);

      const formatDateStr = (d: string | Date) =>
        new Date(d).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });

      const updatedVars: Record<string, unknown> = {
        client_name: editVars.client_name,
        client_company_name: editVars.client_company_name,
        client_address: editVars.client_address,
        client_gst_number: editVars.client_gst_number,
        client_pan_number: editVars.client_pan_number,
        client_cin_number: editVars.client_cin_number,
        client_email: editVars.client_email,
        client_phone: editVars.client_phone,
        rate,
        rate_formatted: formatCurrency(rate),
        tenure_months: tenureMonths,
        security_deposit: securityDeposit,
        security_deposit_formatted: formatCurrency(securityDeposit),
        start_date: startDate,
        start_date_formatted: formatDateStr(startDate),
        end_date: endDate.toISOString(),
        end_date_formatted: formatDateStr(endDate),
        agreement_date: formatDateStr(new Date()),
      };

      const res = await fetch(`/api/cases/${caseId}/agreement`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agreement_id: agreement.id, variables: updatedVars }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to update agreement");
      }
      toast.success("Agreement updated and PDF regenerated");
      setEditOpen(false);
      fetchAgreement();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSaving(false);
    }
  };

  const handleRegenerate = async () => {
    if (!agreement) return;
    setGenerating(true);
    try {
      // Delete old agreement and create fresh one from case data
      const res = await fetch(`/api/cases/${caseId}/agreement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to regenerate agreement");
      }
      toast.success("Agreement regenerated from case data");
      fetchAgreement();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Regeneration failed");
    } finally {
      setGenerating(false);
    }
  };

  const handleAction = async (action: string) => {
    if (!agreement) return;
    setActing(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/agreement`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, agreement_id: agreement.id }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Action failed");
      }
      toast.success(`Agreement ${action.replace(/_/g, " ")}`);
      fetchAgreement();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActing(false);
    }
  };

  const handleInitiateSigning = async () => {
    setActing(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/agreement/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "initiate" }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to initiate signing");
      }
      toast.success("E-signing initiated via Digio");
      fetchAgreement();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Signing initiation failed");
    } finally {
      setActing(false);
    }
  };

  const isEditable = agreement?.status === "draft" || agreement?.status === "internally_approved";

  if (loading) {
    return <div className="text-center py-8 text-muted-foreground">Loading agreement...</div>;
  }

  if (!agreement) {
    return (
      <div className="text-center py-12">
        <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
        <h3 className="text-lg font-semibold mb-2">No Agreement Generated</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Generate an agreement from the case details to proceed.
        </p>
        <Button onClick={handleGenerate} disabled={generating}>
          {generating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Generate Agreement
        </Button>
      </div>
    );
  }

  const vars = (agreement.variables || {}) as Record<string, unknown>;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-5 w-5" />
              {agreement.agreement_number || "Agreement"}
            </CardTitle>
            <StatusBadge type="agreement_status" value={agreement.status} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Agreement Info Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground block">Template</span>
              <span className="capitalize">{agreement.template_key?.replace(/vo_/, "").replace(/_/g, " ")}</span>
            </div>
            <div>
              <span className="text-muted-foreground block">Created</span>
              <span>{formatDate(agreement.created_at)}</span>
            </div>
            {agreement.valid_from && (
              <div>
                <span className="text-muted-foreground block">Valid From</span>
                <span>{formatDate(agreement.valid_from)}</span>
              </div>
            )}
            {agreement.signed_at && (
              <div>
                <span className="text-muted-foreground block">Signed</span>
                <span>{formatDate(agreement.signed_at)}</span>
              </div>
            )}
          </div>

          {/* Key Agreement Details */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm bg-muted/50 rounded-lg p-3">
            <div>
              <span className="text-muted-foreground block text-xs">Client</span>
              <span className="font-medium">{String(vars.client_name || "—")}</span>
            </div>
            {vars.client_company_name ? (
              <div>
                <span className="text-muted-foreground block text-xs">Company</span>
                <span className="font-medium">{String(vars.client_company_name)}</span>
              </div>
            ) : null}
            <div>
              <span className="text-muted-foreground block text-xs">Rate</span>
              <span className="font-medium">{String(vars.rate_formatted || vars.rate || "—")}</span>
            </div>
            <div>
              <span className="text-muted-foreground block text-xs">Tenure</span>
              <span className="font-medium">{String(vars.tenure_months || "—")} months</span>
            </div>
            <div>
              <span className="text-muted-foreground block text-xs">Security Deposit</span>
              <span className="font-medium">{String(vars.security_deposit_formatted || vars.security_deposit || "—")}</span>
            </div>
            {vars.start_date_formatted ? (
              <div>
                <span className="text-muted-foreground block text-xs">Start Date</span>
                <span className="font-medium">{String(vars.start_date_formatted)}</span>
              </div>
            ) : null}
          </div>

          {/* View / Edit / Regenerate Buttons */}
          <div className="flex flex-wrap gap-2 pt-2 border-t">
            {/* View PDF — always available when agreement exists */}
            <Button
              size="sm"
              variant="outline"
              onClick={handleViewPdf}
              disabled={viewing}
            >
              {viewing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Eye className="mr-2 h-4 w-4" />
              )}
              View PDF
            </Button>

            {/* Edit — only in draft / internally_approved */}
            {isEditable && (
              <Button
                size="sm"
                variant="outline"
                onClick={openEditDialog}
              >
                <Pencil className="mr-2 h-4 w-4" />
                Edit Agreement
              </Button>
            )}

            {/* Regenerate — only in draft / internally_approved */}
            {isEditable && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleRegenerate}
                disabled={generating}
              >
                {generating ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Regenerate
              </Button>
            )}
          </div>

          {/* Status Workflow Buttons */}
          <div className="flex flex-wrap gap-2 pt-2 border-t">
            {agreement.status === "draft" && (
              <Button
                size="sm"
                onClick={() => handleAction("approve_internally")}
                disabled={acting}
              >
                <CheckCircle className="mr-2 h-4 w-4" />
                Approve Internally
              </Button>
            )}

            {agreement.status === "internally_approved" && (
              <Button
                size="sm"
                onClick={() => handleAction("send_to_client")}
                disabled={acting}
              >
                <Send className="mr-2 h-4 w-4" />
                Send to Client
              </Button>
            )}

            {agreement.status === "sent_to_client" && (
              <Button
                size="sm"
                onClick={() => handleAction("client_approved")}
                disabled={acting}
              >
                <CheckCircle className="mr-2 h-4 w-4" />
                Mark Client Approved
              </Button>
            )}

            {agreement.status === "client_approved" && (
              <Button
                size="sm"
                onClick={handleInitiateSigning}
                disabled={acting}
              >
                <PenTool className="mr-2 h-4 w-4" />
                Initiate E-Signing
              </Button>
            )}

            {agreement.digio_sign_url && agreement.status === "signing" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => window.open(agreement.digio_sign_url!, "_blank")}
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Signing Link
              </Button>
            )}

            {acting && <Loader2 className="h-4 w-4 animate-spin ml-2" />}
          </div>
        </CardContent>
      </Card>

      {/* Edit Agreement Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Agreement Details</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="edit-client-name">Client Name</Label>
              <Input
                id="edit-client-name"
                value={editVars.client_name}
                onChange={(e) => setEditVars((v) => ({ ...v, client_name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-company">Company Name</Label>
              <Input
                id="edit-company"
                value={editVars.client_company_name}
                onChange={(e) => setEditVars((v) => ({ ...v, client_company_name: e.target.value }))}
              />
            </div>
            <div className="sm:col-span-2 space-y-1.5">
              <Label htmlFor="edit-address">Client Address</Label>
              <Input
                id="edit-address"
                value={editVars.client_address}
                onChange={(e) => setEditVars((v) => ({ ...v, client_address: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-email">Client Email</Label>
              <Input
                id="edit-email"
                type="email"
                value={editVars.client_email}
                onChange={(e) => setEditVars((v) => ({ ...v, client_email: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-phone">Client Phone</Label>
              <Input
                id="edit-phone"
                value={editVars.client_phone}
                onChange={(e) => setEditVars((v) => ({ ...v, client_phone: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-gst">GST Number</Label>
              <Input
                id="edit-gst"
                value={editVars.client_gst_number}
                onChange={(e) => setEditVars((v) => ({ ...v, client_gst_number: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-pan">PAN Number</Label>
              <Input
                id="edit-pan"
                value={editVars.client_pan_number}
                onChange={(e) => setEditVars((v) => ({ ...v, client_pan_number: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-cin">CIN/LLPIN</Label>
              <Input
                id="edit-cin"
                value={editVars.client_cin_number}
                onChange={(e) => setEditVars((v) => ({ ...v, client_cin_number: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-rate">Monthly Rate (Rs.)</Label>
              <Input
                id="edit-rate"
                type="number"
                value={editVars.rate}
                onChange={(e) => setEditVars((v) => ({ ...v, rate: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-tenure">Tenure (months)</Label>
              <Input
                id="edit-tenure"
                type="number"
                value={editVars.tenure_months}
                onChange={(e) => setEditVars((v) => ({ ...v, tenure_months: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-deposit">Security Deposit (Rs.)</Label>
              <Input
                id="edit-deposit"
                type="number"
                value={editVars.security_deposit}
                onChange={(e) => setEditVars((v) => ({ ...v, security_deposit: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-start">Start Date</Label>
              <Input
                id="edit-start"
                type="date"
                value={editVars.start_date ? editVars.start_date.split("T")[0] : ""}
                onChange={(e) => setEditVars((v) => ({ ...v, start_date: e.target.value }))}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Saving will regenerate the agreement PDF with updated details and reset the status to Draft.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save & Regenerate PDF
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
