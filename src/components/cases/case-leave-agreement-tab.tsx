"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/shared/status-badge";
import { AgreementDocumentHistory } from "@/components/agreements/agreement-document-history";
import {
  FileText,
  Send,
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
  Stamp,
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
  const { user } = useCurrentUser();
  const userRole = user?.role ?? null;
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
  const [stampingSignSeal, setStampingSignSeal] = useState(false);
  const [stampConfirmOpen, setStampConfirmOpen] = useState(false);
  const [stampPreviewLoading, setStampPreviewLoading] = useState(false);
  const [stampPreviewUrl, setStampPreviewUrl] = useState<string | null>(null);
  const [stampPreviewRef, setStampPreviewRef] = useState<string | null>(null);
  const [cancelStampOpen, setCancelStampOpen] = useState(false);
  const [cancellingStamp, setCancellingStamp] = useState(false);
  const [stampError, setStampError] = useState<string | null>(null);
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

  // Served through the API rather than a signed storage URL so an unstamped
  // agreement is watermarked DRAFT on the way out — see
  // /api/cases/[id]/leave-license/pdf.
  const handleViewPdf = async () => {
    setViewing(true);
    try {
      window.open(`/api/cases/${caseId}/leave-license/pdf${watermarkQuery}`, "_blank");
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
      endDate.setDate(endDate.getDate() - 1);

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

  // ── Draft watermark ────────────────────────────────────────────────────
  // One decision governs View, Download and Send so the three cannot disagree.
  // Whether it can be unticked is computed server-side from the billing route
  // and whether the case has been paid — never chosen here.
  const [watermarkOn, setWatermarkOn] = useState(true);
  const [watermarkPolicy, setWatermarkPolicy] = useState<{
    route: "prepaid" | "postpaid" | "direct";
    forced: boolean;
    settled: boolean;
    reason: string;
    aggregatorName: string | null;
  } | null>(null);

  const loadWatermarkPolicy = useCallback(async () => {
    const res = await fetch(`/api/cases/${caseId}/leave-license/watermark-policy`);
    if (!res.ok) return;
    const json = await res.json().catch(() => null);
    if (!json?.data) return;
    setWatermarkPolicy(json.data);
    // Always re-tick when the policy reloads: a lock that has just come into
    // force must not leave a stale unticked box behind it.
    if (json.data.forced) setWatermarkOn(true);
  }, [caseId]);

  useEffect(() => { loadWatermarkPolicy(); }, [loadWatermarkPolicy]);

  /** Suffix for the PDF routes; the server still re-decides. */
  const watermarkQuery = watermarkOn ? "" : "?watermark=0";

  // ── Send to customer ───────────────────────────────────────────────────
  const [sendOpen, setSendOpen] = useState(false);
  const [sendPreviewLoading, setSendPreviewLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendCc, setSendCc] = useState("");
  const [sendPreview, setSendPreview] = useState<{
    to: string | null;
    toName: string;
    toKind: "aggregator" | "client";
    onBehalfOf: string | null;
    subject: string;
    html: string;
    blocked: string | null;
    attachmentName: string | null;
    isDraft: boolean;
    hasPdf: boolean;
    watermark?: {
      forced: boolean;
      settled: boolean;
      reason: string;
      route: "prepaid" | "postpaid" | "direct";
    };
  } | null>(null);

  const openSendDialog = async () => {
    setSendPreviewLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/leave-license/send`);
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error || "Could not build the preview");
        return;
      }
      setSendPreview(json.data);
      setSendCc("");
      setSendOpen(true);
    } finally {
      setSendPreviewLoading(false);
    }
  };

  const handleSendToCustomer = async () => {
    setSending(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/leave-license/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cc: sendCc, watermark: watermarkOn }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error || "Send failed");
        return;
      }
      toast.success(`Agreement sent to ${json.data.to}`);
      setSendOpen(false);
      fetchAgreement();
      loadWatermarkPolicy();
    } catch {
      toast.error("Send failed");
    } finally {
      setSending(false);
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

    setViewing(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/leave-license/pdf${watermarkQuery}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || "PDF not found — regenerate the agreement first");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `leave-license-${caseId}.pdf`;
      a.rel = "noopener";
      a.click();
      URL.revokeObjectURL(url);
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

  const closeStampPreview = () => {
    setStampConfirmOpen(false);
    if (stampPreviewUrl) URL.revokeObjectURL(stampPreviewUrl);
    setStampPreviewUrl(null);
    setStampPreviewRef(null);
    setStampError(null);
  };

  const handleOpenStampPreview = async () => {
    if (!agreement) return;
    setStampPreviewLoading(true);
    setStampError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/leave-license/preview-stamp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agreement_id: agreement.id }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to generate preview");
      }
      const { pdfBase64, stampRef } = await res.json();
      const bytes = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      setStampPreviewUrl(blobUrl);
      setStampPreviewRef(stampRef);
      // Just open the confirmation dialog — don't auto-open a new tab here.
      // Auto-opening stole focus to the PDF tab before the user ever saw the
      // dialog's own "Open preview PDF" button; let them choose when to look.
      setStampConfirmOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate preview");
    } finally {
      setStampPreviewLoading(false);
    }
  };

  const handleStampSignSeal = async () => {
    if (!agreement || !stampPreviewRef) return;
    setStampingSignSeal(true);
    setStampError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/leave-license/stamp-sign-seal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agreement_id: agreement.id, stampRef: stampPreviewRef }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to stamp agreement");
      }
      const { data } = await res.json().catch(() => ({ data: null }));
      toast.success(
        data?.stamp_reference
          ? `Agreement stamped with company sign & seal (${data.stamp_reference})`
          : "Agreement stamped with company sign & seal"
      );
      closeStampPreview();
      fetchAgreement();
    } catch (err) {
      setStampError(err instanceof Error ? err.message : "Failed to stamp agreement");
    } finally {
      setStampingSignSeal(false);
    }
  };

  const handleCancelStamp = async () => {
    if (!agreement) return;
    setCancellingStamp(true);
    setStampError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/leave-license/cancel-stamp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agreement_id: agreement.id }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to cancel the stamp");
      }
      toast.success("Sign & seal stamp cancelled — the agreement is editable again");
      setCancelStampOpen(false);
      fetchAgreement();
    } catch (err) {
      setStampError(err instanceof Error ? err.message : "Failed to cancel the stamp");
    } finally {
      setCancellingStamp(false);
    }
  };

  const isEditable = agreement?.status === "draft" || agreement?.status === "internally_approved";
  const canStampSignSeal =
    userRole === "admin" &&
    !!agreement &&
    !agreement.signed_document_id &&
    ["draft", "internally_approved", "sent_to_client", "client_approved", "signing"].includes(
      agreement.status
    );

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

  // Mirrors allowedStatuses in the manual-sign route — keep the two in step.
  const canUploadManualSign = agreement &&
    ["draft", "internally_approved", "sent_to_client", "client_approved", "signing"]
      .includes(agreement.status) &&
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

          {/* Draft watermark — hidden once executed, when nothing is marked */}
          {watermarkPolicy && !watermarkPolicy.settled && (
            <div
              className={`flex items-start gap-3 rounded-md border p-3 ${
                watermarkPolicy.forced
                  ? "border-amber-200 bg-amber-50"
                  : watermarkOn
                    ? "border-muted bg-muted/40"
                    : "border-red-200 bg-red-50"
              }`}
            >
              <Checkbox
                id="wm-toggle"
                checked={watermarkOn}
                disabled={watermarkPolicy.forced}
                onCheckedChange={(v: boolean | "indeterminate") => setWatermarkOn(!!v)}
                className="mt-0.5"
              />
              <div className="min-w-0">
                <Label htmlFor="wm-toggle" className="text-sm font-medium cursor-pointer">
                  Draft watermark
                </Label>
                <p
                  className={`text-xs ${
                    watermarkPolicy.forced
                      ? "text-amber-800"
                      : watermarkOn
                        ? "text-muted-foreground"
                        : "text-red-700"
                  }`}
                >
                  {watermarkPolicy.forced && "🔒 "}
                  {watermarkOn
                    ? watermarkPolicy.reason
                    : "Clean, unexecuted copy. Who released it is recorded against the case."}
                </p>
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
            {/* Send is available at any point before execution. The internal
                and client approval steps were removed: they gated the send
                behind two clicks that recorded nothing anyone acted on, and
                left an agreement in sent_to_client with no way forward. */}
            {agreement.status !== "executed" && (
              <Button size="sm" onClick={openSendDialog} disabled={sendPreviewLoading}>
                {sendPreviewLoading
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <Send className="mr-2 h-4 w-4" />}
                Send to Customer
              </Button>
            )}

            {["client_approved", "sent_to_client", "internally_approved"].includes(agreement.status) && (
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

            {canStampSignSeal && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleOpenStampPreview}
                disabled={stampPreviewLoading}
              >
                {stampPreviewLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Stamp className="mr-2 h-4 w-4" />
                )}
                Stamp with company seal
              </Button>
            )}

            {agreement.signed_document_id && agreement.stamp_reference && userRole === "admin" && (
              <Button size="sm" variant="outline" onClick={() => { setStampError(null); setCancelStampOpen(true); }}>
                <XCircle className="mr-2 h-4 w-4" />
                Cancel sign & seal
              </Button>
            )}

            {acting && <Loader2 className="h-4 w-4 animate-spin ml-2" />}
          </div>
        </CardContent>
      </Card>

      {/* Agreement document history — old executed versions stay
          visible/downloadable after a reupload (e.g. customer name change
          or a change-of-law redocumentation). */}
      <Card>
        <CardContent className="pt-4">
          <AgreementDocumentHistory
            listUrl={`/api/cases/${caseId}/leave-license/agreement-versions`}
            reuploadUrl={`/api/cases/${caseId}/leave-license/reupload-agreement`}
            reuploadExtraFields={{ agreement_id: agreement.id }}
            canManage={
              agreement.status === "executed" &&
              ["admin", "manager", "sales_rep", "office_admin"].includes(userRole ?? "")
            }
            hasExistingDocument={!!(agreement.signed_document_id || agreement.generated_document_id)}
            onChanged={fetchAgreement}
          />
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

      {/* Send to Customer — preview exactly what goes out */}
      <Dialog open={sendOpen} onOpenChange={(v) => { if (!v) setSendOpen(false); }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-5 w-5" />
              Send Agreement to Customer
            </DialogTitle>
          </DialogHeader>

          {sendPreview && (
            <div className="space-y-4">
              {sendPreview.blocked && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                  {sendPreview.blocked}
                </div>
              )}

              <div className="rounded-md border divide-y text-sm">
                <div className="flex gap-3 px-3 py-2">
                  <span className="w-20 shrink-0 text-muted-foreground">To</span>
                  <span className="font-medium">
                    {sendPreview.to ?? <span className="text-red-600">no address on record</span>}
                    {sendPreview.to && (
                      <span className="ml-2 font-normal text-muted-foreground">
                        {sendPreview.toName}
                        {sendPreview.toKind === "aggregator" && " · aggregator"}
                      </span>
                    )}
                  </span>
                </div>
                {sendPreview.onBehalfOf && (
                  <div className="flex gap-3 px-3 py-2">
                    <span className="w-20 shrink-0 text-muted-foreground">On behalf of</span>
                    <span>{sendPreview.onBehalfOf}</span>
                  </div>
                )}
                <div className="flex gap-3 px-3 py-2">
                  <span className="w-20 shrink-0 text-muted-foreground">Subject</span>
                  <span className="font-medium">{sendPreview.subject}</span>
                </div>
                <div className="flex gap-3 px-3 py-2">
                  <span className="w-20 shrink-0 text-muted-foreground">Attached</span>
                  <span>
                    {sendPreview.attachmentName
                      ? (watermarkOn
                          ? sendPreview.attachmentName
                          : sendPreview.attachmentName.replace(/^DRAFT-/, ""))
                      : <span className="text-red-600">no PDF generated</span>}
                    {sendPreview.isDraft && watermarkOn && (
                      <span className="ml-2 text-xs text-amber-700">watermarked DRAFT</span>
                    )}
                  </span>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="send-cc">CC (optional)</Label>
                <Input
                  id="send-cc"
                  value={sendCc}
                  onChange={(e) => setSendCc(e.target.value)}
                  placeholder="someone@example.com, another@example.com"
                />
                <p className="text-xs text-muted-foreground">
                  Separate multiple addresses with commas.
                </p>
              </div>

              {sendPreview.watermark && !sendPreview.watermark.settled && (
                <div
                  className={`flex items-start gap-3 rounded-md border p-3 ${
                    sendPreview.watermark.forced
                      ? "border-amber-200 bg-amber-50"
                      : watermarkOn
                        ? "border-muted bg-muted/40"
                        : "border-red-200 bg-red-50"
                  }`}
                >
                  <Checkbox
                    id="wm-send"
                    checked={watermarkOn}
                    disabled={sendPreview.watermark.forced}
                    onCheckedChange={(v: boolean | "indeterminate") => setWatermarkOn(!!v)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0">
                    <Label htmlFor="wm-send" className="text-sm font-medium cursor-pointer">
                      Draft watermark
                    </Label>
                    <p className={`text-xs ${sendPreview.watermark.forced ? "text-amber-800" : "text-muted-foreground"}`}>
                      {sendPreview.watermark.forced && "🔒 "}
                      {sendPreview.watermark.reason}
                    </p>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Label>Message preview</Label>
                <div
                  className="rounded-md border bg-muted/30 p-3 max-h-72 overflow-y-auto"
                  dangerouslySetInnerHTML={{ __html: sendPreview.html }}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setSendOpen(false)}>Cancel</Button>
            <Button
              onClick={handleSendToCustomer}
              disabled={
                sending || !sendPreview || !!sendPreview.blocked ||
                !sendPreview.to || !sendPreview.hasPdf
              }
            >
              {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              Send Now
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

      <Dialog open={stampConfirmOpen} onOpenChange={(open) => { if (!open) closeStampPreview(); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Preview: stamp with company seal</DialogTitle>
            <DialogDescription>
              This is exactly what will be saved as the signed Leave &amp; License Agreement —
              TWV&apos;s signature and seal applied in the Lessor field, ref {stampPreviewRef}.
              Review it before confirming. This marks the agreement executed and does not go
              through Leegality. You can cancel it afterward from &quot;Cancel sign &amp;
              seal&quot; if needed.
            </DialogDescription>
          </DialogHeader>
          {stampPreviewUrl && (
            <div className="rounded-md border bg-muted/30 p-4 flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Review the exact PDF before confirming.
              </p>
              <Button asChild variant="outline" size="sm" className="shrink-0">
                <a href={stampPreviewUrl} target="_blank" rel="noopener noreferrer">
                  <Eye className="mr-1.5 h-3.5 w-3.5" />
                  Open preview PDF
                </a>
              </Button>
            </div>
          )}
          {stampError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {stampError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeStampPreview}>
              Cancel
            </Button>
            <Button onClick={handleStampSignSeal} disabled={stampingSignSeal}>
              {stampingSignSeal ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Stamping...
                </>
              ) : (
                "Confirm & save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelStampOpen} onOpenChange={(open) => { setCancelStampOpen(open); if (!open) setStampError(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel sign & seal?</DialogTitle>
            <DialogDescription>
              This removes the stamped signed document and reverts the agreement to its
              status before stamping — Edit Agreement becomes available again if that status
              is draft or internally approved. You can re-stamp it afterward if needed.
            </DialogDescription>
          </DialogHeader>
          {stampError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {stampError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCancelStampOpen(false); setStampError(null); }}>
              Keep it
            </Button>
            <Button variant="destructive" onClick={handleCancelStamp} disabled={cancellingStamp}>
              {cancellingStamp ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Cancelling...
                </>
              ) : (
                "Cancel sign & seal"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
