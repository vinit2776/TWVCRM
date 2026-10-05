"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { Truck, Plus, Search, Pencil, X, Check, Upload, ShieldCheck, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { VENDOR_CATEGORIES, VENDOR_CATEGORY_LABELS } from "@/lib/constants";
import { toast } from "sonner";
import type { ProcurementVendor, VendorCategory } from "@/types";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { pushTrailEntry } from "@/lib/nav-trail";

const CATEGORY_COLORS: Record<string, string> = {
  pantry: "bg-orange-100 text-orange-800",
  maintenance: "bg-blue-100 text-blue-800",
  administration: "bg-purple-100 text-purple-800",
  general: "bg-gray-100 text-gray-700",
};

const emptyForm = {
  name: "",
  category: "general" as VendorCategory,
  contact_name: "",
  contact_phone: "",
  contact_email: "",
  address: "",
  gstin: "",
  payment_terms: "",
  notes: "",
  terms_and_conditions: "",
  is_service_provider: false,
  // Bank details
  bank_name: "",
  bank_account_holder: "",
  bank_account_number: "",
  bank_ifsc: "",
  // KYC
  pan_number: "",
  msme_number: "",
};

type DocField = "pan_doc_path" | "gst_cert_path" | "reg_cert_path" | "aadhar_doc_path" | "msme_cert_path";

const DOC_LABELS: Record<DocField, string> = {
  pan_doc_path: "PAN Card",
  gst_cert_path: "GST Certificate",
  reg_cert_path: "Registration Certificate",
  aadhar_doc_path: "Director / Proprietor Aadhar",
  msme_cert_path: "MSME Certificate",
};

