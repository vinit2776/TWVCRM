"use client";

/**
 * LogFacilityUsageDialog
 *
 * Lets admin / accounts / manager enter meeting-room / facility usage
 * quantities for an active contract for a specific accounting period.
 * Computes overage against each facility's free_quota and writes to
 * facility_usage_records — the same table and API the old "Contracts" tab's
 * per-contract accordion used, before that tab's TabsTrigger was removed and
 * left this capture step with no reachable page. This dialog is the new
 * reachable page, mirroring ManualPrintEntryDialog's pattern (contract
 * picker, year/month, overage preview, "safe to re-enter" idempotent save)
 * rather than resurrecting the old accordion.
 *
 * Unlike print quotas (one fixed pair of services per contract),
 * facility_usage_records is keyed on contract_facility_id — a contract can
 * have any number of facilities configured (meeting rooms, manpower, etc.),
 * so this shows one row per active facility on the selected contract.
 *
 * Re-submitting for the same contract + facility + period replaces the
 * previous entry (the API upserts on that triple), so corrections are safe.
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
import { Loader2, Building2, AlertCircle, Lock } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

interface ContractOption {
  id: string;
  contract_number: string;
  lead?: { first_name: string; last_name: string; company?: string };
  location?: { name: string };
}

interface FacilityDef {
  id: string;
  name: string;
  unit: string;
  free_quota: number;
  cost_per_unit: number;
}

interface ExistingUsage {
  contract_facility_id: string;
  quantity_used: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  /** Pre-select a contract when opened from a contract row */
  defaultContractId?: string;
  /** Scope contract list to a specific lead (e.g. opened from the lead page) */
  filterLeadId?: string;
  /** Period to pre-select on open — e.g. the month picked on the Billing
   *  page — instead of the real current month. Still editable. */
  defaultPeriod?: { year: number; month: number };
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

