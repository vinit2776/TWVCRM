"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Plus, CheckCircle, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  LEASE_STATUS_LABELS, LEASE_STATUS_COLORS, LANDLORD_KYC_STATUS_LABELS,
} from "@/lib/constants";
import { toast } from "sonner";
import type { Landlord, LandlordBankAccount, PropertyLease } from "@/types";

const KYC_COLORS: Record<string, string> = {
  verified: "bg-green-100 text-green-800",
  pending: "bg-yellow-100 text-yellow-800",
  incomplete: "bg-red-100 text-red-800",
};

export default function LandlordDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [landlord, setLandlord] = useState<Landlord | null>(null);
  const [bankAccounts, setBankAccounts] = useState<LandlordBankAccount[]>([]);
  const [leases, setLeases] = useState<PropertyLease[]>([]);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<string | null>(null);

  const [bankDialog, setBankDialog] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [bankForm, setBankForm] = useState({
    bank_name: "", account_number: "", ifsc_code: "",
    account_holder_name: "", account_type: "savings", is_primary: false,
  });

  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then((d) => setUserRole(d.role));
  }, []);

  const fetchLandlord = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/rent-management/landlords/${id}`);
    if (res.ok) {
      const json = await res.json();
      setLandlord(json.data);
      setBankAccounts(json.data?.bank_accounts || []);
      setLeases(json.data?.leases || []);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { fetchLandlord(); }, [fetchLandlord]);

  async function handleAddBankAccount() {
    setSubmitting(true);
    const r = await fetch(`/api/rent-management/landlords/${id}/bank-accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bankForm),
    });
    setSubmitting(false);
    if (r.ok) {
      toast.success("Bank account added");
      setBankDialog(false);
      setBankForm({ bank_name: "", account_number: "", ifsc_code: "", account_holder_name: "", account_type: "savings", is_primary: false });
      fetchLandlord();
    } else {
      const err = await r.json();
      toast.error(err.error || "Failed to add bank account");
    }
  }

  async function updateKycStatus(status: string) {
    const r = await fetch(`/api/rent-management/landlords/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kyc_status: status }),
    });
    if (r.ok) {
      toast.success("KYC status updated");
      fetchLandlord();
    } else {
      toast.error("Failed to update KYC status");
    }
  }

  const isAdmin = userRole === "admin";

  if (loading) {
    return <div className="p-6"><div className="h-8 w-64 bg-muted animate-pulse rounded" /></div>;
  }

  if (!landlord) return null;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="sm" asChild className="mt-1">
            <Link href="/rent-management/landlords"><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">{landlord.name}</h1>
              <Badge className={KYC_COLORS[landlord.kyc_status]}>
                {LANDLORD_KYC_STATUS_LABELS[landlord.kyc_status] ?? landlord.kyc_status}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {leases.length} active lease{leases.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
        {isAdmin && (
          <div className="flex gap-2">
            {landlord.kyc_status !== "verified" && (
              <Button size="sm" variant="outline" onClick={() => updateKycStatus("verified")}>
                <CheckCircle className="h-4 w-4 mr-2" />Mark KYC Verified
              </Button>
            )}
            {landlord.kyc_status === "verified" && (
              <Button size="sm" variant="outline" onClick={() => updateKycStatus("pending")}>
                Reset to Pending
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* KYC Details */}
        <Card>
          <CardHeader><CardTitle className="text-base">KYC Details</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="PAN" value={landlord.pan_number} mono />
            <Row label="GSTIN" value={landlord.gstin} mono />
            <Row label="Email" value={landlord.email} />
            <Row label="Phone" value={landlord.phone} />
            {landlord.registered_address && (
              <div className="pt-2 border-t">
                <p className="text-muted-foreground mb-1">Address</p>
                <p className="whitespace-pre-wrap">{landlord.registered_address}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Bank Accounts */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Bank Accounts</CardTitle>
            {isAdmin && (
              <Button size="sm" variant="outline" onClick={() => setBankDialog(true)}>
                <Plus className="h-4 w-4 mr-1" />Add Account
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            {bankAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No bank accounts added</p>
            ) : (
              bankAccounts.map((ba) => (
                <div key={ba.id} className="border rounded-lg p-3 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{ba.bank_name}</span>
                    {ba.is_primary && <Star className="h-3.5 w-3.5 text-yellow-500 fill-yellow-500" />}
                    {ba.is_verified && <CheckCircle className="h-3.5 w-3.5 text-green-600" />}
                  </div>
                  <p className="text-xs text-muted-foreground font-mono">{ba.account_number}</p>
                  <p className="text-xs text-muted-foreground">IFSC: {ba.ifsc_code} · {ba.account_holder_name}</p>
                  <div className="flex gap-2 mt-1">
                    {ba.is_primary && <Badge variant="outline" className="text-xs">Primary</Badge>}
                    {ba.is_verified ? (
                      <Badge className="text-xs bg-green-100 text-green-800">Verified</Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs text-yellow-700">Unverified</Badge>
                    )}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Active Leases */}
      {leases.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Active Leases</CardTitle></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left px-4 py-3 font-medium">Location</th>
                  <th className="text-right px-4 py-3 font-medium">Base Rent</th>
                  <th className="text-left px-4 py-3 font-medium">Term</th>
                  <th className="text-left px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {leases.map((l) => (
                  <tr key={l.id} className="border-b hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <Link href={`/rent-management/leases/${l.id}`} className="font-medium hover:underline text-primary">
                        {l.location?.name ?? "—"}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right font-medium">{formatCurrency(l.base_rent_amount)}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {formatDate(l.lease_start_date)} → {formatDate(l.lease_end_date)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={LEASE_STATUS_COLORS[l.status]}>
                        {LEASE_STATUS_LABELS[l.status]}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Add Bank Account Dialog */}
      <Dialog open={bankDialog} onOpenChange={setBankDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Bank Account</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2 col-span-2">
              <Label>Account Holder Name *</Label>
              <Input value={bankForm.account_holder_name} onChange={(e) => setBankForm((f) => ({ ...f, account_holder_name: e.target.value }))} required />
            </div>
            <div className="space-y-2">
              <Label>Bank Name *</Label>
              <Input value={bankForm.bank_name} onChange={(e) => setBankForm((f) => ({ ...f, bank_name: e.target.value }))} required />
            </div>
            <div className="space-y-2">
              <Label>Account Type</Label>
              <select
                value={bankForm.account_type}
                onChange={(e) => setBankForm((f) => ({ ...f, account_type: e.target.value }))}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              >
                <option value="savings">Savings</option>
                <option value="current">Current</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label>Account Number *</Label>
              <Input value={bankForm.account_number} onChange={(e) => setBankForm((f) => ({ ...f, account_number: e.target.value }))} required />
            </div>
            <div className="space-y-2">
              <Label>IFSC Code *</Label>
              <Input value={bankForm.ifsc_code} onChange={(e) => setBankForm((f) => ({ ...f, ifsc_code: e.target.value.toUpperCase() }))} maxLength={11} required />
            </div>
            <div className="flex items-center gap-2 col-span-2 pt-1">
              <input
                type="checkbox"
                id="is_primary"
                checked={bankForm.is_primary}
                onChange={(e) => setBankForm((f) => ({ ...f, is_primary: e.target.checked }))}
                className="h-4 w-4"
              />
              <Label htmlFor="is_primary">Set as primary account</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBankDialog(false)}>Cancel</Button>
            <Button onClick={handleAddBankAccount} disabled={submitting}>
              {submitting ? "Adding..." : "Add Account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs" : ""}>{value ?? "—"}</span>
    </div>
  );
}