function DocUploadRow({
  vendorId,
  field,
  currentPath,
  onUploaded,
}: {
  vendorId: string;
  field: DocField;
  currentPath?: string;
  onUploaded: (field: DocField, path: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
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
      toast.success(`${DOC_LABELS[field]} uploaded`);
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Upload failed");
    }
    setUploading(false);
  }

  async function handleView() {
    if (viewUrl) { window.open(viewUrl, "_blank"); return; }
    const res = await fetch(`/api/procurement/vendors/${vendorId}/documents?field=${field}`);
    if (res.ok) {
      const { data } = await res.json();
      setViewUrl(data.signedUrl);
      window.open(data.signedUrl, "_blank");
    } else {
      toast.error("Could not generate view link");
    }
  }

  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <span className="text-sm text-muted-foreground w-44 shrink-0">{DOC_LABELS[field]}</span>
      <div className="flex items-center gap-2">
        {currentPath ? (
          <>
            <Badge variant="secondary" className="text-xs">Uploaded</Badge>
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={handleView}>
              View
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
            >
              Replace
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
          >
            <Upload className="h-3 w-3 mr-1" />
            {uploading ? "Uploading…" : "Upload"}
          </Button>
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

export default function VendorsPage() {
  const [vendors, setVendors] = useState<ProcurementVendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editVendor, setEditVendor] = useState<ProcurementVendor | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [kycToggling, setKycToggling] = useState<string | null>(null);

  // Track doc paths for edit dialog (live-updated on upload without full reload)
  const [docPaths, setDocPaths] = useState<Partial<Record<DocField, string>>>({});

  const fetchVendors = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (categoryFilter) params.set("category", categoryFilter);
    if (includeInactive) params.set("include_inactive", "true");
    const res = await fetch(`/api/procurement/vendors?${params}`);
    if (res.ok) { const json = await res.json(); setVendors(json.data || []); }
    setLoading(false);
  }, [search, categoryFilter, includeInactive]);

  useEffect(() => { fetchVendors(); }, [fetchVendors]);

  function openCreate() {
    setEditVendor(null);
    setForm(emptyForm);
    setDocPaths({});
    setDialogOpen(true);
  }

  function openEdit(vendor: ProcurementVendor) {
    setEditVendor(vendor);
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
      is_service_provider: vendor.is_service_provider ?? false,
      bank_name: vendor.bank_name || "",
      bank_account_holder: vendor.bank_account_holder || "",
      bank_account_number: vendor.bank_account_number || "",
      bank_ifsc: vendor.bank_ifsc || "",
      pan_number: vendor.pan_number || "",
      msme_number: vendor.msme_number || "",
    });
    setDocPaths({
      pan_doc_path: vendor.pan_doc_path,
      gst_cert_path: vendor.gst_cert_path,
      reg_cert_path: vendor.reg_cert_path,
      aadhar_doc_path: vendor.aadhar_doc_path,
      msme_cert_path: vendor.msme_cert_path,
    });
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error("Vendor name is required"); return; }
    setSaving(true);
    const url = editVendor
      ? `/api/procurement/vendors/${editVendor.id}`
      : "/api/procurement/vendors";
    const method = editVendor ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
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
      toast.success(editVendor ? "Vendor updated" : "Vendor added");
      setDialogOpen(false);
      fetchVendors();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to save vendor");
    }
    setSaving(false);
  }

  async function toggleActive(vendor: ProcurementVendor) {
    const res = await fetch(`/api/procurement/vendors/${vendor.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !vendor.is_active }),
    });
    if (res.ok) {
      toast.success(vendor.is_active ? "Vendor deactivated" : "Vendor reactivated");
      fetchVendors();
    } else {
      toast.error("Failed to update vendor");
    }
  }

  async function toggleKyc(vendor: ProcurementVendor) {
    setKycToggling(vendor.id);
    const res = await fetch(`/api/procurement/vendors/${vendor.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kyc_verified: !vendor.kyc_verified }),
    });
    if (res.ok) {
      toast.success(vendor.kyc_verified ? "KYC mark removed" : "KYC marked as verified");
      fetchVendors();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to update KYC status");
    }
    setKycToggling(null);
  }

  return (
    <div className="space-y-4">
      <PageBreadcrumb resetTo={{ label: "Vendors" }} />
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Vendor Directory</h1>
          <p className="text-sm text-muted-foreground">{vendors.length} vendor{vendors.length !== 1 ? "s" : ""}</p>
        </div>
        <Button onClick={openCreate} className="shrink-0">
          <Plus className="h-4 w-4 mr-2" /> Add Vendor
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search vendors..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v === "all" ? "" : v)}>
          <SelectTrigger className="w-[160px]"><SelectValue placeholder="All Categories" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {VENDOR_CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>{VENDOR_CATEGORY_LABELS[c]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={includeInactive ? "default" : "outline"}
          size="sm"
          onClick={() => setIncludeInactive((v) => !v)}
          className="shrink-0"
        >
          {includeInactive ? "Hide Inactive" : "Show Inactive"}
        </Button>
      </div>

      {/* Table */}
      {loading ? <TableSkeleton rows={6} /> : vendors.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No vendors found"
          description="Add suppliers for pantry, maintenance, and administration."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Vendor</th>
                    <th className="text-left px-4 py-3 font-medium">Category</th>
                    <th className="text-left px-4 py-3 font-medium hidden md:table-cell">Contact</th>
                    <th className="text-left px-4 py-3 font-medium hidden lg:table-cell">Phone</th>
                    <th className="text-left px-4 py-3 font-medium hidden lg:table-cell">Payment Terms</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {vendors.map((v) => (
                    <tr key={v.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <Link
                          href={`/procurement/vendors/${v.id}`}
                          className="hover:underline"
                          onClick={() => pushTrailEntry({ href: `/procurement/vendors/${v.id}`, label: v.name })}
                        >
                          <p className="font-medium">{v.name}</p>
                        </Link>
                        {v.gstin && <p className="text-xs text-muted-foreground">GST: {v.gstin}</p>}
                        {v.kyc_verified && (
                          <span className="inline-flex items-center gap-1 text-xs text-green-700">
                            <ShieldCheck className="h-3 w-3" /> KYC Verified
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={CATEGORY_COLORS[v.category]}>
                          {VENDOR_CATEGORY_LABELS[v.category]}
                        </Badge>
                        {v.is_service_provider && (
                          <Badge variant="outline" className="ml-1 text-xs">Service provider</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell text-muted-foreground">
                        {v.contact_name || "—"}
                        {v.contact_email && <p className="text-xs">{v.contact_email}</p>}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground">
                        {v.contact_phone || "—"}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground">
                        {v.payment_terms || "—"}
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={v.is_active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-500"}>
                          {v.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="ghost" onClick={() => openEdit(v)}>
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => toggleKyc(v)}
                            disabled={kycToggling === v.id}
                            title={v.kyc_verified ? "Unmark KYC Verified" : "Mark KYC Verified"}
                          >
                            {v.kyc_verified
                              ? <ShieldCheck className="h-3 w-3 text-green-600" />
                              : <ShieldOff className="h-3 w-3 text-muted-foreground" />}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => toggleActive(v)}
                            title={v.is_active ? "Deactivate" : "Reactivate"}
                          >
                            {v.is_active ? <X className="h-3 w-3 text-red-500" /> : <Check className="h-3 w-3 text-green-600" />}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editVendor ? "Edit Vendor" : "Add Vendor"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 space-y-1">
                <Label>Vendor Name *</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Star Pantry Supplies"
                />
              </div>
              <div className="space-y-1">
                <Label>Category *</Label>
                <Select
                  value={form.category}
                  onValueChange={(v) => setForm((f) => ({ ...f, category: v as VendorCategory }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {VENDOR_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>{VENDOR_CATEGORY_LABELS[c]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2 flex items-start gap-2">
                <Checkbox
                  id="is_service_provider"
                  checked={form.is_service_provider}
                  onCheckedChange={(c) => setForm((f) => ({ ...f, is_service_provider: c === true }))}
                />
                <Label htmlFor="is_service_provider" className="font-normal leading-snug">
                  Service provider (internet, AMC, security…) — orders go through the service PO flow, not goods POs
                </Label>
              </div>
              <div className="space-y-1">
                <Label>Payment Terms</Label>
                <Input
                  value={form.payment_terms}
                  onChange={(e) => setForm((f) => ({ ...f, payment_terms: e.target.value }))}
                  placeholder="e.g. Net 30, Immediate"
                />
              </div>
              <div className="space-y-1">
                <Label>Contact Person</Label>
                <Input
                  value={form.contact_name}
                  onChange={(e) => setForm((f) => ({ ...f, contact_name: e.target.value }))}
                  placeholder="Name"
                />
              </div>
              <div className="space-y-1">
                <Label>Contact Phone</Label>
                <Input
                  value={form.contact_phone}
                  onChange={(e) => setForm((f) => ({ ...f, contact_phone: e.target.value }))}
                  placeholder="+91 98765 43210"
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label>Contact Email(s)</Label>
                {(() => {
                  const emails = form.contact_email ? form.contact_email.split(",").map((e) => e.trim()).filter(Boolean) : [];
                  return (
                    <>
                      {emails.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-1.5">
                          {emails.map((email) => (
                            <Badge key={email} variant="secondary" className="flex items-center gap-1 px-2 py-0.5 text-xs">
                              {email}
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = emails.filter((e) => e !== email).join(", ");
                                  setForm((f) => ({ ...f, contact_email: updated }));
                                }}
                                className="ml-0.5 rounded-full hover:bg-muted p-0.5"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </Badge>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-2">
                        <Input
                          type="email"
                          placeholder="vendor@example.com"
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === ",") {
                              e.preventDefault();
                              const val = (e.target as HTMLInputElement).value.trim().replace(/,$/, "");
                              if (!val) return;
                              if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) { toast.error("Invalid email address"); return; }
                              if (emails.includes(val)) { toast.error("Email already added"); return; }
                              const updated = [...emails, val].join(", ");
                              setForm((f) => ({ ...f, contact_email: updated }));
                              (e.target as HTMLInputElement).value = "";
                            }
                          }}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="shrink-0"
                          onClick={() => {
                            const input = document.querySelector<HTMLInputElement>('input[type="email"][placeholder="vendor@example.com"]');
                            if (!input) return;
                            const val = input.value.trim();
                            if (!val) return;
                            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) { toast.error("Invalid email address"); return; }
                            if (emails.includes(val)) { toast.error("Email already added"); return; }
                            const updated = [...emails, val].join(", ");
                            setForm((f) => ({ ...f, contact_email: updated }));
                            input.value = "";
                          }}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">Press Enter or click + to add multiple emails</p>
                    </>
                  );
                })()}
              </div>
              <div className="space-y-1">
                <Label>GSTIN</Label>
                <Input
                  value={form.gstin}
                  onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))}
                  placeholder="22AAAAA0000A1Z5"
                  maxLength={15}
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label>Address</Label>
                <Input
                  value={form.address}
                  onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                  placeholder="Street, City"
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label>Notes</Label>
                <Textarea
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="Any additional notes..."
                  rows={2}
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label>Terms &amp; Conditions</Label>
                <Textarea
                  value={form.terms_and_conditions}
                  onChange={(e) => setForm((f) => ({ ...f, terms_and_conditions: e.target.value }))}
                  placeholder="Payment and contractual terms that apply to POs with this vendor..."
                  rows={3}
                />
              </div>
            </div>

            {/* Bank Details */}
            <Separator />
            <div>
              <p className="text-sm font-semibold mb-3">Bank Details</p>
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2 space-y-1">
                  <Label>Bank Name</Label>
                  <Input
                    value={form.bank_name}
                    onChange={(e) => setForm((f) => ({ ...f, bank_name: e.target.value }))}
                    placeholder="e.g. HDFC Bank"
                  />
                </div>
                <div className="col-span-2 space-y-1">
                  <Label>Account Holder Name</Label>
                  <Input
                    value={form.bank_account_holder}
                    onChange={(e) => setForm((f) => ({ ...f, bank_account_holder: e.target.value }))}
                    placeholder="Name as per bank records"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Account Number</Label>
                  <Input
                    value={form.bank_account_number}
                    onChange={(e) => setForm((f) => ({ ...f, bank_account_number: e.target.value }))}
                    placeholder="Account number"
                  />
                </div>
                <div className="space-y-1">
                  <Label>IFSC Code</Label>
                  <Input
                    value={form.bank_ifsc}
                    onChange={(e) => setForm((f) => ({ ...f, bank_ifsc: e.target.value.toUpperCase() }))}
                    placeholder="HDFC0001234"
                    maxLength={11}
                  />
                </div>
              </div>
            </div>

            {/* Compliance & KYC */}
            <Separator />
            <div>
              <p className="text-sm font-semibold mb-3">Compliance &amp; KYC</p>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="space-y-1">
                  <Label>PAN Number</Label>
                  <Input
                    value={form.pan_number}
                    onChange={(e) => setForm((f) => ({ ...f, pan_number: e.target.value.toUpperCase() }))}
                    placeholder="AAAAA0000A"
                    maxLength={10}
                  />
                </div>
                <div className="space-y-1">
                  <Label>MSME Registration No.</Label>
                  <Input
                    value={form.msme_number}
                    onChange={(e) => setForm((f) => ({ ...f, msme_number: e.target.value }))}
                    placeholder="UDYAM-XX-00-0000000"
                  />
                </div>
              </div>

              {/* Document uploads — only shown when editing an existing vendor */}
              {editVendor ? (
                <div className="border rounded-md p-3 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground mb-2">Documents</p>
                  {(Object.keys(DOC_LABELS) as DocField[]).map((field) => (
                    <DocUploadRow
                      key={field}
                      vendorId={editVendor.id}
                      field={field}
                      currentPath={docPaths[field]}
                      onUploaded={(f, path) => setDocPaths((prev) => ({ ...prev, [f]: path }))}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Save the vendor first, then edit it to upload compliance documents.</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : editVendor ? "Update Vendor" : "Add Vendor"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
