"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Zap, CheckCircle2, ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { formatCurrency, formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { useCurrentUser } from "@/providers/current-user-provider";

interface EbLine {
  line_type: "utility" | "generator" | "other";
  meter_label?: string | null;
  label?: string | null;
  units?: number | null;
  rate?: number | null;
  amount?: number | null;
  sort_order: number;
}

interface EbBill {
  id: string;
  location_id: string;
  bill_side: string;
  bill_month: number;
  bill_year: number;
  status: "draft" | "invoiced" | "revised";
  landlord_bill_number?: string | null;
  landlord_bill_date?: string | null;
  landlord_total_amount: number;
  vendor_bill_id?: string | null;
  created_at: string;
  electricity_bill_lines: EbLine[];
  locations?: { id: string; name: string; code: string };
}

interface LocationConfig {
  service_number: string | null;
  landlord_utility_rate: number;
  landlord_generator_rate: number;
  enabled: boolean;
}

interface Location { id: string; name: string; code: string }

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const STATUS_COLORS: Record<string, string> = {
  draft:    "bg-amber-100 text-amber-800",
  invoiced: "bg-emerald-100 text-emerald-800",
  revised:  "bg-slate-100 text-slate-600",
};

const emptyLine = (): EbLine => ({ line_type: "utility", units: 0, rate: 0, sort_order: 0 });

