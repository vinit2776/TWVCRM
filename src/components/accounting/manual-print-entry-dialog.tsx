"use client";

/**
 * ManualPrintEntryDialog
 *
 * Lets admin / accounts / manager enter B&W and colour print page counts for an
 * active contract for a specific billing month. Computes overage against the
 * contract's service quotas and writes to service_usage_records (source='manual').
 *
 * No free-quota configured → monthly_quota treated as 0, ALL pages billed at
 * the centre's standard catalogue rate (default_overage_rate).
 *
 * Re-submitting for the same contract + month replaces the previous manual
 * entry, so corrections are safe.
 *
 * Props
 * ─────
 * defaultContractId  Pre-select a contract (e.g. opened from a contract row).
 * filterLeadId       When set, contract list is scoped to this lead only.
 *                    Enables the "Log Print Usage" button on the lead page.
 */

import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Printer, AlertCircle, Info } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

interface ContractOption {
  id: string;
  contract_number: string;
  lead?: { first_name: string; last_name: string; company?: string };
  location?: { name: string };
}

interface ServiceQuota {
  service_id: string;
  monthly_quota: number;
  overage_rate: number;
  service?: {
    name: string;
    printer_column: string | null;
    unit_label: string;
  };
  usage_this_month: { quantity_used: number; overage_quantity: number } | null;
}

interface ExistingEntry {
  service_id: string;
  quantity_used: number;
  overage_quantity: number;
  amount: number;
}

