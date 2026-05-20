"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, Edit, Plus, CheckCircle, PauseCircle, TrendingUp,
  FileText, Wrench, ExternalLink, PlayCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  LEASE_STATUS_LABELS, LEASE_STATUS_COLORS,
  LEASE_PAYMENT_STATUS_LABELS, LEASE_PAYMENT_STATUS_COLORS,
  ESCALATION_TYPE_LABELS, ESCALATION_STATUS_LABELS, ESCALATION_STATUS_COLORS,
  ASSET_CATEGORY_LABELS, LEASE_DOCUMENT_TYPE_LABELS, HANDOVER_TYPE_LABELS,
} from "@/lib/constants";
import { toast } from "sonner";
import type { PropertyLease, LeasePayment, LeaseEscalation, LeaseAsset, LeaseDocument, LeaseServiceOffering } from "@/types";
import { AssetManager } from "@/components/rent-management/AssetManager";

interface LeaseHandover {
  id: string;
  handover_type: string;
  handover_date: string;
  condition_notes: string | null;
  before_photos: string[];
  after_photos: string[];
}

export default function LeaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [lease, setLease] = useState<PropertyLease | null>(null);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("overview");

  // Per-tab data
  const [payments, setPayments] = useState<LeasePayment[]>([]);
  const [escalations, setEscalations] = useState<LeaseEscalation[]>([]);
  const [assets, setAssets] = useState<LeaseAsset[]>([]);
  const [documents, setDocuments] = useState<LeaseDocument[]>([]);
  const [services, setServices] = useState<LeaseServiceOffering[]>([]);
  const [handovers, setHandovers] = useState<LeaseHandover[]>([]);

  // Dialog state
  const [paymentDialog, setPaymentDialog] = useState(false);
  const [holdDialog, setHoldDialog] = useState<{ open: boolean; paymentId: string | null }>({ open: false, paymentId: null });
  const [escalationDialog, setEscalationDialog] = useState(false);

  const [paymentForm, setPaymentForm] = useState({
    payment_month: "", due_date: "", gross_rent_amount: "", tds_amount: "", notes: "",
  });
  const [holdReason, setHoldReason] = useState("");
  const [escalationForm, setEscalationForm] = useState({
    effective_date: "", escalation_type: "percentage", escalation_value: "",
    new_amount: "", notes: "",
  });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then((d) => {
      setUserRole(d.role);
      if (d.role && d.role !== "admin") router.replace("/dashboard");
    });
  }, [router]);

  const fetchLease = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/rent-management/leases/${id}`);
    if (res.ok) {
      const json = await res.json();
      setLease(json.data);
    } else {
      router.push("/rent-management/leases");
    }
    setLoading(false);
  }, [id, router]);

  useEffect(() => { fetchLease(); }, [fetchLease]);

  const refreshAssets = useCallback(async () => {
    const [ar, hr] = await Promise.all([
      fetch(`/api/rent-management/leases/${id}/assets`),
      fetch(`/api/rent-management/leases/${id}/handovers`),
    ]);
    if (ar.ok) setAssets((await ar.json()).data || []);
    if (hr.ok) setHandovers((await hr.json()).data || []);
  }, [id]);

  // eslint-disable-next-line react-compiler/react-compiler
  const fetchTab = useCallback(async (tab: string) => {
    if (tab === "payments" && payments.length === 0) {
      const r = await fetch(`/api/rent-management/leases/${id}/payments`);
      if (r.ok) setPayments((await r.json()).data || []);
    }
    if (tab === "escalations") {
      const r = await fetch(`/api/rent-management/leases/${id}/escalations`);
      if (r.ok) setEscalations((await r.json()).data || []);
    }
    if (tab === "assets") {
      await refreshAssets();
    }
    if (tab === "documents") {
      const r = await fetch(`/api/rent-management/leases/${id}/documents`);
      if (r.ok) setDocuments((await r.json()).data || []);
    }
    if (tab === "services") {
      const r = await fetch(`/api/rent-management/leases/${id}/services`);
      if (r.ok) setServices((await r.json()).data || []);
    }
  }, [id, payments.length]);

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    fetchTab(tab);
  };

  const isAdmin = userRole === "admin";
  const isViewer = userRole === "viewer";
  const canWrite = userRole === "admin" || userRole === "accounts";

  // Payment actions
  async function approvePayment(paymentId: string) {
    const r = await fetch(`/api/rent-management/leases/${id}/payments/${paymentId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (r.ok) {
      toast.success("Payment approved");
      const updated = await fetch(`/api/rent-management/leases/${id}/payments`);
      if (updated.ok) setPayments((await updated.json()).data || []);
    } else {
      const err = await r.json().catch(() => ({}));
      toast.error(err.error || "Failed to approve payment");
    }
  }

  async function handleHold() {
    if (!holdDialog.paymentId || !holdReason.trim()) return;
    setSubmitting(true);
    const r = await fetch(`/api/rent-management/leases/${id}/payments/${holdDialog.paymentId}/hold`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: holdReason }),
    });
    setSubmitting(false);
    if (r.ok) {
      toast.success("Payment put on hold");
      setHoldDialog({ open: false, paymentId: null });
      setHoldReason("");
      const updated = await fetch(`/api/rent-management/leases/${id}/payments`);
      if (updated.ok) setPayments((await updated.json()).data || []);
    } else {
      toast.error("Failed to put payment on hold");
    }
  }

  async function handleAddPayment() {
    setSubmitting(true);
    const r = await fetch(`/api/rent-management/leases/${id}/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...paymentForm,
        gross_rent_amount: parseFloat(paymentForm.gross_rent_amount),
        tds_amount: paymentForm.tds_amount ? parseFloat(paymentForm.tds_amount) : 0,
        notes: paymentForm.notes || null,
      }),
    });
    setSubmitting(false);
    if (r.ok) {
      toast.success("Payment recorded");
      setPaymentDialog(false);
      setPaymentForm({ payment_month: "", due_date: "", gross_rent_amount: "", tds_amount: "", notes: "" });
      const updated = await fetch(`/api/rent-management/leases/${id}/payments`);
      if (updated.ok) setPayments((await updated.json()).data || []);
    } else {
      const err = await r.json();
      toast.error(err.error || "Failed to record payment");
    }
  }

  async function liftHold(paymentId: string) {
    const r = await fetch(`/api/rent-management/leases/${id}/payments/${paymentId}/lift-hold`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (r.ok) {
      toast.success("Hold lifted — payment returned to pending");
      const updated = await fetch(`/api/rent-management/leases/${id}/payments`);
      if (updated.ok) setPayments((await updated.json()).data || []);
    } else {
      const err = await r.json().catch(() => ({}));
      toast.error(err.error || "Failed to lift hold");
    }
  }

  async function applyEscalation(escId: string) {
    const r = await fetch(`/api/rent-management/leases/${id}/escalations/${escId}/apply`, { method: "POST" });
    if (r.ok) {
      toast.success("Escalation applied");
      fetchLease();
      fetchTab("escalations");
    } else {
      toast.error("Failed to apply escalation");
    }
  }

  async function waiveEscalation(escId: string) {
    const r = await fetch(`/api/rent-management/leases/${id}/escalations/${escId}/waive`, { method: "POST" });
    if (r.ok) {
      toast.success("Escalation waived");
      fetchTab("escalations");
    } else {
      toast.error("Failed to waive escalation");
    }
  }

  async function handleAddEscalation() {
    if (!lease) return;
    setSubmitting(true);
    const newAmt = escalationForm.new_amount ? parseFloat(escalationForm.new_amount) : null;
    const r = await fetch(`/api/rent-management/leases/${id}/escalations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        effective_date: escalationForm.effective_date,
        escalation_type: escalationForm.escalation_type,
        escalation_value: escalationForm.escalation_value ? parseFloat(escalationForm.escalation_value) : null,
        previous_amount: lease.base_rent_amount,
        new_amount: newAmt ?? lease.base_rent_amount,
        notes: escalationForm.notes || null,
      }),
    });
    setSubmitting(false);
    if (r.ok) {
      toast.success("Escalation scheduled");
      setEscalationDialog(false);
      setEscalationForm({ effective_date: "", escalation_type: "percentage", escalation_value: "", new_amount: "", notes: "" });
      fetchTab("escalations");
    } else {
      const err = await r.json();
      toast.error(err.error || "Failed to schedule escalation");
    }
  }

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <div className="h-8 w-64 bg-muted animate-pulse rounded" />
        <div className="h-32 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  if (!lease) return null;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="sm" asChild className="mt-1">
            <Link href="/rent-management/leases"><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">{lease.location?.name ?? "Lease"}</h1>
              <Badge className={LEASE_STATUS_COLORS[lease.status]}>
                {LEASE_STATUS_LABELS[lease.status]}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {lease.landlord?.name} · {lease.lease_number ?? "No lease #"}
            </p>
          </div>
        </div>
        {isAdmin && (
          <Button variant="outline" size="sm" asChild>
            <Link href={`/rent-management/leases/${id}/edit`}>
              <Edit className="h-4 w-4 mr-2" />Edit
            </Link>
          </Button>
        )}
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {!isViewer && <TabsTrigger value="payments">Payments</TabsTrigger>}
          <TabsTrigger value="escalations">Escalations</TabsTrigger>
          <TabsTrigger value="assets">Assets</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="services">Services</TabsTrigger>
        </TabsList>

        {/* ─── Overview ─── */}
        <TabsContent value="overview" className="space-y-4">
          {!isViewer && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Base Rent</CardTitle></CardHeader>
                <CardContent><p className="text-xl font-bold">{formatCurrency(lease.base_rent_amount)}/mo</p></CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Security Deposit</CardTitle></CardHeader>
                <CardContent>
                  <p className="text-xl font-bold">{formatCurrency(lease.security_deposit_amount)}</p>
                  <p className="text-xs text-muted-foreground">{lease.advance_months} months advance</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">TDS Rate</CardTitle></CardHeader>
                <CardContent>
                  <p className="text-xl font-bold">{lease.tds_rate}%</p>
                  <p className="text-xs text-muted-foreground">Section {lease.tds_section}</p>
                </CardContent>
              </Card>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Lease Details</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Row label="Location" value={lease.location?.name} />
                <Row label="City" value={lease.location?.city} />
                <Row label="Landlord" value={lease.landlord?.name} />
                <Row label="Lease #" value={lease.lease_number} mono />
                <Row label="Start" value={formatDate(lease.lease_start_date)} />
                <Row label="End" value={formatDate(lease.lease_end_date)} />
                {lease.lock_in_end_date && <Row label="Lock-in until" value={formatDate(lease.lock_in_end_date)} />}
                <Row label="Rent due day" value={`${lease.rent_due_day ?? 1} of month`} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">TDS & Escalation</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {!isViewer && (
                  <>
                    <Row label="TDS Section" value={lease.tds_section} />
                    <Row label="TDS Rate" value={`${lease.tds_rate}%`} />
                  </>
                )}
                <Row label="Escalation" value={ESCALATION_TYPE_LABELS[lease.escalation_type] ?? "None"} />
                {lease.escalation_type !== "none" && lease.escalation_value && !isViewer && (
                  <Row label="Escalation Value" value={lease.escalation_type === "percentage" ? `${lease.escalation_value}%` : formatCurrency(lease.escalation_value)} />
                )}
                {lease.next_escalation_date && (
                  <Row label="Next Escalation" value={formatDate(lease.next_escalation_date)} />
                )}
                <div className="pt-2 border-t space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Approval Mode</span>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={lease.approval_mode === "blanket" ? "border-green-500 text-green-700" : "border-orange-400 text-orange-700"}>
                        {lease.approval_mode === "blanket" ? "Blanket" : "Manual"}
                      </Badge>
                      {isAdmin && (
                        <button
                          className="text-xs text-primary hover:underline"
                          onClick={async () => {
                            const newMode = lease.approval_mode === "blanket" ? "manual" : "blanket";
                            const r = await fetch(`/api/rent-management/leases/${id}`, {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ approval_mode: newMode }),
                            });
                            if (r.ok) { toast.success(`Approval mode set to ${newMode}`); fetchLease(); }
                            else toast.error("Failed to update approval mode");
                          }}
                        >
                          Switch to {lease.approval_mode === "blanket" ? "manual" : "blanket"}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Blanket sub-options — only visible when mode is blanket */}
                  {lease.approval_mode === "blanket" && (
                    <div className="ml-2 pl-3 border-l-2 border-green-200 space-y-2">
                      {/* Expiry */}
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Auto-approve until</span>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">
                            {lease.blanket_expires_on ? formatDate(lease.blanket_expires_on) : "End of lease tenure"}
                          </span>
                          {isAdmin && (
                            <BlanketExpiryPicker
                              current={lease.blanket_expires_on ?? null}
                              leaseEnd={lease.lease_end_date}
                              onSave={async (val) => {
                                const r = await fetch(`/api/rent-management/leases/${id}`, {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ blanket_expires_on: val }),
                                });
                                if (r.ok) { toast.success("Expiry updated"); fetchLease(); }
                                else toast.error("Failed to update");
                              }}
                            />
                          )}
                        </div>
                      </div>

                      {/* Hold */}
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Auto-approval paused?</span>
                        <div className="flex items-center gap-2">
                          {lease.blanket_on_hold ? (
                            <span className="text-orange-600 font-medium">
                              Paused {lease.blanket_hold_until ? `until ${formatDate(lease.blanket_hold_until)}` : "(indefinite)"}
                            </span>
                          ) : (
                            <span className="text-green-600 font-medium">Active</span>
                          )}
                          {isAdmin && (
                            <BlanketHoldToggle
                              isOnHold={lease.blanket_on_hold}
                              holdUntil={lease.blanket_hold_until ?? null}
                              onSave={async (onHold, holdUntil) => {
                                const r = await fetch(`/api/rent-management/leases/${id}`, {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ blanket_on_hold: onHold, blanket_hold_until: holdUntil }),
                                });
                                if (r.ok) { toast.success(onHold ? "Blanket approval paused" : "Blanket approval resumed"); fetchLease(); }
                                else toast.error("Failed to update");
                              }}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                {lease.notes && (
                  <div className="pt-2 border-t">
                    <p className="text-muted-foreground text-xs mb-1">Notes</p>
                    <p className="whitespace-pre-wrap">{lease.notes}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ─── Payments ─── */}
        <TabsContent value="payments" className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{payments.length} payment record(s)</p>
            {canWrite && (
              <Button size="sm" onClick={() => {
                setPaymentForm({
                  payment_month: new Date().toISOString().slice(0, 7),
                  due_date: "",
                  gross_rent_amount: String(lease.base_rent_amount),
                  tds_amount: String(Math.round(lease.base_rent_amount * (lease.tds_rate ?? 10) / 100)),
                  notes: "",
                });
                setPaymentDialog(true);
              }}>
                <Plus className="h-4 w-4 mr-2" />Add Payment Entry
              </Button>
            )}
          </div>

          {payments.length === 0 ? (
            <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No payments recorded yet</CardContent></Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40">
                        <th className="text-left px-4 py-3 font-medium">Month</th>
                        <th className="text-right px-4 py-3 font-medium">Gross Rent</th>
                        <th className="text-right px-4 py-3 font-medium">TDS</th>
                        <th className="text-right px-4 py-3 font-medium">Net Payable</th>
                        <th className="text-left px-4 py-3 font-medium">Due</th>
                        <th className="text-left px-4 py-3 font-medium">Paid</th>
                        <th className="text-left px-4 py-3 font-medium">Status</th>
                        <th className="text-left px-4 py-3 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((p) => (
                        <tr key={p.id} className="border-b hover:bg-muted/20">
                          <td className="px-4 py-3 font-medium">{p.payment_month}</td>
                          <td className="px-4 py-3 text-right">{formatCurrency(p.gross_rent_amount)}</td>
                          <td className="px-4 py-3 text-right text-muted-foreground">{formatCurrency(p.tds_amount ?? 0)}</td>
                          <td className="px-4 py-3 text-right font-medium">{formatCurrency(p.net_amount_paid ?? (p.gross_rent_amount - (p.tds_amount ?? 0)))}</td>
                          <td className="px-4 py-3 text-muted-foreground">{formatDate(p.due_date)}</td>
                          <td className="px-4 py-3 text-muted-foreground">{p.paid_date ? formatDate(p.paid_date) : "—"}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1 flex-wrap">
                              <Badge className={LEASE_PAYMENT_STATUS_COLORS[p.status]}>
                                {LEASE_PAYMENT_STATUS_LABELS[p.status]}
                              </Badge>
                              {p.auto_approved && (
                                <span className="text-xs text-muted-foreground">auto</span>
                              )}
                              {p.status === "on_hold" && p.on_hold_reason && (
                                <span className="text-xs text-muted-foreground truncate max-w-32" title={p.on_hold_reason}>
                                  {p.on_hold_reason}
                                </span>
                              )}
                              {p.status === "approved" && (
                                <span className="text-xs text-blue-600">→ Acc Payables</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex gap-1 items-center">
                              {/* Approve: admin only, on pending/overdue */}
                              {isAdmin && (p.status === "pending" || p.status === "overdue") && (
                                <Button
                                  size="sm" variant="ghost" className="h-7 px-2 text-green-600"
                                  title="Approve payment"
                                  onClick={() => approvePayment(p.id)}
                                >
                                  <CheckCircle className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {/* Hold: admin + accounts, on pending/overdue */}
                              {canWrite && (p.status === "pending" || p.status === "overdue") && (
                                <Button
                                  size="sm" variant="ghost" className="h-7 px-2 text-yellow-600"
                                  title="Put on hold"
                                  onClick={() => setHoldDialog({ open: true, paymentId: p.id })}
                                >
                                  <PauseCircle className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {/* Lift hold: admin only, on on_hold */}
                              {isAdmin && p.status === "on_hold" && (
                                <Button
                                  size="sm" variant="ghost" className="h-7 px-2 text-blue-600"
                                  title="Lift hold"
                                  onClick={() => liftHold(p.id)}
                                >
                                  <PlayCircle className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {p.attachment_url && (
                                <a href={p.attachment_url} target="_blank" rel="noopener noreferrer">
                                  <Button size="sm" variant="ghost" className="h-7 px-2"><ExternalLink className="h-3.5 w-3.5" /></Button>
                                </a>
                              )}
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
        </TabsContent>

        {/* ─── Escalations ─── */}
        <TabsContent value="escalations" className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Current base rent: <strong>{formatCurrency(lease.base_rent_amount)}/mo</strong>
            </p>
            {isAdmin && (
              <Button size="sm" onClick={() => setEscalationDialog(true)}>
                <TrendingUp className="h-4 w-4 mr-2" />Schedule Escalation
              </Button>
            )}
          </div>

          {escalations.length === 0 ? (
            <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No escalations recorded</CardContent></Card>
          ) : (
            <div className="space-y-3">
              {escalations.map((e) => (
                <Card key={e.id}>
                  <CardContent className="pt-4">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Badge className={ESCALATION_STATUS_COLORS[e.status]}>
                            {ESCALATION_STATUS_LABELS[e.status]}
                          </Badge>
                          <span className="text-sm font-medium">
                            {ESCALATION_TYPE_LABELS[e.escalation_type]}
                            {e.escalation_value ? ` — ${e.escalation_type === "percentage" ? `${e.escalation_value}%` : formatCurrency(e.escalation_value)}` : ""}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Effective: {formatDate(e.effective_date)}
                          {e.new_amount && ` → New rent: ${formatCurrency(e.new_amount)}`}
                        </p>
                        {e.notes && <p className="text-xs text-muted-foreground">{e.notes}</p>}
                      </div>
                      {isAdmin && e.status === "scheduled" && (
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" onClick={() => applyEscalation(e.id)}>Apply</Button>
                          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => waiveEscalation(e.id)}>Waive</Button>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ─── Assets ─── */}
        <TabsContent value="assets" className="space-y-4">
          <>
              <AssetManager
                leaseId={id}
                assets={assets}
                canEdit={userRole === "admin" || userRole === "accounts"}
                onRefresh={refreshAssets}
              />

              {handovers.length > 0 && (
                <Card>
                  <CardHeader><CardTitle className="text-base flex items-center gap-2"><Wrench className="h-4 w-4" />Handover Records</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    {handovers.map((h) => (
                      <div key={h.id} className="border rounded-lg p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-sm">{HANDOVER_TYPE_LABELS[h.handover_type] ?? h.handover_type}</span>
                          <span className="text-xs text-muted-foreground">{formatDate(h.handover_date)}</span>
                        </div>
                        {h.condition_notes && <p className="text-xs text-muted-foreground">{h.condition_notes}</p>}
                        {h.before_photos.length > 0 && (
                          <div className="flex gap-2 flex-wrap">
                            {h.before_photos.map((url, i) => (
                              <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Before {i + 1}</a>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </>
        </TabsContent>

        {/* ─── Documents ─── */}
        <TabsContent value="documents" className="space-y-4">
          <div className="flex justify-end">
            {canWrite && (
              <Button size="sm" variant="outline" asChild>
                <Link href={`/rent-management/leases/${id}/documents/upload`}>
                  <FileText className="h-4 w-4 mr-2" />Upload Document
                </Link>
              </Button>
            )}
          </div>

          {documents.length === 0 ? (
            <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No documents uploaded</CardContent></Card>
          ) : (
            <div className="space-y-2">
              {documents.map((doc) => (
                <Card key={doc.id}>
                  <CardContent className="py-3 px-4 flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm">{doc.document_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {LEASE_DOCUMENT_TYPE_LABELS[doc.document_type] ?? doc.document_type}
                        {doc.uploaded_by_name && ` · ${doc.uploaded_by_name}`}
                        {doc.version && doc.version > 1 && ` · v${doc.version}`}
                      </p>
                    </div>
                    <a href={doc.file_url} target="_blank" rel="noopener noreferrer">
                      <Button size="sm" variant="ghost"><ExternalLink className="h-4 w-4" /></Button>
                    </a>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ─── Services / RACI ─── */}
        <TabsContent value="services" className="space-y-4">
          {services.length === 0 ? (
            <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No services configured</CardContent></Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40">
                        <th className="text-left px-4 py-3 font-medium">Service</th>
                        <th className="text-left px-4 py-3 font-medium">Landlord</th>
                        <th className="text-left px-4 py-3 font-medium">Responsible</th>
                        <th className="text-left px-4 py-3 font-medium">Accountable</th>
                        <th className="text-left px-4 py-3 font-medium">Frequency</th>
                        <th className="text-left px-4 py-3 font-medium">SLA Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {services.map((s) => (
                        <tr key={s.id} className="border-b hover:bg-muted/20">
                          <td className="px-4 py-3 font-medium capitalize">
                            {s.service_name === "other" ? (s.custom_service_name ?? "Other") : s.service_name.replace("_", " ")}
                          </td>
                          <td className="px-4 py-3">
                            {s.landlord_provided ? <Badge variant="outline" className="text-xs">Landlord</Badge> : <span className="text-muted-foreground">Tenant</span>}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">{s.responsible ?? "—"}</td>
                          <td className="px-4 py-3 text-muted-foreground">{s.accountable ?? "—"}</td>
                          <td className="px-4 py-3 text-muted-foreground capitalize">{s.frequency?.replace("_", " ") ?? "—"}</td>
                          <td className="px-4 py-3 text-muted-foreground text-xs max-w-48 truncate">{s.sla_notes ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* Add Payment Entry Dialog */}
      <Dialog open={paymentDialog} onOpenChange={setPaymentDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Payment Entry</DialogTitle>
            <p className="text-xs text-muted-foreground pt-1">Creates a pending payment entry. Admin must approve before accounts can process it.</p>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Payment Month *</Label>
                <Input type="month" value={paymentForm.payment_month} onChange={(e) => setPaymentForm((f) => ({ ...f, payment_month: e.target.value }))} required />
              </div>
              <div className="space-y-2">
                <Label>Due Date *</Label>
                <Input type="date" value={paymentForm.due_date} onChange={(e) => setPaymentForm((f) => ({ ...f, due_date: e.target.value }))} required />
              </div>
              <div className="space-y-2">
                <Label>Gross Rent (₹) *</Label>
                <Input type="number" value={paymentForm.gross_rent_amount} onChange={(e) => setPaymentForm((f) => ({ ...f, gross_rent_amount: e.target.value }))} min="0" step="0.01" required />
              </div>
              <div className="space-y-2">
                <Label>TDS Amount (₹)</Label>
                <Input type="number" value={paymentForm.tds_amount} onChange={(e) => setPaymentForm((f) => ({ ...f, tds_amount: e.target.value }))} min="0" step="0.01" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea value={paymentForm.notes} onChange={(e) => setPaymentForm((f) => ({ ...f, notes: e.target.value }))} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentDialog(false)}>Cancel</Button>
            <Button onClick={handleAddPayment} disabled={submitting}>
              {submitting ? "Adding..." : "Add Entry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Hold Dialog */}
      <Dialog open={holdDialog.open} onOpenChange={(o) => setHoldDialog({ open: o, paymentId: holdDialog.paymentId })}>
        <DialogContent>
          <DialogHeader><DialogTitle>Put Payment on Hold</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Label>Reason *</Label>
            <Textarea value={holdReason} onChange={(e) => setHoldReason(e.target.value)} placeholder="Explain why this payment is being held..." rows={3} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHoldDialog({ open: false, paymentId: null })}>Cancel</Button>
            <Button onClick={handleHold} disabled={submitting || !holdReason.trim()}>
              {submitting ? "Saving..." : "Put on Hold"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Escalation Dialog */}
      <Dialog open={escalationDialog} onOpenChange={setEscalationDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Schedule Escalation</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2 col-span-2">
              <Label>Effective Date *</Label>
              <Input type="date" value={escalationForm.effective_date} onChange={(e) => setEscalationForm((f) => ({ ...f, effective_date: e.target.value }))} required />
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={escalationForm.escalation_type} onValueChange={(v) => setEscalationForm((f) => ({ ...f, escalation_type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="percentage">Percentage</SelectItem>
                  <SelectItem value="flat">Flat Amount</SelectItem>
                  <SelectItem value="step_up">Step-up</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{escalationForm.escalation_type === "percentage" ? "%" : "₹ Amount"}</Label>
              <Input type="number" value={escalationForm.escalation_value} onChange={(e) => setEscalationForm((f) => ({ ...f, escalation_value: e.target.value }))} min="0" step="0.01" />
            </div>
            <div className="space-y-2 col-span-2">
              <Label>New Rent Amount (₹) *</Label>
              <Input type="number" value={escalationForm.new_amount} onChange={(e) => setEscalationForm((f) => ({ ...f, new_amount: e.target.value }))} min="0" step="0.01" required />
            </div>
            <div className="space-y-2 col-span-2">
              <Label>Notes</Label>
              <Textarea value={escalationForm.notes} onChange={(e) => setEscalationForm((f) => ({ ...f, notes: e.target.value }))} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEscalationDialog(false)}>Cancel</Button>
            <Button onClick={handleAddEscalation} disabled={submitting}>
              {submitting ? "Saving..." : "Schedule"}
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

// ── Blanket approval inline pickers ──────────────────────────────────────────

function BlanketExpiryPicker({
  current, leaseEnd, onSave,
}: { current: string | null; leaseEnd: string; onSave: (val: string | null) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"tenure" | "date">(current ? "date" : "tenure");
  const [date, setDate] = useState(current ?? leaseEnd);
  const [saving, setSaving] = useState(false);
  return (
    <>
      <button className="text-primary hover:underline text-xs" onClick={() => setOpen(true)}>Change</button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setOpen(false)}>
          <div className="bg-background rounded-lg p-5 w-80 shadow-xl space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-sm">Auto-approve until…</h3>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" checked={mode === "tenure"} onChange={() => setMode("tenure")} />
                End of lease tenure ({leaseEnd})
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" checked={mode === "date"} onChange={() => setMode("date")} />
                Specific date
              </label>
              {mode === "date" && (
                <Input type="date" value={date} max={leaseEnd} onChange={(e) => setDate(e.target.value)} className="text-xs" />
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button size="sm" disabled={saving} onClick={async () => {
                setSaving(true);
                await onSave(mode === "tenure" ? null : date);
                setSaving(false);
                setOpen(false);
              }}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function BlanketHoldToggle({
  isOnHold, holdUntil, onSave,
}: { isOnHold: boolean; holdUntil: string | null; onSave: (onHold: boolean, holdUntil: string | null) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"indefinite" | "date">("indefinite");
  const [date, setDate] = useState(holdUntil ?? "");
  const [saving, setSaving] = useState(false);
  return (
    <>
      <button className="text-primary hover:underline text-xs" onClick={() => setOpen(true)}>
        {isOnHold ? "Resume" : "Pause"}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setOpen(false)}>
          <div className="bg-background rounded-lg p-5 w-80 shadow-xl space-y-4" onClick={(e) => e.stopPropagation()}>
            {isOnHold ? (
              <>
                <h3 className="font-semibold text-sm">Resume blanket approval?</h3>
                <p className="text-xs text-muted-foreground">Future payments will be auto-approved again.</p>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button size="sm" disabled={saving} onClick={async () => {
                    setSaving(true);
                    await onSave(false, null);
                    setSaving(false);
                    setOpen(false);
                  }}>
                    {saving ? "Saving…" : "Resume"}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <h3 className="font-semibold text-sm">Pause blanket approval</h3>
                <p className="text-xs text-muted-foreground">Payments generated while paused will require manual approval.</p>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="radio" checked={mode === "indefinite"} onChange={() => setMode("indefinite")} />
                    Indefinitely (resume manually)
                  </label>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="radio" checked={mode === "date"} onChange={() => setMode("date")} />
                    Until a specific date
                  </label>
                  {mode === "date" && (
                    <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="text-xs" />
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button size="sm" disabled={saving || (mode === "date" && !date)} onClick={async () => {
                    setSaving(true);
                    await onSave(true, mode === "date" ? date : null);
                    setSaving(false);
                    setOpen(false);
                  }}>
                    {saving ? "Saving…" : "Pause"}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
