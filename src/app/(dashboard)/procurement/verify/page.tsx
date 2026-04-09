"use client";

import { useState } from "react";
import { ShieldCheck, ShieldAlert, Search, Loader2, FileText, Receipt, ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { formatDate, formatCurrency } from "@/lib/utils";

const TYPE_LABELS: Record<string, string> = {
  purchase_request: "Purchase Request Approval",
  vendor_bill: "Vendor Bill Approval",
  stock_transfer: "Stock Transfer Approval",
};

const TYPE_ICONS: Record<string, React.ReactNode> = {
  purchase_request: <FileText className="h-5 w-5" />,
  vendor_bill: <Receipt className="h-5 w-5" />,
  stock_transfer: <ArrowLeftRight className="h-5 w-5" />,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VerificationResult = { type: string; code: string; is_valid: boolean; entity: any; related_orders?: any[] };

export default function VerifyApprovalPage() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [notFound, setNotFound] = useState(false);

  const handleVerify = async () => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) { toast.error("Enter an approval code"); return; }
    setLoading(true);
    setResult(null);
    setNotFound(false);
    try {
      const res = await fetch(`/api/procurement/verify?code=${encodeURIComponent(trimmed)}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Verification failed");
        return;
      }
      setResult(await res.json());
    } catch {
      toast.error("Verification failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Verify Approval</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Enter an approval code to verify its authenticity and view the approval trail.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-2">
            <Input
              placeholder="e.g. APR-2604-001-A3F2"
              value={code}
              onChange={(e) => { setCode(e.target.value.toUpperCase()); setNotFound(false); setResult(null); }}
              onKeyDown={(e) => e.key === "Enter" && handleVerify()}
              className="font-mono text-lg tracking-wider"
            />
            <Button onClick={handleVerify} disabled={loading || !code.trim()}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Not Found */}
      {notFound && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <ShieldAlert className="h-6 w-6 text-red-600 mt-0.5" />
              <div>
                <p className="font-semibold text-red-800">Approval Code Not Found</p>
                <p className="text-sm text-red-700 mt-1">
                  The code <strong className="font-mono">{code.trim().toUpperCase()}</strong> does not match any
                  approval in the system. This may indicate a forged or invalid reference.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Verification Result */}
      {result && (
        <div className="space-y-4">
          {/* Validity Banner */}
          {result.is_valid ? (
            <Card className="border-green-200 bg-green-50">
              <CardContent className="pt-6">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="h-6 w-6 text-green-600 mt-0.5" />
                  <div>
                    <p className="font-semibold text-green-800">Signature Verified</p>
                    <p className="text-sm text-green-700 mt-1">
                      This approval code is authentic and has not been tampered with.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="border-amber-200 bg-amber-50">
              <CardContent className="pt-6">
                <div className="flex items-start gap-3">
                  <ShieldAlert className="h-6 w-6 text-amber-600 mt-0.5" />
                  <div>
                    <p className="font-semibold text-amber-800">Signature Mismatch</p>
                    <p className="text-sm text-amber-700 mt-1">
                      The code exists in the system but the cryptographic signature does not match.
                      This may indicate the code was modified after generation.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Approval Details */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                {TYPE_ICONS[result.type]}
                <CardTitle className="text-base">{TYPE_LABELS[result.type] || result.type}</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Approval Code</span>
                  <span className="font-mono font-bold">{result.code}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Reference Number</span>
                  <span className="font-medium">{result.entity.number}</span>
                </div>
                {result.entity.status && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Current Status</span>
                    <Badge variant="secondary">{result.entity.status}</Badge>
                  </div>
                )}
                {result.entity.amount != null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Amount</span>
                    <span className="font-medium">{formatCurrency(result.entity.amount)}</span>
                  </div>
                )}
                {result.entity.department && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Department</span>
                    <span className="capitalize">{result.entity.department}</span>
                  </div>
                )}
                {result.entity.approved_at && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Approved On</span>
                    <span>{formatDate(result.entity.approved_at)}</span>
                  </div>
                )}
                {result.entity.approver?.full_name && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Approved By</span>
                    <span className="font-medium">{result.entity.approver.full_name}</span>
                  </div>
                )}
                {result.entity.requester?.full_name && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Requested By</span>
                    <span>{result.entity.requester.full_name}</span>
                  </div>
                )}
                {result.entity.vendor?.name && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Vendor</span>
                    <span>{result.entity.vendor.name}</span>
                  </div>
                )}
                {result.entity.location?.name && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Location</span>
                    <span>{result.entity.location.name}</span>
                  </div>
                )}
                {result.entity.from_location?.name && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Transfer</span>
                    <span>{result.entity.from_location.name} → {result.entity.to_location?.name}</span>
                  </div>
                )}
                {result.entity.po?.po_number && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Linked PO</span>
                    <span>{result.entity.po.po_number}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Related POs (for PR approvals) */}
          {result.related_orders && result.related_orders.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Purchase Orders from this Approval</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {result.related_orders.map((po: any) => (
                    <div key={po.id} className="flex justify-between items-center text-sm border-b last:border-0 pb-2 last:pb-0">
                      <div>
                        <span className="font-medium font-mono">{po.po_number}</span>
                        {po.procurement_vendors?.name && (
                          <span className="text-muted-foreground ml-2">— {po.procurement_vendors.name}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {po.total_ordered_amount && (
                          <span className="text-muted-foreground">{formatCurrency(po.total_ordered_amount)}</span>
                        )}
                        <Badge variant="secondary" className="text-xs">{po.status}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
