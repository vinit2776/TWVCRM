"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  Download,
  Upload,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Activity,
} from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";
import type { CaseAgreement } from "@/types";

interface LeegalityHealth {
  environment: string;
  baseUrl: string;
  envCheck: Record<string, boolean>;
  allEnvSet: boolean;
  apiReachable: boolean;
  apiStatusCode: number | null;
  apiError: string | null;
  healthy: boolean;
}

interface CaseLeaveAgreementTabProps {
  caseId: string;
}

export function CaseLeaveAgreementTab({ caseId }: CaseLeaveAgreementTabProps) {
  const [agreement, setAgreement] = useState<CaseAgreement | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [acting, setActing] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editVars, setEditVars] = useState<Record<string, string>>({});
  const [health, setHealth] = useState<LeegalityHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchAgreement = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/leave-license`);
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
      const res = await fetch(`/api/cases/${caseId}/leave-license`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to generate agreement");
      }
      toast.success("Leave & License Agreement generated");
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
    setViewing(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/leave-license`);
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
      nature_of_business: String(vars.nature_of_business || ""),
      lessee_signatory_name: String(vars.lessee_signatory_name || ""),
      lessee_signatory_designation: String(vars.lessee_signatory_designation || ""),
      witness_1_name: String(vars.witness_1_name || ""),
      witness_1_aadhaar_last4: String(vars.witness_1_aadhaar_last4 || ""),
      witness_1_mobile: String(vars.witness_1_mobile || ""),
      witness_2_name: String(vars.witness_2_name || ""),
      witness_2_aadhaar_last4: String(vars.witness_2_aadhaar_last4 || ""),
      witness_2_mobile: String(vars.witness_2_mobile || ""),
      estamp_value: String(vars.estamp_value || ""),
    });
    setEditOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!agreement) return;
    setSaving(true);
    try {
      const rate = Number(editVars.rate) || 0;
      const securityDeposit = Number(editVars.security_deposit) || 0;
      const tenureMonths = Number(editVars.tenure_months) || 12;
      const startDate = editVars.start_date || new Date().toISOString();

      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + tenureMonths);

      const fmtCurrency = (amt: number) =>
        "Rs. " +
        new Intl.NumberFormat("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amt);

      const fmtDate = (d: string | Date) =>
        new Date(d).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "long", day: "numeric" });

      const estampValue = Number(editVars.estamp_value) || 0;

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
        rate_formatted: fmtCurrency(rate),
        tenure_months: tenureMonths,
        security_deposit: securityDeposit,
        security_deposit_formatted: fmtCurrency(securityDeposit),
        start_date: startDate,
        start_date_formatted: fmtDate(startDate),
        end_date: endDate.toISOString(),
        end_date_formatted: fmtDate(endDate),
        agreement_date: fmtDate(new Date()),
        nature_of_business: editVars.nature_of_business,
        lessee_signatory_name: editVars.lessee_signatory_name,
        lessee_signatory_designation: editVars.lessee_signatory_designation,
        witness_1_name: editVars.witness_1_name,
        witness_1_aadhaar_last4: editVars.witness_1_aadhaar_last4,
        witness_1_mobile: editVars.witness_1_mobile,
        witness_2_name: editVars.witness_2_name,
        witness_2_aadhaar_last4: editVars.witness_2_aadhaar_last4,
        witness_2_mobile: editVars.witness_2_mobile,
        estamp_value: estampValue,
        estamp_value_formatted: estampValue ? fmtCurrency(estampValue) : undefined,
      };

      const res = await fetch(`/api/cases/${caseId}/leave-license`, {
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
      const res = await fetch(`/api/cases/${caseId}/leave-license`, {
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
      const res = await fetch(`/api/cases/${caseId}/leave-license`, {
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
      const res = await fetch(`/api/cases/${caseId}/leave-license/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "initiate", agreement_id: agreement?.id }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to initiate e-stamping & signing");
      }
      toast.success("E-stamping & signing initiated via Leegality");
      fetchAgreement();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Signing initiation failed");
    } finally {
      setActing(false);
    }
  };

  const checkLeegalityHealth = async () => {
    setHealthLoading(true);
    try {
      const res = await fetch("/api/cases/leegality-health");
      if (res.ok) {
        const json = await res.json();
        setHealth(json);
      } else {
        toast.error("Failed to check Leegality health");
      }
    } catch {
      toast.error("Network error checking Leegality");
    } finally {
      setHealthLoading(false);
    }
  };

  const REQUIRED_VARS: Array<{ key: string; label: string }> = [
    { key: "client_name", label: "Client Name" },
    { key: "client_address", label: "Client Address" },
    { key: "lessee_signatory_name", label: "Lessee Signatory Name" },
    { key: "nature_of_business", label: "Nature of Business" },
    { key: "rate", label: "Monthly Rate" },
    { key: "start_date", label: "Start Date" },
    { key: "tenure_months", label: "Tenure (months)" },
  ];

  const getMissingVars = () => {
    if (!agreement?.variables) return REQUIRED_VARS.map((v) => v.label);
    const vars = agreement.variables as Record<string, unknown>;
    return REQUIRED_VARS.filter(({ key }) => {
      const val = vars[key];
      if (val === null || val === undefined || val === "") return true;
      if (key === "client_address" && String(val) === "To be provided") return true;
      if ((key === "rate" || key === "tenure_months") && Number(val) <= 0) return true;
      return false;
    }).map((v) => v.label);
  };

  const handleDownloadForStampPaper = async () => {
    const missing = getMissingVars();
    if (missing.length > 0) {
      toast.error(`Fill in required fields before downloading: ${missing.join(", ")}`, {
        duration: 6000,
      });
      return;
    }

    // Re-fetch a fresh signed URL
    setViewing(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/leave-license`);
      const json = await res.json();
      const url = json.pdf_url;
      if (!url) {
        toast.error("PDF not found — regenerate the agreement first");
        return;
      }
      // Trigger browser download
      const a = document.createElement("a");
      a.href = url;
      a.download = `leave-license-${caseId}.pdf`;
      a.rel = "noopener";
      a.click();
    } catch {
      toast.error("Download failed");
    } finally {
      setViewing(false);
    }
  };

  const handleUploadSignedDocument = async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      toast.error("Please select a PDF file");
      return;
    }
    if (!agreement) return;

    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("agreement_id", agreement.id);

      const res = await fetch(`/api/cases/${caseId}/leave-license/manual-sign`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Upload failed");
      }
      toast.success("Signed agreement uploaded — agreement marked as Executed");
      setUploadOpen(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      fetchAgreement();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
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
        <h3 className="text-lg font-semibold mb-2">No Leave & License Agreement</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Generate a Leave & License agreement from the case details.
        </p>
        <Button onClick={handleGenerate} disabled={generating}>
          {generating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Generate Agreement
        </Button>
      </div>
    );
  }

  const vars = (agreement.variables || {}) as Record<string, unknown>;

  const canUploadManualSign = agreement &&
    ["client_approved", "signing", "internally_approved", "draft"].includes(agreement.status) &&
    agreement.status !== "executed";

  return (
    <div className="space-y-4">
      {/* Leegality Health Card */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium">
              <Activity className="h-4 w-4" />
              Leegality Integration Health
            </CardTitle>
            <Button size="sm" variant="ghost" onClick={checkLeegalityHealth} disabled={healthLoading}>
              {healthLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              <span className="ml-1.5 text-xs">Check</span>
            </Button>
          </div>
        </CardHeader>
        {health && (
          <CardContent className="pt-0">
            <div className={`rounded-md p-3 text-sm ${health.healthy ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-800"}`}>
              <div className="flex items-center gap-2 font-medium mb-2">
                {health.healthy
                  ? <CheckCircle2 className="h-4 w-4 text-green-600" />
                  : <AlertTriangle className="h-4 w-4 text-amber-600" />}
                {health.healthy ? "Leegality is connected and working" : "Leegality configuration issues found"}
                <span className="ml-auto text-xs font-normal opacity-70">{health.environment} · {health.baseUrl}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {Object.entries(health.envCheck).map(([key, ok]) => (
                  <div key={key} className="flex items-center gap-1.5 text-xs">
                    {ok ? <CheckCircle2 className="h-3 w-3 text-green-600 shrink-0" /> : <XCircle className="h-3 w-3 text-red-500 shrink-0" />}
                    <span className={ok ? "" : "text-red-600 font-medium"}>{key.replace("LEEGALITY_", "")}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-1.5 text-xs mt-2">
                {health.apiReachable
                  ? <CheckCircle2 className="h-3 w-3 text-green-600 shrink-0" />
                  : <XCircle className="h-3 w-3 text-red-500 shrink-0" />}
                <span className={health.apiReachable ? "" : "text-red-600 font-medium"}>
                  API reachable
                  {health.apiStatusCode ? ` (HTTP ${health.apiStatusCode})` : ""}
                  {health.apiError ? ` — ${health.apiError}` : ""}
                </span>
              </div>
            </div>
          </CardContent>
        )}
        {!health && !healthLoading && (
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground">Click Check to verify Leegality env vars and API connectivity.</p>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Leave & License Agreement
            </CardTitle>
            <StatusBadge type="agreement_status" value={agreement.status} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Agreement Info Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground block">Type</span>
              <span>Leave & License</span>
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

          {/* Key Details */}
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
              <span className="text-muted-foreground block text-xs">Nature of Business</span>
              <span className="font-medium">{String(vars.nature_of_business || "—")}</span>
            </div>
            {vars.estamp_value ? (
              <div>
                <span className="text-muted-foreground block text-xs">E-Stamp Value</span>
                <span className="font-medium">{String(vars.estamp_value_formatted || vars.estamp_value)}</span>
              </div>
            ) : null}
          </div>

          {/* Leegality Info */}
          {agreement.leegality_document_id && (
            <div className="text-sm bg-blue-50 rounded-lg p-3 space-y-1">
              <span className="font-medium text-blue-800">Leegality E-Stamp & E-Sign</span>
              <div className="text-blue-700">
                Document ID: {agreement.leegality_document_id}
                {agreement.leegality_status && ` | Status: ${agreement.leegality_status}`}
                {agreement.leegality_estamp_value && ` | Stamp: Rs. ${agreement.leegality_estamp_value}`}
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-2 pt-2 border-t">
            <Button size="sm" variant="outline" onClick={handleViewPdf} disabled={viewing}>
              {viewing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
              View PDF
            </Button>

            <Button size="sm" variant="outline" onClick={handleDownloadForStampPaper} disabled={viewing}>
              {viewing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
              Download for Stamp Paper
            </Button>

            {isEditable && (
              <Button size="sm" variant="outline" onClick={openEditDialog}>
                <Pencil className="mr-2 h-4 w-4" />
                Edit Agreement
              </Button>
            )}

            {isEditable && (
              <Button size="sm" variant="outline" onClick={handleRegenerate} disabled={generating}>
                {generating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Regenerate
              </Button>
            )}
          </div>

          {/* Status Workflow Buttons */}
          <div className="flex flex-wrap gap-2 pt-2 border-t">
            {agreement.status === "draft" && (
              <Button size="sm" onClick={() => handleAction("approve_internally")} disabled={acting}>
                <CheckCircle className="mr-2 h-4 w-4" />
                Approve Internally
              </Button>
            )}

            {agreement.status === "internally_approved" && (
              <Button size="sm" onClick={() => handleAction("send_to_client")} disabled={acting}>
                <Send className="mr-2 h-4 w-4" />
                Send to Client
              </Button>
            )}

            {agreement.status === "sent_to_client" && (
              <Button size="sm" onClick={() => handleAction("client_approved")} disabled={acting}>
                <CheckCircle className="mr-2 h-4 w-4" />
                Mark Client Approved
              </Button>
            )}

            {agreement.status === "client_approved" && (
              <Button size="sm" onClick={handleInitiateSigning} disabled={acting}>
                <PenTool className="mr-2 h-4 w-4" />
                Initiate E-Stamping & Signing
              </Button>
            )}

            {agreement.leegality_sign_url && agreement.status === "signing" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => window.open(agreement.leegality_sign_url!, "_blank")}
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Signing Link
              </Button>
            )}

            {canUploadManualSign && (
              <Button size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
                <Upload className="mr-2 h-4 w-4" />
                Upload Signed Document
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
            <DialogTitle>Edit Leave & License Agreement</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ll-client-name">Client Name</Label>
              <Input id="ll-client-name" value={editVars.client_name} onChange={(e) => setEditVars((v) => ({ ...v, client_name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-company">Company Name</Label>
              <Input id="ll-company" value={editVars.client_company_name} onChange={(e) => setEditVars((v) => ({ ...v, client_company_name: e.target.value }))} />
            </div>
            <div className="sm:col-span-2 space-y-1.5">
              <Label htmlFor="ll-address">Client Address</Label>
              <Input id="ll-address" value={editVars.client_address} onChange={(e) => setEditVars((v) => ({ ...v, client_address: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-email">Client Email</Label>
              <Input id="ll-email" type="email" value={editVars.client_email} onChange={(e) => setEditVars((v) => ({ ...v, client_email: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-phone">Client Phone</Label>
              <Input id="ll-phone" value={editVars.client_phone} onChange={(e) => setEditVars((v) => ({ ...v, client_phone: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-gst">GST Number</Label>
              <Input id="ll-gst" value={editVars.client_gst_number} onChange={(e) => setEditVars((v) => ({ ...v, client_gst_number: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-pan">PAN Number</Label>
              <Input id="ll-pan" value={editVars.client_pan_number} onChange={(e) => setEditVars((v) => ({ ...v, client_pan_number: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-cin">CIN/LLPIN</Label>
              <Input id="ll-cin" value={editVars.client_cin_number} onChange={(e) => setEditVars((v) => ({ ...v, client_cin_number: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-rate">Monthly Rate (Rs.)</Label>
              <Input id="ll-rate" type="number" value={editVars.rate} onChange={(e) => setEditVars((v) => ({ ...v, rate: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-tenure">Tenure (months)</Label>
              <Input id="ll-tenure" type="number" value={editVars.tenure_months} onChange={(e) => setEditVars((v) => ({ ...v, tenure_months: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-deposit">Security Deposit (Rs.)</Label>
              <Input id="ll-deposit" type="number" value={editVars.security_deposit} onChange={(e) => setEditVars((v) => ({ ...v, security_deposit: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-start">Start Date</Label>
              <Input id="ll-start" type="date" value={editVars.start_date ? editVars.start_date.split("T")[0] : ""} onChange={(e) => setEditVars((v) => ({ ...v, start_date: e.target.value }))} />
            </div>

            {/* L&L Specific Fields */}
            <div className="sm:col-span-2 space-y-1.5">
              <Label htmlFor="ll-nature">Nature of Business</Label>
              <Textarea id="ll-nature" value={editVars.nature_of_business} onChange={(e) => setEditVars((v) => ({ ...v, nature_of_business: e.target.value }))} rows={2} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-signatory-name">Lessee Signatory Name</Label>
              <Input id="ll-signatory-name" value={editVars.lessee_signatory_name} onChange={(e) => setEditVars((v) => ({ ...v, lessee_signatory_name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-signatory-desig">Lessee Signatory Designation</Label>
              <Input id="ll-signatory-desig" value={editVars.lessee_signatory_designation} onChange={(e) => setEditVars((v) => ({ ...v, lessee_signatory_designation: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-estamp">E-Stamp Value (Rs.)</Label>
              <Input id="ll-estamp" type="number" value={editVars.estamp_value} onChange={(e) => setEditVars((v) => ({ ...v, estamp_value: e.target.value }))} />
            </div>

            {/* Witnesses */}
            <div className="sm:col-span-2 mt-2">
              <h4 className="text-sm font-medium mb-2">Witnesses</h4>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-w1-name">Witness 1 Name</Label>
              <Input id="ll-w1-name" value={editVars.witness_1_name} onChange={(e) => setEditVars((v) => ({ ...v, witness_1_name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-w1-aadhaar">Witness 1 Aadhaar (last 4)</Label>
              <Input id="ll-w1-aadhaar" maxLength={4} value={editVars.witness_1_aadhaar_last4} onChange={(e) => setEditVars((v) => ({ ...v, witness_1_aadhaar_last4: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-w1-mobile">Witness 1 Aadhaar Linked Mobile</Label>
              <Input id="ll-w1-mobile" maxLength={10} value={editVars.witness_1_mobile} onChange={(e) => setEditVars((v) => ({ ...v, witness_1_mobile: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-w2-name">Witness 2 Name</Label>
              <Input id="ll-w2-name" value={editVars.witness_2_name} onChange={(e) => setEditVars((v) => ({ ...v, witness_2_name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-w2-aadhaar">Witness 2 Aadhaar (last 4)</Label>
              <Input id="ll-w2-aadhaar" maxLength={4} value={editVars.witness_2_aadhaar_last4} onChange={(e) => setEditVars((v) => ({ ...v, witness_2_aadhaar_last4: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ll-w2-mobile">Witness 2 Aadhaar Linked Mobile</Label>
              <Input id="ll-w2-mobile" maxLength={10} value={editVars.witness_2_mobile} onChange={(e) => setEditVars((v) => ({ ...v, witness_2_mobile: e.target.value }))} />
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

      {/* Upload Manually Signed Document Dialog */}
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              Upload Signed Stamp-Paper Document
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="rounded-md bg-amber-50 text-amber-800 text-sm p-3">
              <p className="font-medium mb-1">Before uploading, confirm:</p>
              <ul className="list-disc list-inside space-y-0.5 text-xs">
                <li>Agreement is printed on appropriate stamp paper</li>
                <li>All parties have signed and witnesses have attested</li>
                <li>Stamp duty is correct and stamp paper details are visible</li>
                <li>Document is scanned at a readable resolution (min 150 dpi)</li>
              </ul>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="signed-pdf">Signed Agreement PDF</Label>
              <input
                id="signed-pdf"
                ref={fileInputRef}
                type="file"
                accept="application/pdf"
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium cursor-pointer"
              />
              <p className="text-xs text-muted-foreground">PDF only, max 20 MB. This will replace the generated PDF and mark the agreement as Executed.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setUploadOpen(false); if (fileInputRef.current) fileInputRef.current.value = ""; }}>
              Cancel
            </Button>
            <Button onClick={handleUploadSignedDocument} disabled={uploading}>
              {uploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Upload & Mark Executed
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