interface CatalogRates {
  bw: number;
  colour: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  /** Pre-select a contract when opened from a contract row */
  defaultContractId?: string;
  /** Scope contract list to a specific lead (e.g. opened from the lead page) */
  filterLeadId?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function monthLabel(year: number, month: number) {
  return `${MONTHS[month - 1]} ${year}`;
}

function contractLabel(c: ContractOption) {
  const customer = c.lead?.company
    || `${c.lead?.first_name ?? ""} ${c.lead?.last_name ?? ""}`.trim()
    || "Unknown";
  return `${c.contract_number} — ${customer}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ManualPrintEntryDialog({
  open, onOpenChange, onSuccess, defaultContractId, filterLeadId,
}: Props) {
  const now = new Date();
  const [contracts, setContracts]             = useState<ContractOption[]>([]);
  const [contractsLoading, setContractsLoading] = useState(false);
  const [contractId, setContractId]           = useState(defaultContractId ?? "");
  const [periodYear, setPeriodYear]           = useState(now.getFullYear());
  const [periodMonth, setPeriodMonth]         = useState(now.getMonth() + 1);
  const [bwUsed, setBwUsed]                   = useState("");
  const [colourUsed, setColourUsed]           = useState("");
  const [notes, setNotes]                     = useState("");
  const [quotas, setQuotas]                   = useState<ServiceQuota[]>([]);
  const [quotasLoading, setQuotasLoading]     = useState(false);
  const [existing, setExisting]               = useState<ExistingEntry[]>([]);
  const [catalogRates, setCatalogRates]       = useState<CatalogRates | null>(null);
  const [saving, setSaving]                   = useState(false);

  // Load active contracts when dialog opens; scope to lead when filterLeadId given
  useEffect(() => {
    if (!open) return;
    setContractsLoading(true);
    const leadParam = filterLeadId ? `&lead_id=${filterLeadId}` : "";
    // Fetch active + recently terminated (last 3 months) so final-month
    // billing is still possible after a contract ends.
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const sinceDate = threeMonthsAgo.toISOString().slice(0, 10);
    Promise.all([
      fetch(`/api/contracts?status=active&limit=200${leadParam}`).then(r => r.json()),
      fetch(`/api/contracts?status=terminated&limit=200${leadParam}&terminated_after=${sinceDate}`).then(r => r.json()),
    ])
      .then(([activeJson, terminatedJson]) => {
        const combined = [...(activeJson.data || []), ...(terminatedJson.data || [])];
        // Deduplicate by id
        const seen = new Set<string>();
        setContracts(combined.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; }));
      })
      .catch(() => toast.error("Failed to load contracts"))
      .finally(() => setContractsLoading(false));
  }, [open, filterLeadId]);

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) {
      setContractId(defaultContractId ?? "");
      setBwUsed("");
      setColourUsed("");
      setNotes("");
      setQuotas([]);
      setExisting([]);
      setCatalogRates(null);
    }
  }, [open, defaultContractId]);

  // Load quotas + existing entry whenever contract or period changes.
  // The print-usage GET also returns catalogRates so we can always show
  // a cost preview regardless of whether quota rows exist.
  useEffect(() => {
    if (!contractId) { setQuotas([]); setExisting([]); return; }

    setQuotasLoading(true);
    Promise.all([
      fetch(`/api/contracts/${contractId}/quotas`).then(r => r.json()),
      fetch(`/api/accounting/print-usage?contract_id=${contractId}&period_year=${periodYear}&period_month=${periodMonth}`)
        .then(r => r.json()),
    ])
      .then(([quotaJson, existingJson]) => {
        const allQuotas: ServiceQuota[] = quotaJson.data || [];
        // Only show print services (bw / colour)
        const printQuotas = allQuotas.filter(
          q => q.service?.printer_column === "bw" || q.service?.printer_column === "colour"
        );
        setQuotas(printQuotas);
        setExisting(existingJson.data || []);

        // Capture catalogue default rates returned by the GET endpoint
        if (existingJson.catalogRates) {
          setCatalogRates(existingJson.catalogRates);
        }

        // Pre-fill inputs from existing manual entry for this period
        const existingData: ExistingEntry[] = existingJson.data || [];
        const bwEntry = existingData.find(e => {
          const q = (quotaJson.data || []).find((qq: ServiceQuota) => qq.service_id === e.service_id);
          return q?.service?.printer_column === "bw";
        });
        const colourEntry = existingData.find(e => {
          const q = (quotaJson.data || []).find((qq: ServiceQuota) => qq.service_id === e.service_id);
          return q?.service?.printer_column === "colour";
        });
        setBwUsed(bwEntry ? String(bwEntry.quantity_used) : "");
        setColourUsed(colourEntry ? String(colourEntry.quantity_used) : "");
      })
      .catch(() => toast.error("Failed to load quota data"))
      .finally(() => setQuotasLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId, periodYear, periodMonth]);

  // ── Derived overage preview ───────────────────────────────────────────────

  const bwQuota     = quotas.find(q => q.service?.printer_column === "bw");
  const colourQuota = quotas.find(q => q.service?.printer_column === "colour");

  const bwParsed     = parseFloat(bwUsed)     || 0;
  const colourParsed = parseFloat(colourUsed) || 0;

  // When no quota row is configured, free pages = 0 and the rate falls back
  // to the centre's catalogue default. This means all pages are billable.
  const effectiveBwQuota    = bwQuota    ? bwQuota.monthly_quota    : 0;
  const effectiveColourQuota = colourQuota ? colourQuota.monthly_quota : 0;
  const effectiveBwRate     = bwQuota?.overage_rate     ?? catalogRates?.bw     ?? 0;
  const effectiveColourRate = colourQuota?.overage_rate ?? catalogRates?.colour ?? 0;

  const bwOverage     = Math.max(0, bwParsed     - effectiveBwQuota);
  const colourOverage = Math.max(0, colourParsed - effectiveColourQuota);

  const bwAmount     = parseFloat((bwOverage     * effectiveBwRate).toFixed(2));
  const colourAmount = parseFloat((colourOverage * effectiveColourRate).toFixed(2));
  const totalAmount  = bwAmount + colourAmount;

  const isReentry     = existing.length > 0;
  const noPrintQuotas = quotas.length === 0 && !quotasLoading && !!contractId;
  const hasUsage      = bwParsed > 0 || colourParsed > 0;
  const hasRates      = effectiveBwRate > 0 || effectiveColourRate > 0;

  // ── Submit ────────────────────────────────────────────────────────────────

  const submit = async () => {
    if (!contractId) { toast.error("Select a contract"); return; }
    if (!hasUsage)   { toast.error("Enter at least B&W or Colour page count"); return; }

    setSaving(true);
    try {
      const res = await fetch("/api/accounting/print-usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract_id:  contractId,
          period_year:  periodYear,
          period_month: periodMonth,
          bw_used:      bwParsed,
          colour_used:  colourParsed,
          notes:        notes.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save");

      toast.success(`Print usage saved for ${monthLabel(periodYear, periodMonth)}`);
      onSuccess?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  // ── Year options (current year ± 1) ──────────────────────────────────────
  const yearOptions = [now.getFullYear() - 1, now.getFullYear()];

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Printer className="h-4 w-4" />
            Log Print Usage
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">

          {/* Contract selector */}
          <div>
            <Label className="text-xs">Contract</Label>
            <Select value={contractId} onValueChange={setContractId} disabled={contractsLoading || saving}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={contractsLoading ? "Loading…" : "Select active contract"} />
              </SelectTrigger>
              <SelectContent>
                {contracts.map(c => (
                  <SelectItem key={c.id} value={c.id}>
                    {contractLabel(c)}
                    {c.location && (
                      <span className="text-muted-foreground ml-1 text-[11px]">· {c.location.name}</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {contracts.length === 0 && !contractsLoading && (
              <p className="text-[11px] text-muted-foreground mt-1">No active contracts found.</p>
            )}
          </div>

          {/* Period selector */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Year</Label>
              <Select value={String(periodYear)} onValueChange={v => setPeriodYear(parseInt(v))} disabled={saving}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {yearOptions.map(y => (
                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Month</Label>
              <Select value={String(periodMonth)} onValueChange={v => setPeriodMonth(parseInt(v))} disabled={saving}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTHS.map((m, i) => (
                    <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* No quota row notice — informational, not a warning.
              All usage is still billable at the centre's standard rate. */}
          {noPrintQuotas && catalogRates && (
            <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                No free quota set for this contract — all pages billed at standard rate
                {(catalogRates.bw > 0 || catalogRates.colour > 0) && (
                  <> (B&W: {formatCurrency(catalogRates.bw)}/page · Colour: {formatCurrency(catalogRates.colour)}/page)</>
                )}.
              </span>
            </div>
          )}

          {/* Re-entry notice */}
          {isReentry && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>Existing entry for {monthLabel(periodYear, periodMonth)} found — submitting will replace it.</span>
            </div>
          )}

          {/* Page count inputs */}
          {quotasLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading quota data…
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {/* B&W */}
              <div>
                <Label className="text-xs">
                  B&W Pages
                  {bwQuota ? (
                    <span className="ml-1 text-muted-foreground font-normal">
                      (quota: {bwQuota.monthly_quota.toLocaleString()})
                    </span>
                  ) : effectiveBwRate > 0 ? (
                    <span className="ml-1 text-muted-foreground font-normal">
                      ({formatCurrency(effectiveBwRate)}/page)
                    </span>
                  ) : null}
                </Label>
                <Input
                  type="number" min="0" step="1"
                  placeholder="0"
                  value={bwUsed}
                  onChange={e => setBwUsed(e.target.value)}
                  className="mt-1"
                  disabled={saving}
                />
                {bwParsed > 0 && hasRates && (
                  <p className="text-[11px] mt-0.5 text-muted-foreground">
                    {bwQuota ? (
                      <>
                        Overage:{" "}
                        <span className={bwOverage > 0 ? "text-red-600 font-medium" : "text-green-700"}>
                          {bwOverage > 0
                            ? `${bwOverage.toLocaleString()} pages → ${formatCurrency(bwAmount)}`
                            : "within quota"}
                        </span>
                      </>
                    ) : (
                      // No quota row → all pages are billable at catalogue rate
                      <span className="text-red-600 font-medium">
                        {bwParsed.toLocaleString()} pages → {formatCurrency(bwAmount)}
                      </span>
                    )}
                  </p>
                )}
              </div>

              {/* Colour */}
              <div>
                <Label className="text-xs">
                  Colour Pages
                  {colourQuota ? (
                    <span className="ml-1 text-muted-foreground font-normal">
                      (quota: {colourQuota.monthly_quota.toLocaleString()})
                    </span>
                  ) : effectiveColourRate > 0 ? (
                    <span className="ml-1 text-muted-foreground font-normal">
                      ({formatCurrency(effectiveColourRate)}/page)
                    </span>
                  ) : null}
                </Label>
                <Input
                  type="number" min="0" step="1"
                  placeholder="0"
                  value={colourUsed}
                  onChange={e => setColourUsed(e.target.value)}
                  className="mt-1"
                  disabled={saving}
                />
                {colourParsed > 0 && hasRates && (
                  <p className="text-[11px] mt-0.5 text-muted-foreground">
                    {colourQuota ? (
                      <>
                        Overage:{" "}
                        <span className={colourOverage > 0 ? "text-red-600 font-medium" : "text-green-700"}>
                          {colourOverage > 0
                            ? `${colourOverage.toLocaleString()} pages → ${formatCurrency(colourAmount)}`
                            : "within quota"}
                        </span>
                      </>
                    ) : (
                      <span className="text-red-600 font-medium">
                        {colourParsed.toLocaleString()} pages → {formatCurrency(colourAmount)}
                      </span>
                    )}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Total preview */}
          {hasUsage && totalAmount > 0 && (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm flex items-center justify-between">
              <span className="text-muted-foreground">Total charge (ex-GST)</span>
              <Badge variant="secondary" className="bg-red-50 text-red-700 border-red-200">
                {formatCurrency(totalAmount)}
              </Badge>
            </div>
          )}
          {hasUsage && totalAmount === 0 && bwQuota && colourQuota && (
            <div className="rounded-md border bg-green-50 px-3 py-2 text-xs text-green-700">
              All pages are within the free quota — no charge for this period.
            </div>
          )}

          {/* Notes */}
          <div>
            <Label className="text-xs">Notes (optional)</Label>
            <Input
              placeholder="e.g. Print room meter reading on 31st"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              className="mt-1"
              disabled={saving}
            />
          </div>
        </div>

        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !contractId || !hasUsage}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {isReentry ? "Update Entry" : "Save Entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
