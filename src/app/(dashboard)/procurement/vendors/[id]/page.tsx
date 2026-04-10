"use client";

import { use, useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, Pencil, ShieldCheck, ShieldOff, Upload,
  Building2, Phone, Mail, MapPin, CreditCard, FileText,
  Banknote, X, Check, Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { VENDOR_CATEGORIES, VENDOR_CATEGORY_LABELS } from "@/lib/constants";
import { toast } from "sonner";
import type { ProcurementVendor, VendorCategory } from "@/types";

const CATEGORY_COLORS: Record<string, string> = {
  pantry: "bg-orange-100 text-orange-800",
  maintenance: "bg-blue-100 text-blue-800",
  administration: "bg-purple-100 text-purple-800",
  general: "bg-gray-100 text-gray-700",
};

type DocField = "pan_doc_path" | "gst_cert_path" | "reg_cert_path" | "aadhar_doc_path" | "msme_cert_path";

const DOC_LABELS: Record<DocField, string> = {
  pan_doc_path: "PAN Card",
  gst_cert_path: "GST Certificate",
  reg_cert_path: "Registration Certificate",
  aadhar_doc_path: "Director / Proprietor Aadhar",
  msme_cert_path: "MSME Certificate",
};

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4 py-2.5 border-b last:border-0">
      <span className="text-sm text-muted-foreground w-44 shrink-0">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}

function DocRow({
  vendorId,
  field,
  currentPath,
  onUploaded,
}: {
  vendorId: string;
  field: DocField;
  currentPath?: string | null;
  onUploaded: (field: DocField, path: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("field", field);
    const res = await fetch(`/api/procurement/vendors/${vendorId}/documents`, { method: "POST", body: fd });
    if (res.ok) {
      const { data } = await res.json();
      onUploaded(field, data.path);
      const msg = data.compressed
        ? `Uploaded & compressed (${data.original_size_kb} KB → ${data.final_size_kb} KB)`
        : `Uploaded (${data.final_size_kb} KB)`;
      toast.success(msg);
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Upload failed");
    }
    setUploading(false);
  }

  async function handleView() {
    const res = await fetch(`/api/procurement/vendors/${vendorId}/documents?field=${field}`);
    if (res.ok) {
      const { data } = await res.json();
      window.open(data.signedUrl, "_blank");
    } else {
      toast.error("Could not generate view link");
    }
  }

  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b last:border-0">
      <div className="flex items-center gap-3">
        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm">{DOC_LABELS[field]}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {currentPath ? (
          <>
            <Badge variant="secondary" className="text-xs bg-green-50 text-green-700 border-green-200">
              <Check className="h-3 w-3 mr-1" /> Uploaded
            </Badge>
            <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={handleView}>
              View
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
            >
              Replace
            </Button>
          </>
        ) : (
          <>
            <Badge variant="outline" className="text-xs text-muted-foreground">Missing</Badge>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
            >
              <Upload className="h-3 w-3 mr-1" />
              {uploading ? "Uploading…" : "Upload"}
            </Button>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept=".pdf,.jpg,.jpeg,.png,.webp"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
        />
      </div>
    </div>
  );
}

