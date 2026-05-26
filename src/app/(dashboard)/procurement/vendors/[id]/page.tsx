"use client";

import { use, useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, Pencil, ShieldCheck, ShieldOff, Upload,
  Building2, CreditCard, FileText,
  Banknote, Check, Tag, ExternalLink,
  BarChart2, AlertCircle, ShoppingCart, ChevronRight, ChevronDown,
} from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
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
import { VENDOR_CATEGORIES, VENDOR_CATEGORY_LABELS, PROCUREMENT_DEPARTMENT_LABELS } from "@/lib/constants";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
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

function InfoRow({ label, value, emptyText }: { label: string; value?: string | null; emptyText?: string }) {
  if (!value && !emptyText) return null;
  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4 py-2.5 border-b last:border-0">
      <span className="text-sm text-muted-foreground w-44 shrink-0">{label}</span>
      <span className={`text-sm ${!value ? "text-muted-foreground italic" : ""}`}>{value || emptyText}</span>
    </div>
  );
}

function DocRow({
  vendorId,
  field,
  currentPath,
  onUploaded,
  readOnly = false,
}: {
  vendorId: string;
  field: DocField;
  currentPath?: string | null;
  onUploaded: (field: DocField, path: string) => void;
  readOnly?: boolean;
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
            {!readOnly && (
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
            )}
          </>
        ) : (
          <>
            <Badge variant="outline" className="text-xs text-muted-foreground">Missing</Badge>
            {!readOnly && (
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
            )}
          </>
        )}
        {!readOnly && (
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            accept=".pdf,.jpg,.jpeg,.png,.webp"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
          />
        )}
      </div>
    </div>
  );
}

