"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Zap, ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { computeElectricityBill } from "@/lib/electricity";
import { toast } from "sonner";
import { useCurrentUser } from "@/providers/current-user-provider";

// ── Local types (mirrors DB schema, no dependency on unmerged feat/eb-schema) ──
interface EbLine {
  id?: string;
  line_type: "utility" | "generator" | "other";
  meter_label?: string | null;
  label?: string | null;
  units?: number | null;
  rate?: number | null;
  amount: number;
  sort_order: number;
}

interface EbBill {
  id: string;
  location_id: string;
  bill_month: number;
  bill_year: number;
  status: "draft" | "invoiced" | "revised";
  landlord_bill_number?: string | null;
  landlord_bill_date?: string | null;
  landlord_total_amount: number;
  reimbursement_enabled: boolean;
  customer_subtotal?: number | null;
  customer_total?: number | null;
  vendor_bill_id?: string | null;
  billing_statement_id?: string | null;
  created_at: string;
  electricity_bill_lines: EbLine[];
  locations?: { id: string; name: string; code: string };
  created_by_user?: { id: string; full_name: string };
}

interface LocationOption {
  id: string;
  name: string;
  code: string;
}

// ── Form line state ────────────────────────────────────────────────────────────
interface FormLine {
  key: number;
  line_type: "utility" | "generator" | "other";
  meter_label: string;
  label: string;
  units: string;
  rate: string;
  amount: string; // for 'other' lines
}