export default function VendorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [vendor, setVendor] = useState<ProcurementVendor | null>(null);
  const [loading, setLoading] = useState(true);
  const [docPaths, setDocPaths] = useState<Partial<Record<DocField, string>>>({});
  const [kycToggling, setKycToggling] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const emptyForm = {
    name: "", category: "general" as VendorCategory,
    contact_name: "", contact_phone: "", contact_email: "",
    address: "", gstin: "", payment_terms: "", notes: "", terms_and_conditions: "",
    bank_name: "", bank_account_holder: "", bank_account_number: "", bank_ifsc: "",
    pan_number: "", msme_number: "",
  };
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const fetchVendor = useCallback(async () => {
    const res = await fetch(`/api/procurement/vendors/${id}`);
    if (res.ok) {
      const { data } = await res.json();
      setVendor(data);
      setDocPaths({
        pan_doc_path: data.pan_doc_path,
        gst_cert_path: data.gst_cert_path,
        reg_cert_path: data.reg_cert_path,
        aadhar_doc_path: data.aadhar_doc_path,
        msme_cert_path: data.msme_cert_path,
      });
    } else {
      toast.error("Vendor not found");
      router.push("/procurement/vendors");
    }
    setLoading(false);
  }, [id, router]);

  useEffect(() => { fetchVendor(); }, [fetchVendor]);

  function openEdit() {
    if (!vendor) return;
    setForm({
      name: vendor.name,
      category: vendor.category,
      contact_name: vendor.contact_name || "",
      contact_phone: vendor.contact_phone || "",
      contact_email: vendor.contact_email || "",
      address: vendor.address || "",
      gstin: vendor.gstin || "",
      payment_terms: vendor.payment_terms || "",
      notes: vendor.notes || "",
      terms_and_conditions: vendor.terms_and_conditions || "",
      bank_name: vendor.bank_name || "",
      bank_account_holder: vendor.bank_account_holder || "",
      bank_account_number: vendor.bank_account_number || "",
      bank_ifsc: vendor.bank_ifsc || "",
      pan_number: vendor.pan_number || "",
      msme_number: vendor.msme_number || "",
    });
    setEditOpen(true);
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error("Vendor name is required"); return; }
    setSaving(true);
    const res = await fetch(`/api/procurement/vendors/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        contact_email: form.contact_email || undefined,
        bank_name: form.bank_name || undefined,
        bank_account_holder: form.bank_account_holder || undefined,
        bank_account_number: form.bank_account_number || undefined,
        bank_ifsc: form.bank_ifsc || undefined,
        pan_number: form.pan_number || undefined,
        msme_number: form.msme_number || undefined,
      }),
    });
    if (res.ok) {
      toast.success("Vendor updated");
      setEditOpen(false);
      fetchVendor();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to save");
    }
    setSaving(false);
  }

  async function toggleKyc() {
    if (!vendor) return;
    setKycToggling(true);
    const res = await fetch(`/api/procurement/vendors/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kyc_verified: !vendor.kyc_verified }),
    });
    if (res.ok) {
      toast.success(vendor.kyc_verified ? "KYC mark removed" : "KYC marked as verified");
      fetchVendor();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to update KYC");
    }
    setKycToggling(false);
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-32 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  if (!vendor) return null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/procurement/vendors">
          <Button variant="ghost" size="sm" className="gap-1.5">
            <ArrowLeft className="h-4 w-4" /> Vendors
          </Button>
        </Link>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold">{vendor.name}</h1>
            <Badge className={CATEGORY_COLORS[vendor.category]}>
              {VENDOR_CATEGORY_LABELS[vendor.category]}
            </Badge>
            <Badge className={vendor.is_active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-500"}>
              {vendor.is_active ? "Active" : "Inactive"}
            </Badge>
            {vendor.kyc_verified && (
              <Badge className="bg-green-50 text-green-700 border border-green-200 gap-1">
                <ShieldCheck className="h-3 w-3" /> KYC Verified
              </Badge>
            )}
          </div>
          {vendor.gstin && (
            <p className="text-sm text-muted-foreground">GSTIN: {vendor.gstin}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={toggleKyc} disabled={kycToggling}>
            {vendor.kyc_verified
              ? <><ShieldOff className="h-4 w-4 mr-1.5" /> Unmark KYC</>
              : <><ShieldCheck className="h-4 w-4 mr-1.5" /> Mark KYC Verified</>}
          </Button>
          <Button size="sm" onClick={openEdit}>
            <Pencil className="h-4 w-4 mr-1.5" /> Edit Vendor
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="bank">Bank Details</TabsTrigger>
          <TabsTrigger value="compliance">
            Compliance &amp; Docs
            {(() => {
              const uploaded = Object.values(docPaths).filter(Boolean).length;
              return uploaded > 0 ? (
                <Badge variant="secondary" className="ml-1.5 text-xs px-1.5 py-0">{uploaded}/5</Badge>
              ) : null;
            })()}
          </TabsTrigger>
        </TabsList>

        {/* General Tab */}
        <TabsContent value="general" className="mt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Building2 className="h-4 w-4" /> Contact Information
              </CardTitle>
            </CardHeader>
            <CardContent>
              <InfoRow label="Contact Person" value={vendor.contact_name} />
              <InfoRow label="Phone" value={vendor.contact_phone} />
              <InfoRow label="Email" value={vendor.contact_email} />
              <InfoRow label="Address" value={vendor.address} />
              <InfoRow label="GSTIN" value={vendor.gstin} />
              <InfoRow label="Payment Terms" value={vendor.payment_terms} />
              {!vendor.contact_name && !vendor.contact_phone && !vendor.contact_email && !vendor.address && (
                <p className="text-sm text-muted-foreground py-2">No contact details on file.</p>
              )}
            </CardContent>
          </Card>

          {(vendor.notes || vendor.terms_and_conditions) && (
            <Card className="mt-3">
              <CardContent className="pt-4">
                {vendor.notes && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Notes</p>
                    <p className="text-sm whitespace-pre-wrap">{vendor.notes}</p>
                  </div>
                )}
                {vendor.notes && vendor.terms_and_conditions && <Separator className="my-3" />}
                {vendor.terms_and_conditions && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Terms &amp; Conditions</p>
                    <p className="text-sm whitespace-pre-wrap">{vendor.terms_and_conditions}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Bank Details Tab */}
        <TabsContent value="bank" className="mt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Banknote className="h-4 w-4" /> Bank Details
              </CardTitle>
            </CardHeader>
            <CardContent>
              {vendor.bank_name || vendor.bank_account_number ? (
                <>
                  <InfoRow label="Bank Name" value={vendor.bank_name} />
                  <InfoRow label="Account Holder" value={vendor.bank_account_holder} />
                  <InfoRow label="Account Number" value={vendor.bank_account_number} />
                  <InfoRow label="IFSC Code" value={vendor.bank_ifsc} />
                </>
              ) : (
                <div className="py-6 text-center">
                  <Banknote className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">No bank details on file.</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={openEdit}>
                    Add Bank Details
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Compliance & Docs Tab */}
        <TabsContent value="compliance" className="mt-4 space-y-3">
          {/* KYC Status */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" /> KYC Status
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <div>
                  {vendor.kyc_verified ? (
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium text-green-700">KYC Verified</p>
                      {vendor.kyc_verified_at && (
                        <p className="text-xs text-muted-foreground">
                          Verified on {new Date(vendor.kyc_verified_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">Not yet verified</p>
                  )}
                </div>
                <Button variant="outline" size="sm" onClick={toggleKyc} disabled={kycToggling}>
                  {vendor.kyc_verified
                    ? <><ShieldOff className="h-3.5 w-3.5 mr-1.5" /> Unmark</>
                    : <><ShieldCheck className="h-3.5 w-3.5 mr-1.5" /> Mark as Verified</>}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Registration Numbers */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <CreditCard className="h-4 w-4" /> Registration Numbers
              </CardTitle>
            </CardHeader>
            <CardContent>
              {vendor.pan_number || vendor.msme_number ? (
                <>
                  <InfoRow label="PAN Number" value={vendor.pan_number} />
                  <InfoRow label="MSME Registration No." value={vendor.msme_number} />
                </>
              ) : (
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">No registration numbers on file.</p>
                  <Button variant="outline" size="sm" onClick={openEdit}>Add</Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Documents */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4" /> Documents
                <span className="text-sm font-normal text-muted-foreground ml-1">
                  {Object.values(docPaths).filter(Boolean).length} of 5 uploaded
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {(Object.keys(DOC_LABELS) as DocField[]).map((field) => (
                <DocRow
                  key={field}
                  vendorId={id}
                  field={field}
                  currentPath={docPaths[field]}
                  onUploaded={(f, path) => setDocPaths((prev) => ({ ...prev, [f]: path }))}
                />
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Vendor</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 space-y-1">
                <Label>Vendor Name *</Label>
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>Category *</Label>
                <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v as VendorCategory }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {VENDOR_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>{VENDOR_CATEGORY_LABELS[c]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Payment Terms</Label>
                <Input value={form.payment_terms} onChange={(e) => setForm((f) => ({ ...f, payment_terms: e.target.value }))} placeholder="e.g. Net 30" />
              </div>
              <div className="space-y-1">
                <Label>Contact Person</Label>
                <Input value={form.contact_name} onChange={(e) => setForm((f) => ({ ...f, contact_name: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>Contact Phone</Label>
                <Input value={form.contact_phone} onChange={(e) => setForm((f) => ({ ...f, contact_phone: e.target.value }))} />
              </div>
              <div className="col-span-2 space-y-1">
                <Label>Contact Email</Label>
                <Input type="email" value={form.contact_email} onChange={(e) => setForm((f) => ({ ...f, contact_email: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>GSTIN</Label>
                <Input value={form.gstin} onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))} maxLength={15} />
              </div>
              <div className="col-span-2 space-y-1">
                <Label>Address</Label>
                <Input value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
              </div>
              <div className="col-span-2 space-y-1">
                <Label>Notes</Label>
                <Textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} />
              </div>
              <div className="col-span-2 space-y-1">
                <Label>Terms &amp; Conditions</Label>
                <Textarea value={form.terms_and_conditions} onChange={(e) => setForm((f) => ({ ...f, terms_and_conditions: e.target.value }))} rows={2} />
              </div>
            </div>

            <Separator />
            <p className="text-sm font-semibold">Bank Details</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 space-y-1">
                <Label>Bank Name</Label>
                <Input value={form.bank_name} onChange={(e) => setForm((f) => ({ ...f, bank_name: e.target.value }))} />
              </div>
              <div className="col-span-2 space-y-1">
                <Label>Account Holder Name</Label>
                <Input value={form.bank_account_holder} onChange={(e) => setForm((f) => ({ ...f, bank_account_holder: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>Account Number</Label>
                <Input value={form.bank_account_number} onChange={(e) => setForm((f) => ({ ...f, bank_account_number: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>IFSC Code</Label>
                <Input value={form.bank_ifsc} onChange={(e) => setForm((f) => ({ ...f, bank_ifsc: e.target.value.toUpperCase() }))} maxLength={11} />
              </div>
            </div>

            <Separator />
            <p className="text-sm font-semibold">Compliance</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>PAN Number</Label>
                <Input value={form.pan_number} onChange={(e) => setForm((f) => ({ ...f, pan_number: e.target.value.toUpperCase() }))} maxLength={10} />
              </div>
              <div className="space-y-1">
                <Label>MSME Registration No.</Label>
                <Input value={form.msme_number} onChange={(e) => setForm((f) => ({ ...f, msme_number: e.target.value }))} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Update Vendor"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