export default function VendorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [vendor, setVendor] = useState<ProcurementVendor | null>(null);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [docPaths, setDocPaths] = useState<Partial<Record<DocField, string>>>({});
  const [kycToggling, setKycToggling] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // Email recovered from audit trail when contact_email is missing
  const [lastEmailUsed, setLastEmailUsed] = useState<string | null>(null);
  const [restoringEmail, setRestoringEmail] = useState(false);

  // Price history
  const [prices, setPrices] = useState<Array<{
    id: string; item_id: string; price: number; gst_rate: number;
    last_po_id?: string; last_po_number?: string; updated_at: string;
    procurement_items?: { id: string; name: string; unit: string; department: string; standard_price?: number } | null;
  }>>([]);
  const [pricesLoading, setPricesLoading] = useState(false);

  // Activity & Insights
  type PoDisplayRow = {
    id: string;
    po_number: string;
    po_type: string;
    status: string;
    total_ordered_amount: number | null;
    ordered_at: string | null;
    created_at: string;
    pr_id: string | null;
    pr: { pr_number: string; department: string } | null;
    item_count: number;
    top_items: string[];
  };
  type MonthBucket = {
    label: string;
    amount: number;
    year: number;
    month: number;
    start: string;
    end: string;
    count: number;
  };
  type InsightsData = {
    spendByMonth: MonthBucket[];
    totalPoValue: number;
    totalPoCount: number;
    poStatusCounts: Record<string, number>;
    recentPos: PoDisplayRow[];
    allPosForDisplay: PoDisplayRow[];
    topItems: Array<{ name: string; qty: number; value: number }>;
    totalBilled: number;
    totalPaid: number;
    totalOutstanding: number;
    billCount: number;
    overdueCount: number;
    overdueAmount: number;
    avgPaymentTermDays: number | null;
    recentBills: Array<{ id: string; bill_number: string; invoice_number: string | null; total_amount: number | null; amount_paid: number | null; due_date: string | null; payment_status: string; approval_status: string; created_at: string }>;
  };
  const [insights, setInsights] = useState<InsightsData | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("general");
  const [drillMonth, setDrillMonth] = useState<MonthBucket | null>(null);
  const [poFilter, setPoFilter] = useState<string>("all");

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
      setLastEmailUsed(data.lastPaymentEmailTo ?? null);
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

  useEffect(() => {
    fetchVendor();
    fetch("/api/me").then((r) => r.json()).then((d) => setUserRole(d.role ?? null));
  }, [fetchVendor]);
  const isReadOnly = userRole === "accounts";

  const fetchPrices = useCallback(async () => {
    setPricesLoading(true);
    const res = await fetch(`/api/procurement/vendor-prices?vendor_id=${id}`);
    if (res.ok) {
      const { data } = await res.json();
      setPrices(data ?? []);
    }
    setPricesLoading(false);
  }, [id]);

  const fetchInsights = useCallback(async () => {
    if (insights || insightsLoading) return;
    setInsightsLoading(true);
    setInsightsError(null);
    try {
      const res = await fetch(`/api/procurement/vendors/${id}/insights`);
      if (res.ok) {
        const { data } = await res.json();
        setInsights(data);
      } else {
        const err = await res.json().catch(() => null);
        const msg = err?.error || `Failed to load analytics (${res.status})`;
        setInsightsError(msg);
        toast.error(msg);
      }
    } catch {
      setInsightsError("Network error loading analytics");
      toast.error("Network error loading analytics");
    } finally {
      setInsightsLoading(false);
    }
  }, [id, insights, insightsLoading]);

  // Trigger lazy-loads when tab changes (more reliable than onClick on each trigger)
  useEffect(() => {
    if ((activeTab === "po-analytics" || activeTab === "activity") && !insights && !insightsLoading) {
      fetchInsights();
    }
    if (activeTab === "prices" && prices.length === 0 && !pricesLoading) {
      fetchPrices();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

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
        {!isReadOnly && (
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
        )}
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
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
          <TabsTrigger value="prices">
            Price History
            {prices.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs px-1.5 py-0">{prices.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="po-analytics">
            PO Analytics
            {insights && (
              <Badge variant="secondary" className="ml-1.5 text-xs px-1.5 py-0">{insights.totalPoCount}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="activity">
            Activity &amp; Insights
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
              <InfoRow label="Email" value={vendor.contact_email} emptyText="Not set" />
              <InfoRow label="Address" value={vendor.address} />
              <InfoRow label="GSTIN" value={vendor.gstin} />
              <InfoRow label="Payment Terms" value={vendor.payment_terms} />
              {!vendor.contact_name && !vendor.contact_phone && !vendor.contact_email && !vendor.address && (
                <p className="text-sm text-muted-foreground py-2">No contact details on file.</p>
              )}
              {/* Recovery banner: email is missing but was used in a past payment confirmation */}
              {!vendor.contact_email && lastEmailUsed && (
                <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5">
                  <p className="text-xs text-amber-800">
                    Last payment confirmation used <span className="font-semibold">{lastEmailUsed}</span> — restore it to the vendor profile?
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 h-7 text-xs border-amber-300 text-amber-800 hover:bg-amber-100"
                    disabled={restoringEmail}
                    onClick={async () => {
                      setRestoringEmail(true);
                      const res = await fetch(`/api/procurement/vendors/${id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ contact_email: lastEmailUsed }),
                      });
                      if (res.ok) {
                        toast.success("Email restored");
                        fetchVendor();
                      } else {
                        const err = await res.json().catch(() => null);
                        toast.error(err?.error || "Failed to restore email");
                      }
                      setRestoringEmail(false);
                    }}
                  >
                    {restoringEmail ? "Saving…" : "Restore"}
                  </Button>
                </div>
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
                  {!isReadOnly && (
                    <Button variant="outline" size="sm" className="mt-3" onClick={openEdit}>
                      Add Bank Details
                    </Button>
                  )}
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
                          Verified on {new Date(vendor.kyc_verified_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">Not yet verified</p>
                  )}
                </div>
                {!isReadOnly && (
                  <Button variant="outline" size="sm" onClick={toggleKyc} disabled={kycToggling}>
                    {vendor.kyc_verified
                      ? <><ShieldOff className="h-3.5 w-3.5 mr-1.5" /> Unmark</>
                      : <><ShieldCheck className="h-3.5 w-3.5 mr-1.5" /> Mark as Verified</>}
                  </Button>
                )}
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
                  {!isReadOnly && <Button variant="outline" size="sm" onClick={openEdit}>Add</Button>}
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
                  readOnly={isReadOnly}
                />
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Price History Tab */}
        <TabsContent value="prices" className="mt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Tag className="h-4 w-4" /> Last Known Prices
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">
                Prices are recorded automatically when a Purchase Order with this vendor is marked as Ordered.
                These are used to pre-fill the unit price on new POs.
              </p>

              {pricesLoading ? (
                <div className="space-y-2">
                  {[1,2,3].map((i) => (
                    <div key={i} className="h-8 bg-muted animate-pulse rounded" />
                  ))}
                </div>
              ) : prices.length === 0 ? (
                <div className="py-8 text-center">
                  <Tag className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">No price history yet.</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Prices will appear here after the first Purchase Order with this vendor is confirmed.
                  </p>
                </div>
              ) : (
                <div className="rounded-md border overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="px-4 py-2.5 text-left font-medium">Item</th>
                        <th className="px-4 py-2.5 text-left font-medium hidden sm:table-cell">Department</th>
                        <th className="px-4 py-2.5 text-left font-medium hidden sm:table-cell">Unit</th>
                        <th className="px-4 py-2.5 text-right font-medium">Last Price</th>
                        <th className="px-4 py-2.5 text-right font-medium hidden md:table-cell">GST %</th>
                        <th className="px-4 py-2.5 text-left font-medium hidden lg:table-cell">Last PO</th>
                        <th className="px-4 py-2.5 text-left font-medium hidden lg:table-cell">Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {prices.map((p) => (
                        <tr key={p.id} className="border-b last:border-0 hover:bg-muted/20">
                          <td className="px-4 py-2.5 font-medium">
                            {p.procurement_items?.name ?? "—"}
                          </td>
                          <td className="px-4 py-2.5 hidden sm:table-cell text-muted-foreground text-xs">
                            {p.procurement_items?.department
                              ? (PROCUREMENT_DEPARTMENT_LABELS[p.procurement_items.department] ?? p.procurement_items.department)
                              : "—"}
                          </td>
                          <td className="px-4 py-2.5 hidden sm:table-cell text-muted-foreground text-xs uppercase">
                            {p.procurement_items?.unit ?? "—"}
                          </td>
                          <td className="px-4 py-2.5 text-right font-medium">
                            {formatCurrency(p.price)}
                            {p.procurement_items?.standard_price && p.price < p.procurement_items.standard_price && (
                              <span className="ml-1 text-xs text-green-600">↓</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right hidden md:table-cell text-muted-foreground">
                            {p.gst_rate > 0 ? `${p.gst_rate}%` : "—"}
                          </td>
                          <td className="px-4 py-2.5 hidden lg:table-cell">
                            {p.last_po_number ? (
                              <a
                                href={`/procurement/orders/${p.last_po_id}`}
                                className="text-primary hover:underline text-xs font-mono flex items-center gap-1"
                              >
                                {p.last_po_number}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : "—"}
                          </td>
                          <td className="px-4 py-2.5 hidden lg:table-cell text-muted-foreground text-xs">
                            {formatDate(p.updated_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* PO Analytics Tab */}
        <TabsContent value="po-analytics" className="mt-4 space-y-4">
          {insightsLoading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="animate-pulse bg-muted rounded-lg h-32" />
              ))}
            </div>
          ) : insightsError ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
              <AlertCircle className="h-8 w-8 text-red-400" />
              <p className="text-sm text-red-600">{insightsError}</p>
            </div>
          ) : !insights ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
              <ShoppingCart className="h-8 w-8" />
              <p className="text-sm">No PO data available</p>
            </div>
          ) : (
            <>
              {/* KPI summary */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: "Total POs", value: String(insights.totalPoCount), sub: "excl. cancelled" },
                  { label: "Total PO Value", value: `₹${(insights.totalPoValue / 1000).toFixed(1)}K`, sub: "all time" },
                  { label: "Active (Ordered)", value: String(insights.poStatusCounts["ordered"] ?? 0), sub: "awaiting delivery" },
                  { label: "Delivered", value: String(insights.poStatusCounts["delivered"] ?? 0 + (insights.poStatusCounts["completed"] ?? 0)), sub: "completed" },
                ].map(({ label, value, sub }) => (
                  <Card key={label}>
                    <CardContent className="p-4">
                      <p className="text-xs text-muted-foreground mb-1">{label}</p>
                      <p className="text-xl font-semibold">{value}</p>
                      <p className="text-xs mt-0.5 text-muted-foreground">{sub}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* 12-month spend chart */}
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Monthly PO Value — Last 12 Months</CardTitle>
                    <p className="text-xs text-muted-foreground">Click any bar to drill down</p>
                  </div>
                </CardHeader>
                <CardContent>
                  {(() => {
                    const max = Math.max(...insights.spendByMonth.map((m) => m.amount), 1);
                    const total12m = insights.spendByMonth.reduce((s, m) => s + m.amount, 0);
                    const currentIdx = insights.spendByMonth.length - 1;
                    return (
                      <div className="space-y-1.5">
                        {insights.spendByMonth.map((m, idx) => {
                          const pct = (m.amount / max) * 100;
                          const isCurrent = idx === currentIdx;
                          const hasData = m.amount > 0 || m.count > 0;
                          return (
                            <button
                              key={m.label}
                              className={`w-full flex items-center gap-3 rounded px-1 py-0.5 transition-colors text-left ${hasData ? "hover:bg-muted/60 cursor-pointer" : "cursor-default"}`}
                              onClick={() => hasData && setDrillMonth(m)}
                              disabled={!hasData}
                            >
                              <span className="text-xs text-muted-foreground w-12 shrink-0 tabular-nums">{m.label}</span>
                              <div className="flex-1 h-7 bg-muted rounded overflow-hidden relative">
                                <div
                                  className={`h-full rounded transition-all ${isCurrent ? "bg-primary" : "bg-primary/45"}`}
                                  style={{ width: `${pct}%` }}
                                />
                                {m.count > 0 && (
                                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                                    {m.count} PO{m.count > 1 ? "s" : ""}
                                  </span>
                                )}
                              </div>
                              <span className="text-xs w-20 text-right shrink-0 tabular-nums font-medium">
                                {m.amount > 0 ? `₹${(m.amount / 1000).toFixed(1)}K` : "—"}
                              </span>
                              {hasData && <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
                            </button>
                          );
                        })}
                        <div className="pt-1 text-xs text-muted-foreground text-right border-t mt-2">
                          12-month total: <span className="font-semibold text-foreground">₹{(total12m / 1000).toFixed(1)}K</span>
                        </div>
                      </div>
                    );
                  })()}
                </CardContent>
              </Card>

              {/* Full PO list */}
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <CardTitle className="text-base">
                      All Purchase Orders
                      <span className="ml-2 text-sm font-normal text-muted-foreground">({insights.allPosForDisplay.length})</span>
                    </CardTitle>
                    {/* Status filter */}
                    <div className="flex gap-1 flex-wrap">
                      {["all", "draft", "ordered", "delivered", "cancelled"].map((s) => (
                        <button
                          key={s}
                          onClick={() => setPoFilter(s)}
                          className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${poFilter === s ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted"}`}
                        >
                          {s === "all" ? `All (${insights.allPosForDisplay.length})` : (
                            `${s.charAt(0).toUpperCase() + s.slice(1)} (${insights.allPosForDisplay.filter((p) => p.status === s).length})`
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  {(() => {
                    const filtered = poFilter === "all"
                      ? insights.allPosForDisplay
                      : insights.allPosForDisplay.filter((p) => p.status === poFilter);
                    if (filtered.length === 0) {
                      return <p className="text-sm text-muted-foreground py-8 text-center">No purchase orders found</p>;
                    }
                    return (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b bg-muted/30">
                              <th className="px-4 py-2.5 text-left font-medium">PO Number</th>
                              <th className="px-4 py-2.5 text-left font-medium hidden sm:table-cell">Department</th>
                              <th className="px-4 py-2.5 text-left font-medium hidden md:table-cell">Items</th>
                              <th className="px-4 py-2.5 text-left font-medium">Status</th>
                              <th className="px-4 py-2.5 text-left font-medium hidden sm:table-cell">Date</th>
                              <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filtered.map((po) => (
                              <tr
                                key={po.id}
                                className="border-b last:border-0 hover:bg-muted/30 cursor-pointer"
                                onClick={() => router.push(`/procurement/orders/${po.id}`)}
                              >
                                <td className="px-4 py-2.5">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-mono text-xs font-semibold">{po.po_number}</span>
                                    <ExternalLink className="h-3 w-3 text-muted-foreground" />
                                  </div>
                                  {po.pr?.pr_number && (
                                    <p className="text-[10px] text-muted-foreground mt-0.5">MR: {po.pr.pr_number}</p>
                                  )}
                                </td>
                                <td className="px-4 py-2.5 hidden sm:table-cell text-xs text-muted-foreground capitalize">
                                  {po.pr?.department
                                    ? po.pr.department.charAt(0).toUpperCase() + po.pr.department.slice(1)
                                    : "—"}
                                </td>
                                <td className="px-4 py-2.5 hidden md:table-cell">
                                  <div className="flex flex-col gap-0.5">
                                    {po.top_items.slice(0, 2).map((name, i) => (
                                      <span key={i} className="text-[11px] text-muted-foreground truncate max-w-[160px]">{name}</span>
                                    ))}
                                    {po.item_count > 2 && (
                                      <span className="text-[10px] text-muted-foreground">+{po.item_count - 2} more</span>
                                    )}
                                  </div>
                                </td>
                                <td className="px-4 py-2.5">
                                  <Badge className={
                                    po.status === "delivered" || po.status === "completed" ? "bg-green-100 text-green-800" :
                                    po.status === "ordered" ? "bg-blue-100 text-blue-800" :
                                    po.status === "cancelled" ? "bg-red-100 text-red-800" :
                                    po.status === "draft" ? "bg-gray-100 text-gray-700" :
                                    "bg-amber-100 text-amber-800"
                                  } variant="secondary">
                                    {po.status.charAt(0).toUpperCase() + po.status.slice(1)}
                                  </Badge>
                                </td>
                                <td className="px-4 py-2.5 hidden sm:table-cell text-xs text-muted-foreground tabular-nums">
                                  {formatDate(po.created_at)}
                                </td>
                                <td className="px-4 py-2.5 text-right font-medium tabular-nums">
                                  {po.total_ordered_amount != null ? formatCurrency(po.total_ordered_amount) : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="border-t bg-muted/20">
                              <td colSpan={5} className="px-4 py-2 text-xs text-muted-foreground font-medium">
                                {filtered.length} order{filtered.length !== 1 ? "s" : ""}
                              </td>
                              <td className="px-4 py-2 text-right text-xs font-semibold tabular-nums">
                                {formatCurrency(filtered.reduce((s, p) => s + Number(p.total_ordered_amount ?? 0), 0))}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    );
                  })()}
                </CardContent>
              </Card>
            </>
          )}

          {/* Drill-down Sheet — POs for selected month */}
          <Sheet open={!!drillMonth} onOpenChange={(v) => { if (!v) setDrillMonth(null); }}>
            <SheetContent side="right" className="w-full sm:max-w-xl flex flex-col p-0 gap-0">
              <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
                <SheetTitle className="text-base flex items-center gap-2">
                  <ShoppingCart className="h-4 w-4" />
                  POs for {drillMonth?.label ?? ""}
                </SheetTitle>
                {drillMonth && (
                  <div className="flex gap-4 mt-2 text-sm">
                    <span className="text-muted-foreground">
                      <span className="font-semibold text-foreground">{drillMonth.count}</span> order{drillMonth.count !== 1 ? "s" : ""}
                    </span>
                    <span className="text-muted-foreground">
                      Total: <span className="font-semibold text-foreground">{formatCurrency(drillMonth.amount)}</span>
                    </span>
                  </div>
                )}
              </SheetHeader>

              <div className="flex-1 overflow-y-auto px-4 py-4">
                {drillMonth && insights && (() => {
                  const monthPos = insights.allPosForDisplay.filter(
                    (po) => po.created_at >= drillMonth.start && po.created_at < drillMonth.end
                  );
                  if (monthPos.length === 0) {
                    return <p className="text-sm text-muted-foreground text-center py-8">No purchase orders found for this month.</p>;
                  }
                  return (
                    <div className="space-y-2.5">
                      {monthPos.map((po) => (
                        <div
                          key={po.id}
                          className="border rounded-lg p-3 hover:bg-muted/40 cursor-pointer transition-colors"
                          onClick={() => router.push(`/procurement/orders/${po.id}`)}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-sm font-semibold">{po.po_number}</span>
                              <Badge className={
                                po.status === "delivered" || po.status === "completed" ? "bg-green-100 text-green-800" :
                                po.status === "ordered" ? "bg-blue-100 text-blue-800" :
                                po.status === "cancelled" ? "bg-red-100 text-red-800" :
                                po.status === "draft" ? "bg-gray-100 text-gray-700" :
                                "bg-amber-100 text-amber-800"
                              } variant="secondary">
                                {po.status}
                              </Badge>
                            </div>
                            <span className="font-semibold text-sm tabular-nums shrink-0">
                              {po.total_ordered_amount != null ? formatCurrency(po.total_ordered_amount) : "—"}
                            </span>
                          </div>

                          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                            {po.pr?.department && (
                              <span className="capitalize">
                                Dept: {po.pr.department}
                              </span>
                            )}
                            {po.pr?.pr_number && (
                              <span>MR: {po.pr.pr_number}</span>
                            )}
                            <span>{formatDate(po.created_at)}</span>
                          </div>

                          {po.top_items.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {po.top_items.map((name, i) => (
                                <span key={i} className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">{name}</span>
                              ))}
                              {po.item_count > po.top_items.length && (
                                <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">+{po.item_count - po.top_items.length} more</span>
                              )}
                            </div>
                          )}

                          <div className="mt-2 flex items-center justify-end text-xs text-primary gap-1">
                            View PO <ExternalLink className="h-3 w-3" />
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </SheetContent>
          </Sheet>
        </TabsContent>

        {/* Activity & Insights Tab */}
        <TabsContent value="activity" className="mt-4 space-y-4">
          {insightsLoading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="animate-pulse bg-muted rounded-lg h-32" />
              ))}
            </div>
          ) : insightsError ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
              <AlertCircle className="h-8 w-8 text-red-400" />
              <p className="text-sm text-red-600">{insightsError}</p>
            </div>
          ) : !insights ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
              <BarChart2 className="h-8 w-8" />
              <p className="text-sm">No activity data available</p>
            </div>
          ) : (
            <>
              {/* KPI row */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: "Total PO Value", value: `₹${(insights.totalPoValue / 1000).toFixed(0)}K`, sub: `${insights.totalPoCount} orders` },
                  { label: "Total Billed", value: `₹${(insights.totalBilled / 1000).toFixed(0)}K`, sub: `${insights.billCount} bills` },
                  { label: "Outstanding", value: `₹${(insights.totalOutstanding / 1000).toFixed(0)}K`, sub: insights.overdueCount > 0 ? `${insights.overdueCount} overdue` : "All current", warn: insights.overdueCount > 0 },
                  { label: "Avg Payment Terms", value: insights.avgPaymentTermDays != null ? `${insights.avgPaymentTermDays}d` : "—", sub: "invoice → due" },
                ].map(({ label, value, sub, warn }) => (
                  <Card key={label}>
                    <CardContent className="p-4">
                      <p className="text-xs text-muted-foreground mb-1">{label}</p>
                      <p className={`text-xl font-semibold ${warn ? "text-red-600" : ""}`}>{value}</p>
                      <p className={`text-xs mt-0.5 ${warn ? "text-red-500" : "text-muted-foreground"}`}>{sub}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Spend by month — last 6 of the 12 shown here, full 12 in PO Analytics tab */}
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Monthly Spend (last 6 months)</CardTitle>
                    <button
                      className="text-xs text-primary hover:underline flex items-center gap-0.5"
                      onClick={() => setActiveTab("po-analytics")}
                    >
                      Full 12-month view →
                    </button>
                  </div>
                </CardHeader>
                <CardContent>
                  {(() => {
                    const last6 = insights.spendByMonth.slice(-6);
                    const max = Math.max(...last6.map((m) => m.amount), 1);
                    const total6m = last6.reduce((s, m) => s + m.amount, 0);
                    return (
                      <div className="space-y-2">
                        {last6.map((m, idx) => {
                          const pct = (m.amount / max) * 100;
                          const isCurrent = idx === last6.length - 1;
                          const hasData = m.amount > 0 || m.count > 0;
                          return (
                            <button
                              key={m.label}
                              className={`w-full flex items-center gap-3 rounded px-1 py-0.5 text-left transition-colors ${hasData ? "hover:bg-muted/60 cursor-pointer" : "cursor-default"}`}
                              onClick={() => hasData && setDrillMonth(m)}
                              disabled={!hasData}
                            >
                              <span className="text-xs text-muted-foreground w-12 shrink-0">{m.label}</span>
                              <div className="flex-1 h-6 bg-muted rounded-sm overflow-hidden">
                                <div
                                  className={`h-full rounded-sm transition-all ${isCurrent ? "bg-primary" : "bg-primary/40"}`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="text-xs text-muted-foreground w-20 text-right shrink-0 tabular-nums">
                                {m.amount > 0 ? `₹${(m.amount / 1000).toFixed(1)}K` : "—"}
                              </span>
                            </button>
                          );
                        })}
                        <div className="pt-1 text-xs text-muted-foreground text-right">
                          6-month total: <span className="font-medium text-foreground">₹{(total6m / 1000).toFixed(1)}K</span>
                        </div>
                      </div>
                    );
                  })()}
                </CardContent>
              </Card>

              {/* Top items ordered + Payment performance side by side on larger screens */}
              <div className="grid md:grid-cols-2 gap-4">
                {/* Top items */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Top Items Ordered</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {insights.topItems.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-4 text-center">No items data</p>
                    ) : (() => {
                      const maxVal = Math.max(...insights.topItems.map((i) => i.value), 1);
                      return (
                        <div className="space-y-2">
                          {insights.topItems.map((item) => {
                            const pct = (item.value / maxVal) * 100;
                            return (
                              <div key={item.name}>
                                <div className="flex items-center justify-between text-xs mb-0.5">
                                  <span className="text-foreground truncate max-w-[160px]">{item.name}</span>
                                  <span className="text-muted-foreground shrink-0 ml-2">₹{(item.value / 1000).toFixed(1)}K</span>
                                </div>
                                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                  <div className="h-full bg-primary/60 rounded-full" style={{ width: `${pct}%` }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </CardContent>
                </Card>

                {/* Payment performance */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Payment Performance</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Total Billed</span>
                      <span className="font-medium">₹{insights.totalBilled.toLocaleString("en-IN")}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Paid</span>
                      <span className="font-medium text-green-700">₹{insights.totalPaid.toLocaleString("en-IN")}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Outstanding</span>
                      <span className={`font-medium ${insights.totalOutstanding > 0 ? "text-amber-700" : "text-muted-foreground"}`}>
                        ₹{insights.totalOutstanding.toLocaleString("en-IN")}
                      </span>
                    </div>
                    {insights.overdueCount > 0 && (
                      <div className="flex items-center gap-2 p-2.5 rounded-md bg-red-50 text-red-700 text-sm">
                        <AlertCircle className="h-4 w-4 shrink-0" />
                        <span>{insights.overdueCount} overdue bill{insights.overdueCount > 1 ? "s" : ""} — ₹{insights.overdueAmount.toLocaleString("en-IN")}</span>
                      </div>
                    )}
                    {insights.totalBilled > 0 && (
                      <div>
                        <div className="flex justify-between text-xs text-muted-foreground mb-1">
                          <span>Payment progress</span>
                          <span>{Math.round((insights.totalPaid / insights.totalBilled) * 100)}%</span>
                        </div>
                        <div className="h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-green-500 rounded-full"
                            style={{ width: `${Math.min(100, Math.round((insights.totalPaid / insights.totalBilled) * 100))}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Recent POs */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Recent Purchase Orders</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {insights.recentPos.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-8 text-center">No purchase orders yet</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/30">
                          <th className="px-4 py-2.5 text-left font-medium">PO Number</th>
                          <th className="px-4 py-2.5 text-left font-medium hidden sm:table-cell">Date</th>
                          <th className="px-4 py-2.5 text-left font-medium">Status</th>
                          <th className="px-4 py-2.5 text-right font-medium hidden md:table-cell">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {insights.recentPos.map((po) => (
                          <tr
                            key={po.id}
                            className="border-b last:border-0 hover:bg-muted/40 cursor-pointer"
                            onClick={() => router.push(`/procurement/orders/${po.id}`)}
                          >
                            <td className="px-4 py-2.5 font-mono text-xs">{po.po_number}</td>
                            <td className="px-4 py-2.5 text-muted-foreground hidden sm:table-cell">{formatDate(po.created_at)}</td>
                            <td className="px-4 py-2.5">
                              <Badge className={
                                po.status === "delivered" ? "bg-green-100 text-green-800" :
                                po.status === "ordered" ? "bg-blue-100 text-blue-800" :
                                po.status === "cancelled" ? "bg-red-100 text-red-800" :
                                "bg-amber-100 text-amber-800"
                              }>
                                {po.status}
                              </Badge>
                            </td>
                            <td className="px-4 py-2.5 text-right hidden md:table-cell">
                              {po.total_ordered_amount != null ? formatCurrency(po.total_ordered_amount) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CardContent>
              </Card>

              {/* Recent Bills */}
              {insights.recentBills.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Recent Bills</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/30">
                          <th className="px-4 py-2.5 text-left font-medium">Bill #</th>
                          <th className="px-4 py-2.5 text-left font-medium hidden md:table-cell">Invoice #</th>
                          <th className="px-4 py-2.5 text-left font-medium hidden sm:table-cell">Due Date</th>
                          <th className="px-4 py-2.5 text-left font-medium">Payment</th>
                          <th className="px-4 py-2.5 text-right font-medium hidden md:table-cell">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {insights.recentBills.map((bill) => (
                          <tr key={bill.id} className="border-b last:border-0">
                            <td className="px-4 py-2.5 font-mono text-xs">
                              <Link
                                href={`/accounting/vendor-payments/${bill.id}`}
                                className="text-primary hover:underline"
                              >
                                {bill.bill_number}
                              </Link>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-muted-foreground hidden md:table-cell">
                              {bill.invoice_number || "—"}
                            </td>
                            <td className="px-4 py-2.5 text-muted-foreground hidden sm:table-cell">
                              {bill.due_date ? formatDate(bill.due_date) : "—"}
                            </td>
                            <td className="px-4 py-2.5">
                              <Badge className={
                                bill.payment_status === "paid" ? "bg-green-100 text-green-800" :
                                bill.payment_status === "partially_paid" ? "bg-amber-100 text-amber-800" :
                                "bg-red-100 text-red-800"
                              }>
                                {bill.payment_status === "partially_paid" ? "Partial" : bill.payment_status}
                              </Badge>
                            </td>
                            <td className="px-4 py-2.5 text-right hidden md:table-cell">
                              {bill.total_amount != null ? formatCurrency(bill.total_amount) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              )}
            </>
          )}
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
