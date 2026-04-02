"use client";

import { useState, useEffect, useCallback } from "react";
import { Truck, Plus, Search, Pencil, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
};

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

  return (
    <div className="space-y-4">
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
                        <p className="font-medium">{v.name}</p>
                        {v.gstin && <p className="text-xs text-muted-foreground">GST: {v.gstin}</p>}
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={CATEGORY_COLORS[v.category]}>
                          {VENDOR_CATEGORY_LABELS[v.category]}
                        </Badge>
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
