"use client";

import { use, useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Download,
  Loader2,
  Upload,
  FileText,
  Eye,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { ContractVouchersSection } from "@/components/contracts/contract-vouchers-section";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CONTRACT_STATUS_LABELS,
  CONTRACT_STATUS_COLORS,
  BILLING_CYCLE_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import { toast } from "sonner";
import type { Contract } from "@/types";

export default function ContractDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [contract, setContract] = useState<Contract | null>(null);
  const [loading, setLoading] = useState(true);
  const [activating, setActivating] = useState(false);
  const [terminateOpen, setTerminateOpen] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [terminationReason, setTerminationReason] = useState("");
  const [uploadingSignedDoc, setUploadingSignedDoc] = useState(false);

  const fetchContract = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/contracts/${id}`);
    if (res.ok) {
      const json = await res.json();
      setContract(json.data || null);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    fetchContract();
  }, [fetchContract]);

  const handleActivate = async () => {
    setActivating(true);
    const res = await fetch(`/api/contracts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    if (res.ok) {
      toast.success("Contract activated successfully");
      fetchContract();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to activate contract");
    }
    setActivating(false);
  };

  const handleTerminate = async () => {
    if (!terminationReason.trim()) {
      toast.error("Please provide a termination reason");
      return;
    }
    setTerminating(true);
    const res = await fetch(`/api/contracts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "terminated",
        termination_reason: terminationReason.trim(),
      }),
    });
    if (res.ok) {
      toast.success("Contract terminated");
      setTerminateOpen(false);
      setTerminationReason("");
      fetchContract();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to terminate contract");
    }
    setTerminating(false);
  };

  const handleDownloadPDF = () => {
    // Open the PDF download endpoint in a new tab
    window.open(`/api/contracts/${id}/pdf`, "_blank");
  };

  const handleSignedDocUpload = async (file: File) => {
    if (!contract) return;
    setUploadingSignedDoc(true);

    // Step 1: Upload the file to /api/documents
    const formData = new FormData();
    formData.append("file", file);
    formData.append("title", `Signed Contract - ${contract.contract_number}`);
    formData.append("category", "signed_contract");
    formData.append("lead_id", contract.lead_id);

    const uploadRes = await fetch("/api/documents", {
      method: "POST",
      body: formData,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => null);
      toast.error(err?.error || "Failed to upload document");
      setUploadingSignedDoc(false);
      return;
    }

    const { data: doc } = await uploadRes.json();

    // Step 2: Link document to contract
    const patchRes = await fetch(`/api/contracts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signed_document_id: doc.id }),
    });

    if (patchRes.ok) {
      toast.success("Signed contract uploaded successfully");
      fetchContract();
    } else {
      const err = await patchRes.json().catch(() => null);
      toast.error(err?.error || "Failed to link document to contract");
    }

    setUploadingSignedDoc(false);
  };

  const handleViewSignedDoc = async () => {
    if (!contract?.signed_document?.file_path) return;
    // Use Supabase Storage public/signed URL
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (supabaseUrl && supabaseKey) {
      const res = await fetch(
        `${supabaseUrl}/storage/v1/object/sign/crm-documents/${contract.signed_document.file_path}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${supabaseKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ expiresIn: 3600 }),
        }
      );
      if (res.ok) {
        const { signedURL } = await res.json();
        window.open(`${supabaseUrl}/storage/v1${signedURL}`, "_blank");
        return;
      }
    }
    toast.error("Failed to get download URL");
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
        <div className="grid grid-cols-2 gap-4 mt-8">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      </div>
    );
  }

  if (!contract) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold">Contract not found</h2>
        <Button variant="outline" className="mt-4" onClick={() => router.push("/contracts")}>
          Back to Contracts
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/contracts")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold font-mono">{contract.contract_number}</h1>
              <Badge variant="secondary" className={CONTRACT_STATUS_COLORS[contract.status]}>
                {CONTRACT_STATUS_LABELS[contract.status]}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{contract.title}</p>
          </div>
        </div>
        <div className="flex gap-2">
          {contract.status === "draft" && (
            <Button onClick={handleActivate} disabled={activating}>
              {activating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-2 h-4 w-4" />
              )}
              Activate
            </Button>
          )}
          {contract.status === "active" && (
            <Button variant="destructive" onClick={() => setTerminateOpen(true)}>
              <XCircle className="mr-2 h-4 w-4" />
              Terminate
            </Button>
          )}
          <Button variant="outline" onClick={handleDownloadPDF}>
            <Download className="mr-2 h-4 w-4" />
            Download PDF
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Overview Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                {contract.lead && (
                  <>
                    <div>
                      <p className="text-muted-foreground text-xs">Lead</p>
                      <Link
                        href={`/leads/${contract.lead.id}`}
                        className="text-primary hover:underline font-medium"
                      >
                        {contract.lead.first_name} {contract.lead.last_name}
                      </Link>
                    </div>
                    {contract.lead.company && (
                      <div>
                        <p className="text-muted-foreground text-xs">Company</p>
                        <p>{contract.lead.company}</p>
                      </div>
                    )}
                    {contract.lead.email && (
                      <div>
                        <p className="text-muted-foreground text-xs">Email</p>
                        <p>{contract.lead.email}</p>
                      </div>
                    )}
                  </>
                )}
                {contract.proposal && (
                  <div>
                    <p className="text-muted-foreground text-xs">Proposal</p>
                    <p className="font-mono text-xs">{contract.proposal.proposal_number}</p>
                  </div>
                )}
              </div>
              <Separator className="my-4" />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs">Subtotal</p>
                  <p className="font-medium">{formatCurrency(contract.subtotal)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Tax ({contract.tax_percentage}%)</p>
                  <p className="font-medium">{formatCurrency(contract.tax_amount)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Discount ({contract.discount_percentage}%)</p>
                  <p className="font-medium">-{formatCurrency(contract.discount_amount)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Total</p>
                  <p className="font-bold text-lg">{formatCurrency(contract.total_amount)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Line Items Table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Line Items</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-4 py-3 text-left font-medium">Description</th>
                      <th className="px-4 py-3 text-right font-medium">Qty</th>
                      <th className="px-4 py-3 text-right font-medium">Unit Price</th>
                      <th className="px-4 py-3 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contract.items.map((item, idx) => (
                      <tr key={idx} className="border-b">
                        <td className="px-4 py-3">{item.description}</td>
                        <td className="px-4 py-3 text-right">{item.quantity}</td>
                        <td className="px-4 py-3 text-right">{formatCurrency(item.unit_price)}</td>
                        <td className="px-4 py-3 text-right font-medium">{formatCurrency(item.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Terms & Conditions */}
          {contract.terms_and_conditions && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Terms & Conditions</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">{contract.terms_and_conditions}</p>
              </CardContent>
            </Card>
          )}

          {/* Vouchers Section */}
          <ContractVouchersSection
            contractId={id}
            seats={contract.seats}
            contractStatus={contract.status}
            startDate={contract.start_date}
            endDate={contract.end_date}
            tenureMonths={contract.tenure_months}
            signedDocumentId={contract.signed_document_id}
            leadEmail={contract.lead?.email}
          />

          {/* Notes */}
          {contract.notes && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">{contract.notes}</p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Contract Details Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Contract Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Billing Cycle</span>
                <span>{BILLING_CYCLE_LABELS[contract.billing_cycle]}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tenure</span>
                <span>{contract.tenure_months} months</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Start Date</span>
                <span>{formatDate(contract.start_date)}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">End Date</span>
                <span>{formatDate(contract.end_date)}</span>
              </div>
              {contract.next_billing_date && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Next Billing</span>
                    <span>{formatDate(contract.next_billing_date)}</span>
                  </div>
                </>
              )}
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Seats</span>
                <span>{contract.seats}</span>
              </div>
            </CardContent>
          </Card>

          {/* Signed Contract */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Signed Contract
              </CardTitle>
            </CardHeader>
            <CardContent>
              {contract.signed_document ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm">
                    <FileText className="h-4 w-4 text-green-600" />
                    <span className="truncate font-medium">
                      {contract.signed_document.file_name}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Uploaded {formatDate(contract.signed_document.created_at)}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleViewSignedDoc}
                    >
                      <Eye className="mr-1.5 h-3.5 w-3.5" />
                      View
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const input = document.createElement("input");
                        input.type = "file";
                        input.accept = ".pdf,.jpg,.jpeg,.png";
                        input.onchange = (e) => {
                          const file = (e.target as HTMLInputElement).files?.[0];
                          if (file) handleSignedDocUpload(file);
                        };
                        input.click();
                      }}
                      disabled={uploadingSignedDoc}
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      Replace
                    </Button>
                  </div>
                </div>
              ) : (
                <div
                  className="border-2 border-dashed rounded-lg p-4 text-center cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
                  onClick={() => {
                    if (uploadingSignedDoc) return;
                    const input = document.createElement("input");
                    input.type = "file";
                    input.accept = ".pdf,.jpg,.jpeg,.png";
                    input.onchange = (e) => {
                      const file = (e.target as HTMLInputElement).files?.[0];
                      if (file) handleSignedDocUpload(file);
                    };
                    input.click();
                  }}
                >
                  {uploadingSignedDoc ? (
                    <div className="space-y-2">
                      <Loader2 className="h-6 w-6 mx-auto animate-spin text-muted-foreground" />
                      <p className="text-xs text-muted-foreground">Uploading...</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Upload className="h-6 w-6 mx-auto text-muted-foreground" />
                      <p className="text-xs text-muted-foreground">
                        Upload signed contract
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        PDF, JPG, or PNG (max 10MB)
                      </p>
                    </div>
                  )}
                </div>
              )}
              {!contract.signed_document && contract.status === "active" && (
                <p className="text-xs text-amber-600 mt-2 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  Required before issuing vouchers
                </p>
              )}
            </CardContent>
          </Card>

          {/* Quick Info */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Quick Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Created</span>
                <span>{formatDate(contract.created_at)}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Updated</span>
                <span>{formatDate(contract.updated_at)}</span>
              </div>
              {contract.activated_at && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Activated</span>
                    <span>{formatDate(contract.activated_at)}</span>
                  </div>
                </>
              )}
              {contract.renewed_at && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Renewed</span>
                    <span>{formatDate(contract.renewed_at)}</span>
                  </div>
                </>
              )}
              {contract.terminated_at && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Terminated</span>
                    <span>{formatDate(contract.terminated_at)}</span>
                  </div>
                </>
              )}
              {contract.termination_reason && (
                <>
                  <Separator />
                  <div>
                    <span className="text-muted-foreground block mb-1">Termination Reason</span>
                    <span>{contract.termination_reason}</span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Terminate Dialog */}
      <Dialog open={terminateOpen} onOpenChange={setTerminateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Terminate Contract</DialogTitle>
            <DialogDescription>
              Are you sure you want to terminate contract {contract.contract_number}?
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="termination-reason">
              Termination Reason <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="termination-reason"
              value={terminationReason}
              onChange={(e) => setTerminationReason(e.target.value)}
              placeholder="Please provide a reason for termination..."
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTerminateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleTerminate}
              disabled={terminating}
            >
              {terminating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Terminating...
                </>
              ) : (
                "Terminate"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