export function LogFacilityUsageDialog({
  open, onOpenChange, onSuccess, defaultContractId, filterLeadId, defaultPeriod,
}: Props) {
  const now = new Date();
  const [contracts, setContracts]               = useState<ContractOption[]>([]);
  const [contractsLoading, setContractsLoading] = useState(false);
  const [contractId, setContractId]             = useState(defaultContractId ?? "");
  const [periodYear, setPeriodYear]             = useState(now.getFullYear());
  const [periodMonth, setPeriodMonth]           = useState(now.getMonth() + 1);
  const defaultYear = defaultPeriod?.year;
  const defaultMonth = defaultPeriod?.month;
  useEffect(() => {
    if (!open || !defaultYear || !defaultMonth) return;
    setPeriodYear(defaultYear);
    setPeriodMonth(defaultMonth);
  }, [open, defaultYear, defaultMonth]);
  const [facilities, setFacilities]             = useState<FacilityDef[]>([]);
  const [facilitiesLoading, setFacilitiesLoading] = useState(false);
  const [existing, setExisting]                 = useState<ExistingUsage[]>([]);
  const [values, setValues]                     = useState<Record<string, string>>({});
  const [periodLocked, setPeriodLocked]         = useState(false);
  const [saving, setSaving]                     = useState(false);

  // Load active contracts when dialog opens; scope to lead when filterLeadId given
  useEffect(() => {
    if (!open) return;
    setContractsLoading(true);
    const leadParam = filterLeadId ? `&lead_id=${filterLeadId}` : "";
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const sinceDate = threeMonthsAgo.toISOString().slice(0, 10);
    Promise.all([
      fetch(`/api/contracts?status=active,renewal_in_progress&limit=200${leadParam}`).then(r => r.json()),
      fetch(`/api/contracts?status=terminated&limit=200${leadParam}&terminated_after=${sinceDate}`).then(r => r.json()),
    ])
      .then(([activeJson, terminatedJson]) => {
        const combined = [...(activeJson.data || []), ...(terminatedJson.data || [])];
        const seen = new Set<string>();
        setContracts(combined.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; }));
      })
      .catch(() => toast.error("Failed to load contracts"))
      .finally(() => setContractsLoading(false));
  }, [open, filterLeadId]);

  useEffect(() => {
    if (open && defaultContractId) setContractId(defaultContractId);
  }, [open, defaultContractId]);

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) {
      setContractId(defaultContractId ?? "");
      setFacilities([]);
      setExisting([]);
      setValues({});
      setPeriodLocked(false);
    }
  }, [open, defaultContractId]);

  // Load this contract's facilities + this period's existing entries whenever
  // contract or period changes. Facilities come from contract_facilities
  // directly (not from facility_usage_records) so every configured facility
  // shows up here even if it's never had usage logged before.
  useEffect(() => {
    if (!contractId) { setFacilities([]); setExisting([]); return; }

    setFacilitiesLoading(true);
    Promise.all([
      fetch(`/api/accounting/contract-facilities?contract_id=${contractId}`).then(r => r.json()),
      fetch(`/api/accounting/periods?year=${periodYear}&month=${periodMonth}`).then(r => r.json()),
    ])
      .then(async ([facilitiesJson, periodJson]) => {
        setFacilities(facilitiesJson.data || []);
        const period = periodJson.data;
        setPeriodLocked(period?.status === "locked");
        if (!period?.id) { setExisting([]); return; }

        const usageJson = await fetch(
          `/api/accounting/facility-usage?accounting_period_id=${period.id}&contract_id=${contractId}`
        ).then(r => r.json());
        const existingData: ExistingUsage[] = (usageJson.data || []).filter(
          (u: { is_template?: boolean }) => !u.is_template
        );
        setExisting(existingData);
        const prefill: Record<string, string> = {};
        for (const e of existingData) prefill[e.contract_facility_id] = String(e.quantity_used);
        setValues(prefill);
      })
      .catch(() => toast.error("Failed to load facility data"))
      .finally(() => setFacilitiesLoading(false));
  }, [contractId, periodYear, periodMonth]);

  const overageFor = (facility: FacilityDef) => {
    const used = parseFloat(values[facility.id]) || 0;
    const billable = Math.max(0, used - facility.free_quota);
    return { used, billable, charge: billable * facility.cost_per_unit };
  };

  const totalCharge = facilities.reduce((sum, f) => sum + overageFor(f).charge, 0);

  // Only save rows the user actually changed from what's on file — re-saving
  // an untouched, already-correct value is a harmless no-op skip, not a bug.
  const changedFacilityIds = facilities
    .filter((f) => {
      const existingQty = existing.find((e) => e.contract_facility_id === f.id)?.quantity_used;
      const inputVal = values[f.id];
      if (inputVal === undefined || inputVal === "") return false;
      return parseFloat(inputVal) !== (existingQty ?? -1);
    })
    .map((f) => f.id);

  const submit = async () => {
    if (!contractId) { toast.error("Select a contract"); return; }
    if (changedFacilityIds.length === 0) { toast.error("Enter a quantity for at least one facility"); return; }

    setSaving(true);
    try {
      const periodJson = await fetch(`/api/accounting/periods?year=${periodYear}&month=${periodMonth}`).then(r => r.json());
      const periodId = periodJson.data?.id;
      if (!periodId) throw new Error("Could not resolve the accounting period");

      const results = await Promise.all(changedFacilityIds.map((facilityId) =>
        fetch("/api/accounting/facility-usage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accounting_period_id: periodId,
            contract_id: contractId,
            contract_facility_id: facilityId,
            quantity_used: parseFloat(values[facilityId]) || 0,
          }),
        }).then(async (res) => ({ ok: res.ok, error: res.ok ? null : (await res.json()).error }))
      ));

      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        toast.error(failed[0].error || "Some entries failed to save");
        if (failed.length < results.length) onSuccess?.();
        return;
      }

      toast.success(`Facility usage saved for ${monthLabel(periodYear, periodMonth)}`);
      onSuccess?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const yearOptions = [...new Set([periodYear, now.getFullYear() - 1, now.getFullYear()])].sort();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            Log Facility Usage
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
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {yearOptions.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Month</Label>
              <Select value={String(periodMonth)} onValueChange={v => setPeriodMonth(parseInt(v))} disabled={saving}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MONTHS.map((m, i) => <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {periodLocked && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <Lock className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{monthLabel(periodYear, periodMonth)} is locked — facility usage cannot be logged for a locked period.</span>
            </div>
          )}

          {!contractId ? null : facilitiesLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading facilities…
            </div>
          ) : facilities.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No facilities configured for this contract — add one under the contract&rsquo;s Facilities section first.
            </p>
          ) : (
            <div className="space-y-3">
              {facilities.map((f) => {
                const { used, billable, charge } = overageFor(f);
                return (
                  <div key={f.id}>
                    <Label className="text-xs">
                      {f.name}
                      <span className="ml-1 text-muted-foreground font-normal">
                        (free: {f.free_quota} {f.unit} · {formatCurrency(f.cost_per_unit)}/{f.unit})
                      </span>
                    </Label>
                    <Input
                      type="number" min="0" step="0.5"
                      placeholder="0"
                      value={values[f.id] ?? ""}
                      onChange={(e) => setValues((prev) => ({ ...prev, [f.id]: e.target.value }))}
                      className="mt-1"
                      disabled={saving || periodLocked}
                    />
                    {used > 0 && (
                      <p className="text-[11px] mt-0.5 text-muted-foreground">
                        {billable > 0 ? (
                          <span className="text-red-600 font-medium">
                            {billable} {f.unit} over quota → {formatCurrency(charge)}
                          </span>
                        ) : (
                          <span className="text-green-700">within quota</span>
                        )}
                      </p>
                    )}
                  </div>
                );
              })}

              {changedFacilityIds.length > 0 && (
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm flex items-center justify-between">
                  <span className="text-muted-foreground">Total charge (ex-GST)</span>
                  <Badge variant="secondary" className="bg-red-50 text-red-700 border-red-200">
                    {formatCurrency(totalCharge)}
                  </Badge>
                </div>
              )}
            </div>
          )}

          {existing.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>Existing entries for {monthLabel(periodYear, periodMonth)} found — saving will replace the ones you change.</span>
            </div>
          )}
        </div>

        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !contractId || periodLocked || changedFacilityIds.length === 0}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Save Entry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
