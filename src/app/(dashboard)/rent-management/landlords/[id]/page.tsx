"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Plus, CheckCircle, Star, Pencil, Upload, FileText, Trash2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  LEASE_STATUS_LABELS, LEASE_STATUS_COLORS, LANDLORD_KYC_STATUS_LABELS,
} from "@/lib/constants";
import { toast } from "sonner";
import type { Landlord, LandlordBankAccount, PropertyLease } from "@/types";

const DOC_TYPE_LABELS: Record<string, string> = {
  pan_card: "PAN Card",
  gstin_certificate: "GSTIN Certificate",
  aadhaar: "Aadhaar",
  cancelled_cheque: "Cancelled Cheque",
  other: "Other",
};

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

  const [kycDialog, setKycDialog] = useState(false);
  const [kycSaving, setKycSaving] = useState(false);
  const [kycForm, setKycForm] = useState({
    name: "", contact_person: "", pan_number: "", gstin: "",
    email: "", phone: "", registered_address: "", kyc_status: "pending", notes: "",
  });

  type KycDoc = { name: string; doc_type: string; path: string; uploaded_at: string; signed_url?: string | null };
  const [kycDocs, setKycDocs] = useState<KycDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [uploadDialog, setUploadDialog] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadDocType, setUploadDocType] = useState("pan_card");
  const [uploading, setUploading] = useState(false);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then((d) => setUserRole(d.role));
  }, []);

  const fetchLandlord = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/rent-management/landlords/${id}`);
    if (res.ok) {
      const json = await res.json();
      const d = json.data;
      setLandlord(d);
      setBankAccounts(d?.bank_accounts || []);
      setLeases(d?.leases || []);
      if (d) {
        setKycForm({
          name: d.name ?? "",
          contact_person: d.contact_person ?? "",
          pan_number: d.pan_number ?? "",
          gstin: d.gstin ?? "",
          email: d.email ?? "",
          phone: d.phone ?? "",
          registered_address: d.registered_address ?? "",
          kyc_status: d.kyc_status ?? "pending",
          notes: d.notes ?? "",
        });
      }
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { fetchLandlord(); }, [fetchLandlord]);

  const fetchKycDocs = useCallback(async () => {
    setDocsLoading(true);
    const res = await fetch(`/api/rent-management/landlords/${id}/kyc-documents`);
    if (res.ok) {
      const json = await res.json();
      setKycDocs(json.data || []);
    }
    setDocsLoading(false);
  }, [id]);

  useEffect(() => { fetchKycDocs(); }, [fetchKycDocs]);

  async function handleUploadDoc() {
    if (!uploadFile) return;
    setUploading(true);
    const fd = new FormData();
    fd.append("file", uploadFile);
    fd.append("doc_type", uploadDocType);
    const r = await fetch(`/api/rent-management/landlords/${id}/kyc-documents`, {
      method: "POST",
      body: fd,
    });
    setUploading(false);
    if (r.ok) {
      toast.success("Document uploaded");
      setUploadDialog(false);
      setUploadFile(null);
      setUploadDocType("pan_card");
      fetchKycDocs();
    } else {
      const err = await r.json();
      toast.error(err.error || "Upload failed");
    }
  }

  async function handleDeleteDoc(path: string) {
    setDeletingPath(path);
    const r = await fetch(`/api/rent-management/landlords/${id}/kyc-documents`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    setDeletingPath(null);
    if (r.ok) {
      toast.success("Document removed");
      fetchKycDocs();
    } else {
      toast.error("Failed to remove document");
    }
  }

  async function handleSaveKyc() {
    setKycSaving(true);
    const body = {
      name: kycForm.name,
      contact_person: kycForm.contact_person || null,
      pan_number: kycForm.pan_number || null,
      gstin: kycForm.gstin || null,
      email: kycForm.email || null,
      phone: kycForm.phone || null,
      registered_address: kycForm.registered_address || null,
      kyc_status: kycForm.kyc_status,
      notes: kycForm.notes || null,
    };
    const r = await fetch(`/api/rent-management/landlords/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setKycSaving(false);
    if (r.ok) {
      toast.success("KYC details updated");
      setKycDialog(false);
      fetchLandlord();
    } else {
      const err = await r.json();
      toast.error(err.error || "Failed to save KYC details");
    }
  }

  async function markBankAccountVerified(accountId: string) {
    const r = await fetch(`/api/rent-management/landlords/${id}/bank-accounts/${accountId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_verified: true }),
    });
    if (r.ok) {
      toast.success("Bank account marked as verified");
      fetchLandlord();
    } else {
      toast.error("Failed to update");
    }
  }

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
        {(isAdmin || userRole === "accounts") && (
          <Button size="sm" variant="outline" onClick={() => setKycDialog(true)}>
            <Pencil className="h-4 w-4 mr-2" />Edit Details
          </Button>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* KYC Details */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">KYC Details</CardTitle>
            {(isAdmin || userRole === "accounts") && (
              <Button size="sm" variant="outline" onClick={() => setKycDialog(true)}>
                <Pencil className="h-3.5 w-3.5 mr-1" />Edit
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Contact Person" value={landlord.contact_person} />
            <Row label="PAN" value={landlord.pan_number} mono />
            <Row label="GSTIN" value={landlord.gstin} mono />
            <Row label="Email" value={landlord.email} />
            <Row label="Phone" value={landlord.phone} />
            {landlord.registered_address && (
              <div className="pt-2 border-t">
                <p className="text-muted-foreground mb-1">Registered Address</p>
                <p className="whitespace-pre-wrap">{landlord.registered_address}</p>
              </div>
            )}
            {landlord.notes && (
              <div className="pt-2 border-t">
                <p className="text-muted-foreground mb-1">Notes</p>
                <p className="text-sm whitespace-pre-wrap">{landlord.notes}</p>
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
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {ba.is_primary && <Badge variant="outline" className="text-xs">Primary</Badge>}
                    {ba.is_verified
                      ? <Badge className="text-xs bg-green-100 text-green-800">Verified</Badge>
                      : (isAdmin || userRole === "accounts") && (
                          <button
                            onClick={() => markBankAccountVerified(ba.id)}
                            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                          >
                            Mark verified
                          </button>
                        )
                    }
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* KYC Documents */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">KYC Documents</CardTitle>
          {(isAdmin || userRole === "accounts") && (
            <Button size="sm" variant="outline" onClick={() => setUploadDialog(true)}>
              <Upload className="h-3.5 w-3.5 mr-1" />Upload
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {docsLoading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => <div key={i} className="h-10 bg-muted animate-pulse rounded" />)}
            </div>
          ) : kycDocs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No documents uploaded yet</p>
          ) : (
            <div className="space-y-2">
              {kycDocs.map((doc) => (
                <div key={doc.path} className="flex items-center justify-between border rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{doc.name}</p>
                      <p className="text-xs text-muted-foreground">{DOC_TYPE_LABELS[doc.doc_type] ?? doc.doc_type}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    {doc.signed_url && (
                      <Button size="sm" variant="ghost" asChild>
                        <a href={doc.signed_url} target="_blank" rel="noopener noreferrer">
                          <Download className="h-3.5 w-3.5" />
                        </a>
                      </Button>
                    )}
                    {(isAdmin || userRole === "accounts") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => handleDeleteDoc(doc.path)}
                        disabled={deletingPath === doc.path}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

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

      {/* Upload KYC Document Dialog */}
      <Dialog open={uploadDialog} onOpenChange={(o) => { setUploadDialog(o); if (!o) { setUploadFile(null); setUploadDocType("pan_card"); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Upload KYC Document</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Document Type</Label>
              <Select value={uploadDocType} onValueChange={setUploadDocType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(DOC_TYPE_LABELS).map(([v, label]) => (
                    <SelectItem key={v} value={v}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>File <span className="text-muted-foreground text-xs">(PDF, JPG, PNG — max 50 MB)</span></Label>
              <Input
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.webp"
                onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                className="cursor-pointer"
              />
              {uploadFile && (
                <p className="text-xs text-muted-foreground">{uploadFile.name} · {(uploadFile.size / 1024).toFixed(0)} KB</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadDialog(false)}>Cancel</Button>
            <Button onClick={handleUploadDoc} disabled={!uploadFile || uploading}>
              {uploading ? "Uploading..." : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit KYC Details Dialog */}
      <Dialog open={kycDialog} onOpenChange={setKycDialog}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit KYC Details</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2 col-span-2">
              <Label>Full Name / Entity Name *</Label>
              <Input value={kycForm.name} onChange={(e) => setKycForm((f) => ({ ...f, name: e.target.value }))} required />
            </div>
            <div className="space-y-2 col-span-2">
              <Label>Contact Person</Label>
              <Input value={kycForm.contact_person} onChange={(e) => setKycForm((f) => ({ ...f, contact_person: e.target.value }))} placeholder="Name of the point of contact" />
            </div>
            <div className="space-y-2">
              <Label>PAN Number</Label>
              <Input value={kycForm.pan_number} onChange={(e) => setKycForm((f) => ({ ...f, pan_number: e.target.value.toUpperCase() }))} placeholder="ABCDE1234F" maxLength={10} className="font-mono" />
            </div>
            <div className="space-y-2">
              <Label>GSTIN</Label>
              <Input value={kycForm.gstin} onChange={(e) => setKycForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))} placeholder="22ABCDE1234F1Z5" maxLength={15} className="font-mono" />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input type="email" value={kycForm.email} onChange={(e) => setKycForm((f) => ({ ...f, email: e.target.value }))} placeholder="landlord@example.com" />
            </div>
            <div className="space-y-2">
              <Label>Phone</Label>
              <Input type="tel" value={kycForm.phone} onChange={(e) => setKycForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+91 9876543210" />
            </div>
            <div className="space-y-2 col-span-2">
              <Label>KYC Status</Label>
              <Select value={kycForm.kyc_status} onValueChange={(v) => setKycForm((f) => ({ ...f, kyc_status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="incomplete">Incomplete</SelectItem>
                  <SelectItem value="verified">Verified</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 col-span-2">
              <Label>Registered Address</Label>
              <Textarea value={kycForm.registered_address} onChange={(e) => setKycForm((f) => ({ ...f, registered_address: e.target.value }))} rows={3} placeholder="Full address including city, state, pincode" />
            </div>
            <div className="space-y-2 col-span-2">
              <Label>Notes</Label>
              <Textarea value={kycForm.notes} onChange={(e) => setKycForm((f) => ({ ...f, notes: e.target.value }))} rows={2} placeholder="Any additional notes about this landlord..." />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setKycDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveKyc} disabled={kycSaving || !kycForm.name}>
              {kycSaving ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