export default function ElectricityBillsPage() {
  const { user } = useCurrentUser();
  const [bills, setBills] = useState<EbBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);

  // Form state
  const [locations, setLocations] = useState<Location[]>([]);
  const [locCfg, setLocCfg] = useState<LocationConfig | null>(null);
  const [form, setForm] = useState({
    location_id: "",
    bill_month: new Date().getMonth() + 1,
    bill_year: new Date().getFullYear(),
    landlord_bill_number: "",
    landlord_bill_date: "",
    notes: "",
  });
  const [lines, setLines] = useState<EbLine[]>([emptyLine()]);
  const [submitting, setSubmitting] = useState(false);

  const fetchBills = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/electricity-bills?bill_side=landlord");
    if (res.ok) {
      const json = await res.json();
      setBills(json.data ?? []);
    }
    setLoading(false);
  }, []);

  const fetchLocations = useCallback(async () => {
    const res = await fetch("/api/locations?limit=50");
    if (res.ok) {
      const json = await res.json();
      setLocations(json.data ?? []);
    }
  }, []);

  useEffect(() => { fetchBills(); fetchLocations(); }, [fetchBills, fetchLocations]);

  const handleLocationChange = async (locId: string) => {
    setForm((f) => ({ ...f, location_id: locId }));
    if (!locId) { setLocCfg(null); return; }
    const res = await fetch(`/api/locations/${locId}/electricity-config`);
    if (res.ok) {
      const json = await res.json();
      const cfg = json.data as LocationConfig | null;
      setLocCfg(cfg);
      // Pre-fill line rates from location config
      if (cfg) {
        setLines([
          { line_type: "utility",   units: 0, rate: cfg.landlord_utility_rate,   sort_order: 0 },
          { line_type: "generator", units: 0, rate: cfg.landlord_generator_rate, sort_order: 1 },
        ]);
      }
    }
  };

  const lineAmount = (l: EbLine) =>
    l.line_type === "other" ? (l.amount ?? 0) : (l.units ?? 0) * (l.rate ?? 0);

  const grandTotal = lines.reduce((s, l) => s + lineAmount(l), 0);

  const addLine = () =>
    setLines((ls) => [...ls, { line_type: "other", label: "", amount: 0, sort_order: ls.length }]);

  const removeLine = (i: number) =>
    setLines((ls) => ls.filter((_, idx) => idx !== i).map((l, idx) => ({ ...l, sort_order: idx })));

  const updateLine = (i: number, patch: Partial<EbLine>) =>
    setLines((ls) => ls.map((l, idx) => idx === i ? { ...l, ...patch } : l));

  const handleSubmit = async () => {
    if (!form.location_id) { toast.error("Select a location"); return; }
    if (lines.length === 0) { toast.error("Add at least one line"); return; }
    setSubmitting(true);
    const res = await fetch("/api/electricity-bills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        landlord_bill_number: form.landlord_bill_number || null,
        landlord_bill_date: form.landlord_bill_date || null,
        notes: form.notes || null,
        lines: lines.map((l) => ({
          line_type: l.line_type,
          meter_label: l.meter_label ?? null,
          label: l.label ?? null,
          units: l.line_type !== "other" ? (l.units ?? 0) : null,
          rate: l.line_type !== "other" ? (l.rate ?? 0) : null,
          amount: l.line_type === "other" ? (l.amount ?? 0) : null,
          sort_order: l.sort_order,
        })),
      }),
    });
    const json = await res.json();
    if (res.ok) {
      toast.success("Bill captured");
      setDialogOpen(false);
      setLines([emptyLine()]);
      setForm({ location_id: "", bill_month: new Date().getMonth() + 1, bill_year: new Date().getFullYear(), landlord_bill_number: "", landlord_bill_date: "", notes: "" });
      fetchBills();
    } else {
      const msg = typeof json.error === "object" ? Object.values(json.error).flat().join("; ") : json.error;
      toast.error(msg || "Failed to save");
    }
    setSubmitting(false);
  };

  const handleApprove = async (billId: string) => {
    setApproving(billId);
    const res = await fetch(`/api/electricity-bills/${billId}/approve`, { method: "POST" });
    const json = await res.json();
    if (res.ok) {
      const count = (json.data as { customer_bills_generated: number }).customer_bills_generated ?? 0;
      toast.success(`Approved — ${count} customer bill${count !== 1 ? "s" : ""} generated`);
      fetchBills();
    } else {
      toast.error(json.error || "Approval failed");
    }
    setApproving(null);
  };

  const canApprove = ["admin", "manager"].includes(user?.role ?? "");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Zap className="h-5 w-5" /> Electricity Bills
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Capture monthly landlord electricity bills. Approve to auto-generate customer invoices.
          </p>
        </div>
        {canApprove && (
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> New Bill
          </Button>
        )}
      </div>

      {loading ? (
        <TableSkeleton rows={4} />
      ) : bills.length === 0 ? (
        <EmptyState
          icon={Zap}
          title="No electricity bills"
          description="Capture a landlord bill to get started."
        />
      ) : (
        <div className="space-y-3">
          {bills.map((bill) => (
            <Card key={bill.id}>
              <CardHeader className="py-3 px-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <button
                      className="text-left"
                      onClick={() => setExpanded(expanded === bill.id ? null : bill.id)}
                    >
                      {expanded === bill.id
                        ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                        : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                    </button>
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">
                        {bill.locations?.name ?? bill.location_id} — {MONTH_NAMES[bill.bill_month - 1]} {bill.bill_year}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {bill.landlord_bill_number && `Bill# ${bill.landlord_bill_number} · `}
                        {bill.landlord_bill_date && `${formatDate(bill.landlord_bill_date)} · `}
                        {formatCurrency(bill.landlord_total_amount)}
                        {bill.vendor_bill_id && " · Vendor bill linked"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge className={STATUS_COLORS[bill.status]}>{bill.status}</Badge>
                    {canApprove && bill.status === "draft" && (
                      <Button
                        size="sm"
                        onClick={() => handleApprove(bill.id)}
                        disabled={approving === bill.id}
                      >
                        <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                        {approving === bill.id ? "Approving…" : "Approve & Generate"}
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              {expanded === bill.id && (
                <CardContent className="pt-0 pb-4 px-4">
                  <Separator className="mb-3" />
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground border-b">
                        <th className="text-left pb-1.5 font-medium">Type</th>
                        <th className="text-left pb-1.5 font-medium">Label</th>
                        <th className="text-right pb-1.5 font-medium">Units</th>
                        <th className="text-right pb-1.5 font-medium">Rate</th>
                        <th className="text-right pb-1.5 font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bill.electricity_bill_lines.map((l, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-1.5 capitalize text-muted-foreground">{l.line_type}</td>
                          <td className="py-1.5">{l.meter_label ?? l.label ?? "—"}</td>
                          <td className="py-1.5 text-right">{l.units != null ? l.units : "—"}</td>
                          <td className="py-1.5 text-right">{l.rate != null ? formatCurrency(l.rate) : "—"}</td>
                          <td className="py-1.5 text-right font-medium">{formatCurrency(l.amount ?? 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={4} className="pt-2 text-right font-medium text-sm">Total</td>
                        <td className="pt-2 text-right font-semibold">{formatCurrency(bill.landlord_total_amount)}</td>
                      </tr>
                    </tfoot>
                  </table>
                  <p className="text-xs text-muted-foreground mt-2">Captured {formatDate(bill.created_at)}</p>
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* New bill dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Electricity Bill</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Location + period */}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1 col-span-3">
                <Label>Location</Label>
                <Select
                  value={form.location_id || "none"}
                  onValueChange={(v) => handleLocationChange(v === "none" ? "" : v)}
                >
                  <SelectTrigger><SelectValue placeholder="Select location…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— Select —</SelectItem>
                    {locations.map((l) => (
                      <SelectItem key={l.id} value={l.id}>{l.name} ({l.code})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {locCfg?.service_number && (
                  <p className="text-xs text-muted-foreground">Meter: <span className="font-mono">{locCfg.service_number}</span></p>
                )}
                {locCfg && !locCfg.enabled && (
                  <p className="text-xs text-destructive">Electricity billing is not enabled for this location.</p>
                )}
              </div>
              <div className="space-y-1">
                <Label>Month</Label>
                <Select
                  value={String(form.bill_month)}
                  onValueChange={(v) => setForm((f) => ({ ...f, bill_month: parseInt(v) }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MONTH_NAMES.map((m, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Year</Label>
                <Input
                  type="number" min={2020} max={2099}
                  value={form.bill_year}
                  onChange={(e) => setForm((f) => ({ ...f, bill_year: parseInt(e.target.value) || new Date().getFullYear() }))}
                />
              </div>
              <div className="space-y-1">
                <Label>Bill number</Label>
                <Input
                  placeholder="Optional"
                  value={form.landlord_bill_number}
                  onChange={(e) => setForm((f) => ({ ...f, landlord_bill_number: e.target.value }))}
                />
              </div>
              <div className="space-y-1 col-span-2">
                <Label>Bill date</Label>
                <Input
                  type="date"
                  value={form.landlord_bill_date}
                  onChange={(e) => setForm((f) => ({ ...f, landlord_bill_date: e.target.value }))}
                />
              </div>
            </div>

            <Separator />

            {/* Lines */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Bill Line Items</p>
                <Button variant="outline" size="sm" onClick={addLine}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add line
                </Button>
              </div>
              <div className="rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                      <th className="px-3 py-2 text-left font-medium">Type</th>
                      <th className="px-3 py-2 text-left font-medium">Label / Meter</th>
                      <th className="px-3 py-2 text-right font-medium">Units</th>
                      <th className="px-3 py-2 text-right font-medium">Rate (₹)</th>
                      <th className="px-3 py-2 text-right font-medium">Amount</th>
                      <th className="px-1 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="px-3 py-1.5">
                          <Select
                            value={l.line_type}
                            onValueChange={(v) => updateLine(i, { line_type: v as EbLine["line_type"] })}
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="utility">Grid / Utility</SelectItem>
                              <SelectItem value="generator">DG / Generator</SelectItem>
                              <SelectItem value="other">Other charge</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-3 py-1.5">
                          <Input
                            className="h-8 text-xs"
                            placeholder={l.line_type === "other" ? "Label" : "Meter label (opt.)"}
                            value={l.line_type === "other" ? (l.label ?? "") : (l.meter_label ?? "")}
                            onChange={(e) => updateLine(i, l.line_type === "other"
                              ? { label: e.target.value }
                              : { meter_label: e.target.value }
                            )}
                          />
                        </td>
                        <td className="px-3 py-1.5">
                          {l.line_type !== "other" ? (
                            <Input
                              className="h-8 text-xs text-right"
                              type="number" min={0} step={0.01}
                              value={l.units ?? 0}
                              onChange={(e) => updateLine(i, { units: parseFloat(e.target.value) || 0 })}
                            />
                          ) : <span className="text-muted-foreground text-xs px-1">—</span>}
                        </td>
                        <td className="px-3 py-1.5">
                          {l.line_type !== "other" ? (
                            <Input
                              className="h-8 text-xs text-right"
                              type="number" min={0} step={0.01}
                              value={l.rate ?? 0}
                              onChange={(e) => updateLine(i, { rate: parseFloat(e.target.value) || 0 })}
                            />
                          ) : (
                            <Input
                              className="h-8 text-xs text-right"
                              type="number" min={0} step={0.01}
                              value={l.amount ?? 0}
                              onChange={(e) => updateLine(i, { amount: parseFloat(e.target.value) || 0 })}
                            />
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right font-medium text-xs tabular-nums">
                          {formatCurrency(lineAmount(l))}
                        </td>
                        <td className="px-1 py-1.5">
                          {lines.length > 1 && (
                            <button onClick={() => removeLine(i)} className="text-muted-foreground hover:text-destructive">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/30">
                      <td colSpan={4} className="px-3 py-2 text-right text-sm font-medium">Total</td>
                      <td className="px-3 py-2 text-right text-sm font-semibold tabular-nums">
                        {formatCurrency(grandTotal)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            <div className="space-y-1">
              <Label>Notes</Label>
              <Input
                placeholder="Optional"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? "Saving…" : "Save as Draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