const LINE_TYPE_LABELS: Record<string, string> = {
  utility: "Utility (EB)",
  generator: "Generator (DG)",
  other: "Other",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-yellow-100 text-yellow-700 border-yellow-200",
  invoiced: "bg-green-100 text-green-700 border-green-200",
  revised: "bg-gray-100 text-gray-500 border-gray-200",
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function defaultLines(): FormLine[] {
  return [
    { key: 1, line_type: "utility", meter_label: "", label: "", units: "", rate: "", amount: "" },
    { key: 2, line_type: "generator", meter_label: "", label: "", units: "", rate: "", amount: "" },
  ];
}

// ── Sub-component: live compute preview ───────────────────────────────────────
function BillPreview({
  lines,
  config,
}: {
  lines: FormLine[];
  config: Record<string, unknown> | null;
}) {
  if (!config) return null;

  const computeLines = lines
    .filter((l) => l.line_type !== "other" && l.units && l.rate)
    .map((l) => ({
      line_type: l.line_type as "utility" | "generator",
      units: parseFloat(l.units) || 0,
      landlord_rate: parseFloat(l.rate) || 0,
    }));

  const otherTotal = lines
    .filter((l) => l.line_type === "other")
    .reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);

  if (computeLines.length === 0 && otherTotal === 0) return null;

  const markupType = (config.markup_type as string) === "percent" ? "percent" : "per_unit";
  const markupValue = Number(config.markup_value ?? 0);
  // Location-level config carries one markup value (no profile assigned yet at
  // landlord-capture time) — applied to both line types as a best-effort estimate.
  const result = computeElectricityBill(
    {
      reimbursement_enabled: Boolean(config.reimbursement_enabled),
      customer_utility_pct: Number(config.customer_utility_pct ?? 80),
      customer_generator_pct: Number(config.customer_generator_pct ?? 20),
      utility_markup_type: markupType,
      utility_markup_value: markupValue,
      generator_markup_type: markupType,
      generator_markup_value: markupValue,
      landlord_gst_rate: config.landlord_gst_applicable ? Number(config.landlord_gst_rate ?? 0) : 0,
      landlord_tds_rate: Number(config.tds_rate ?? 0),
    },
    computeLines,
  );

  const landlordTotal = result.landlord_subtotal + otherTotal;

  return (
    <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
      <Card className="border-orange-200 bg-orange-50/40">
        <CardHeader className="pb-2 pt-3 px-4">
          <CardTitle className="text-xs font-semibold text-orange-800 uppercase tracking-wide">
            Landlord Vendor Bill
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3 space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span>{formatCurrency(landlordTotal)}</span>
          </div>
          {result.landlord_gst > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">GST ({Number(config.landlord_gst_rate)}%)</span>
              <span>{formatCurrency(result.landlord_gst)}</span>
            </div>
          )}
          {result.landlord_tds > 0 && (
            <div className="flex justify-between text-red-600">
              <span>TDS deduction</span>
              <span>− {formatCurrency(result.landlord_tds)}</span>
            </div>
          )}
          <Separator className="my-1" />
          <div className="flex justify-between font-semibold">
            <span>Net Payable</span>
            <span>{formatCurrency(result.landlord_net_payable)}</span>
          </div>
        </CardContent>
      </Card>

      {Boolean(config.reimbursement_enabled) && (
        <Card className="border-blue-200 bg-blue-50/40">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-xs font-semibold text-blue-800 uppercase tracking-wide">
              Customer Statement
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3 space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{formatCurrency(result.customer_subtotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                CGST {formatCurrency(result.customer_gst.cgst)} + SGST{" "}
                {formatCurrency(result.customer_gst.sgst)}
              </span>
              <span>{formatCurrency(result.customer_gst.taxAmount)}</span>
            </div>
            {result.customer_gst.roundOff !== 0 && (
              <div className="flex justify-between text-muted-foreground text-xs">
                <span>Round-off</span>
                <span>{result.customer_gst.roundOff > 0 ? "+" : ""}{formatCurrency(result.customer_gst.roundOff)}</span>
              </div>
            )}
            <Separator className="my-1" />
            <div className="flex justify-between font-semibold">
              <span>Total</span>
              <span>{formatCurrency(result.customer_total)}</span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export function ElectricityBillsTab() {
  const { user } = useCurrentUser();
  const canCapture = user?.role === "admin" || user?.role === "manager" || user?.role === "accounts";

  const now = new Date();
  const [filterLocationId, setFilterLocationId] = useState<string>("all");
  const [filterMonth, setFilterMonth] = useState(now.getMonth() + 1);
  const [filterYear, setFilterYear] = useState(now.getFullYear());
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [bills, setBills] = useState<EbBill[]>([]);
  const [loading, setLoading] = useState(true);

  // Capture dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formLocationId, setFormLocationId] = useState<string>("");
  const [formMonth, setFormMonth] = useState(now.getMonth() + 1);
  const [formYear, setFormYear] = useState(now.getFullYear());
  const [formLandlordBillNumber, setFormLandlordBillNumber] = useState("");
  const [formLandlordBillDate, setFormLandlordBillDate] = useState("");
  const [formLines, setFormLines] = useState<FormLine[]>(defaultLines);
  const [formConfig, setFormConfig] = useState<Record<string, unknown> | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lineKey, setLineKey] = useState(3);

  // ── Fetch locations once ────────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/locations?is_active=true")
      .then((r) => r.json())
      .then((j) => setLocations(j.data || []))
      .catch(() => {});
  }, []);

  // ── Fetch bills ─────────────────────────────────────────────────────────────
  const fetchBills = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      month: String(filterMonth),
      year: String(filterYear),
    });
    if (filterLocationId !== "all") params.set("location_id", filterLocationId);
    const res = await fetch(`/api/electricity-bills?${params}`);
    if (res.ok) {
      const j = await res.json();
      setBills(j.data || []);
    }
    setLoading(false);
  }, [filterLocationId, filterMonth, filterYear]);

  useEffect(() => { fetchBills(); }, [fetchBills]);

  // ── Fetch config when form location changes ─────────────────────────────────
  useEffect(() => {
    if (!formLocationId) { setFormConfig(null); return; }
    setConfigLoading(true);
    fetch(`/api/locations/${formLocationId}/electricity-config`)
      .then((r) => r.json())
      .then((j) => setFormConfig(j.data))
      .catch(() => setFormConfig(null))
      .finally(() => setConfigLoading(false));
  }, [formLocationId]);

  // ── Dialog helpers ──────────────────────────────────────────────────────────
  const openDialog = () => {
    setFormLocationId(filterLocationId !== "all" ? filterLocationId : (locations[0]?.id ?? ""));
    setFormMonth(filterMonth);
    setFormYear(filterYear);
    setFormLandlordBillNumber("");
    setFormLandlordBillDate("");
    setFormLines(defaultLines());
    setLineKey(3);
    setDialogOpen(true);
  };

  const addLine = () => {
    setFormLines((prev) => [
      ...prev,
      { key: lineKey, line_type: "other", meter_label: "", label: "", units: "", rate: "", amount: "" },
    ]);
    setLineKey((k) => k + 1);
  };

  const removeLine = (key: number) => setFormLines((prev) => prev.filter((l) => l.key !== key));

  const updateLine = (key: number, patch: Partial<FormLine>) =>
    setFormLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  // ── Submit ──────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!formLocationId) { toast.error("Select a location"); return; }

    const apiLines = formLines.map((l, i) => ({
      line_type: l.line_type,
      meter_label: l.meter_label || null,
      label: l.label || null,
      units: l.line_type !== "other" ? (parseFloat(l.units) || null) : null,
      rate: l.line_type !== "other" ? (parseFloat(l.rate) || null) : null,
      amount: l.line_type === "other" ? (parseFloat(l.amount) || null) : null,
      sort_order: i,
    }));

    setSubmitting(true);
    const res = await fetch("/api/electricity-bills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location_id: formLocationId,
        bill_month: formMonth,
        bill_year: formYear,
        landlord_bill_number: formLandlordBillNumber || null,
        landlord_bill_date: formLandlordBillDate || null,
        lines: apiLines,
      }),
    });

    const json = await res.json();
    setSubmitting(false);

    if (!res.ok) {
      const msg = typeof json.error === "string" ? json.error : JSON.stringify(json.error);
      toast.error(msg || "Failed to save bill");
      return;
    }

    toast.success(
      json.data.vendor_bill_id
        ? "Bill captured — landlord vendor bill created automatically"
        : "Bill captured (no vendor linked — create vendor bill manually)",
    );
    setDialogOpen(false);
    fetchBills();
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  const years = Array.from({ length: 4 }, (_, i) => now.getFullYear() - i);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={filterLocationId} onValueChange={setFilterLocationId}>
            <SelectTrigger className="h-9 w-[180px] text-sm">
              <SelectValue placeholder="All locations" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All locations</SelectItem>
              {locations.map((l) => (
                <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={String(filterMonth)} onValueChange={(v) => setFilterMonth(Number(v))}>
            <SelectTrigger className="h-9 w-[130px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTHS.map((m, i) => (
                <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={String(filterYear)} onValueChange={(v) => setFilterYear(Number(v))}>
            <SelectTrigger className="h-9 w-[90px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {canCapture && (
          <Button size="sm" onClick={openDialog}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Capture Bill
          </Button>
        )}
      </div>

      {/* List */}
      {loading ? (
        <TableSkeleton rows={4} />
      ) : bills.length === 0 ? (
        <EmptyState
          icon={Zap}
          title="No electricity bills"
          description={`No bills found for ${MONTHS[filterMonth - 1]} ${filterYear}`}
        />
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="px-4 py-2.5 text-left font-medium">Location</th>
                <th className="px-4 py-2.5 text-left font-medium">Period</th>
                <th className="px-4 py-2.5 text-right font-medium hidden sm:table-cell">Landlord Total</th>
                <th className="px-4 py-2.5 text-right font-medium hidden sm:table-cell">Customer Total</th>
                <th className="px-4 py-2.5 text-center font-medium">Status</th>
                <th className="px-4 py-2.5 text-left font-medium hidden md:table-cell">Captured</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => (
                <tr key={b.id} className="border-b hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3">
                    <span className="font-medium">{b.locations?.name ?? "—"}</span>
                    {b.landlord_bill_number && (
                      <div className="text-xs text-muted-foreground">{b.landlord_bill_number}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {MONTHS[b.bill_month - 1]} {b.bill_year}
                  </td>
                  <td className="px-4 py-3 text-right hidden sm:table-cell font-mono">
                    {formatCurrency(b.landlord_total_amount)}
                  </td>
                  <td className="px-4 py-3 text-right hidden sm:table-cell font-mono">
                    {b.reimbursement_enabled && b.customer_total != null
                      ? formatCurrency(b.customer_total)
                      : <span className="text-muted-foreground text-xs">Vendor-only</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Badge className={STATUS_COLORS[b.status] ?? ""}>
                      {b.status.charAt(0).toUpperCase() + b.status.slice(1)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs hidden md:table-cell">
                    <div>{b.created_by_user?.full_name ?? "—"}</div>
                    <div>{formatDate(b.created_at)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Capture Dialog ─────────────────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Capture Electricity Bill</DialogTitle>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* Location + Period */}
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-3 sm:col-span-1 space-y-1.5">
                <Label>Location</Label>
                <Select value={formLocationId} onValueChange={setFormLocationId}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="Select location" />
                  </SelectTrigger>
                  <SelectContent>
                    {locations.map((l) => (
                      <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Month</Label>
                <Select value={String(formMonth)} onValueChange={(v) => setFormMonth(Number(v))}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTHS.map((m, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Year</Label>
                <Select value={String(formYear)} onValueChange={(v) => setFormYear(Number(v))}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {years.map((y) => (
                      <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Config status */}
            {formLocationId && (
              configLoading ? (
                <div className="text-xs text-muted-foreground animate-pulse">Loading config…</div>
              ) : !formConfig ? (
                <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                  No electricity config found for this location. Configure it under Location → Electricity tab first.
                </div>
              ) : !formConfig.enabled ? (
                <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                  Electricity billing is disabled for this location.
                </div>
              ) : (
                <div className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
                  Config loaded — markup: {formConfig.markup_type === "per_unit"
                    ? `₹${formConfig.markup_value}/unit`
                    : `${formConfig.markup_value}%`}
                  {formConfig.reimbursement_enabled ? " · reimbursement on" : " · vendor bill only"}
                </div>
              )
            )}

            {/* Landlord reference */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Landlord Bill No. <span className="text-muted-foreground">(optional)</span></Label>
                <Input
                  value={formLandlordBillNumber}
                  onChange={(e) => setFormLandlordBillNumber(e.target.value)}
                  placeholder="e.g. BESCOM-2026-06"
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Landlord Bill Date <span className="text-muted-foreground">(optional)</span></Label>
                <Input
                  type="date"
                  value={formLandlordBillDate}
                  onChange={(e) => setFormLandlordBillDate(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
            </div>

            {/* Lines */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-semibold">Charge Lines</Label>
                <Button type="button" variant="outline" size="sm" onClick={addLine}>
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Add Line
                </Button>
              </div>

              <div className="space-y-2">
                {formLines.map((line) => (
                  <div key={line.key} className="border rounded-lg p-3 space-y-2 bg-muted/20">
                    <div className="flex items-center justify-between gap-2">
                      <Select
                        value={line.line_type}
                        onValueChange={(v) => updateLine(line.key, { line_type: v as FormLine["line_type"] })}
                      >
                        <SelectTrigger className="h-8 w-[160px] text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(LINE_TYPE_LABELS).map(([k, v]) => (
                            <SelectItem key={k} value={k}>{v}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Input
                        value={line.meter_label}
                        onChange={(e) => updateLine(line.key, { meter_label: e.target.value })}
                        placeholder="Meter label (optional)"
                        className="h-8 text-sm flex-1"
                      />

                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive shrink-0"
                        onClick={() => removeLine(line.key)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>

                    {line.line_type === "other" ? (
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          value={line.label}
                          onChange={(e) => updateLine(line.key, { label: e.target.value })}
                          placeholder="Description"
                          className="h-8 text-sm"
                        />
                        <div className="relative">
                          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">₹</span>
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            value={line.amount}
                            onChange={(e) => updateLine(line.key, { amount: e.target.value })}
                            placeholder="Amount"
                            className="h-8 text-sm pl-6"
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <span className="text-xs text-muted-foreground">Units (kWh / Ltrs)</span>
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            value={line.units}
                            onChange={(e) => updateLine(line.key, { units: e.target.value })}
                            placeholder="0"
                            className="h-8 text-sm"
                          />
                        </div>
                        <div className="space-y-1">
                          <span className="text-xs text-muted-foreground">Landlord Rate (₹/unit)</span>
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            value={line.rate}
                            onChange={(e) => updateLine(line.key, { rate: e.target.value })}
                            placeholder="0.00"
                            className="h-8 text-sm"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Live preview */}
            <BillPreview lines={formLines} config={formConfig} />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting || !formLocationId || !formConfig?.enabled}
            >
              {submitting ? "Saving…" : "Save Bill"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
