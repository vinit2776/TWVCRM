"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Search, SlidersHorizontal, X, Download, ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select";
import {
  type BillFilters, EMPTY_FILTERS, filtersToParams, parseBillFilters,
  countActiveFilters, describeFilterChips, CHIP_RESET_GROUPS, hasAnyFilter,
} from "@/lib/bill-search";

interface BillSearchBarProps {
  /**
   * Filters baked into every search (e.g. payables page always sets
   * approval_status='approved' + payment_status_neq='paid'). These are
   * merged into the query but hidden from the UI.
   */
  baseFilters?: Partial<BillFilters>;
  /** Called with the merged filters object whenever search/filter changes. */
  onChange: (filters: BillFilters) => void;
  /** Initial filters (typically parsed from URL query string by the caller). */
  initialFilters?: Partial<BillFilters>;
  /** Whether to show the "Export CSV" button. */
  showExport?: boolean;
  /** Placeholder text for the search input. */
  placeholder?: string;
}

/**
 * Reusable search bar for the bill list pages.
 *
 * Layout:
 *   [ 🔍 search input … ] [ More filters (n) ▾ ] [ Export ⬇ ]
 *   ──── when expanded ─────
 *   Approval [ ▾ ]  Payment [ ▾ ]  Has IRN [ ▾ ]  Batch type [ ▾ ]
 *   Invoice date  [from] [to]
 *   Due date      [from] [to]
 *   Approved      [from] [to]
 *   Amount        [min]  [max]
 *   [ Clear all ]  [ Apply ]
 *
 * Below: active filter chips, each dismissible.
 */
export function BillSearchBar({
  baseFilters,
  onChange,
  initialFilters,
  showExport,
  placeholder,
}: BillSearchBarProps) {
  const [filters, setFilters] = useState<BillFilters>(() => ({
    ...EMPTY_FILTERS,
    ...(initialFilters ?? {}),
  }));
  // Draft of filters shown inside the expanded panel — only applied on "Apply"
  const [draft, setDraft] = useState<BillFilters>(filters);
  const [expanded, setExpanded] = useState(false);
  const fired = useRef(false);

  // Vendor list for the Vendor filter — fetched once, lazily, when the panel first opens.
  const [vendorOptions, setVendorOptions] = useState<SearchableSelectOption[]>([]);
  const vendorsFetched = useRef(false);
  useEffect(() => {
    if ((!expanded && !filters.vendor_id) || vendorsFetched.current) return;
    vendorsFetched.current = true;
    fetch("/api/procurement/vendors")
      .then((r) => r.json())
      .then((j) => {
        const opts: SearchableSelectOption[] = (j.data ?? []).map((v: { id: string; name: string }) => ({
          value: v.id,
          label: v.name,
        }));
        setVendorOptions(opts);
      })
      .catch(() => { /* non-fatal — vendor filter just stays empty */ });
  }, [expanded]);
  const vendorLookup = useMemo(
    () => Object.fromEntries(vendorOptions.map((v) => [v.value, v.label])),
    [vendorOptions]
  );

  // Debounce the search text for the always-on input.
  // 500ms gives comfortable buffer for moderate typists.
  // Functional update compares against latest state at fire time so we don't
  // need filters.q in the dep array (which caused unnecessary timer resets).
  const [qInput, setQInput] = useState(filters.q);
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((prev) => {
        if (prev.q === qInput) return prev; // nothing changed — skip re-render
        return { ...prev, q: qInput, page: "1" };
      });
    }, 900);
    return () => clearTimeout(t);
  }, [qInput]);

  // Fire onChange whenever applied filters change (skip first render to avoid double-fetch)
  useEffect(() => {
    if (!fired.current) { fired.current = true; return; }
    const merged: BillFilters = { ...filters, ...(baseFilters as Partial<BillFilters> ?? {}) };
    onChange(merged);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const applyDraft = useCallback(() => {
    setFilters({ ...draft, q: qInput, page: "1" });
    setExpanded(false);
  }, [draft, qInput]);

  const resetAll = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    setDraft(EMPTY_FILTERS);
    setQInput("");
    setExpanded(false);
  }, []);

  const removeChip = useCallback((key: keyof BillFilters) => {
    const keys = CHIP_RESET_GROUPS[key] ?? [key];
    // Keep qInput in sync when the search-text chip is dismissed so the
    // debounce timer doesn't re-add it after the chip removal.
    if (keys.includes("q")) setQInput("");
    setFilters((prev) => {
      const next = { ...prev };
      for (const k of keys) (next as Record<string, string>)[k] = "";
      next.page = "1";
      return next;
    });
    setDraft((prev) => {
      const next = { ...prev };
      for (const k of keys) (next as Record<string, string>)[k] = "";
      return next;
    });
  }, []);

  const chips = useMemo(
    () => describeFilterChips(filters, { vendors: vendorLookup }),
    [filters, vendorLookup]
  );
  const activeCount = countActiveFilters(filters);

  const handleExport = useCallback(() => {
    const merged: BillFilters = { ...filters, ...(baseFilters as Partial<BillFilters> ?? {}) };
    const params = filtersToParams(merged);
    // Strip pagination from export so the user gets all matching rows (capped at 5000 server-side)
    params.delete("page");
    params.delete("limit");
    window.location.href = `/api/procurement/bills/export?${params.toString()}`;
  }, [filters, baseFilters]);

  return (
    <div className="space-y-2">
      {/* Top row: search + filter toggle + export */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder={placeholder ?? "Search by bill #, invoice #, vendor, PO, notes…"}
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className="pl-9 h-9"
          />
          {qInput && (
            <button
              type="button"
              onClick={() => setQInput("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setExpanded((v) => !v)}
          className="gap-1.5"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          More filters
          {activeCount > 0 && (
            <span className="bg-primary text-primary-foreground text-[10px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
              {activeCount}
            </span>
          )}
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </Button>
        {showExport && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            className="gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        )}
      </div>

      {/* Active filter chips */}
      {(chips.length > 0 || filters.q) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {filters.q && (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 text-blue-800 text-[11px] px-2 py-0.5">
              &quot;{filters.q}&quot;
              <button onClick={() => { setQInput(""); setFilters((p) => ({ ...p, q: "", page: "1" })); }} className="hover:text-blue-900">
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          )}
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 rounded-full bg-muted text-foreground text-[11px] px-2 py-0.5"
            >
              {chip.label}
              <button onClick={() => removeChip(chip.key)} className="hover:text-foreground/70">
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          {hasAnyFilter(filters) && (
            <button
              onClick={resetAll}
              className="text-[11px] text-muted-foreground hover:text-foreground underline ml-1"
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {/* Expanded filter panel */}
      {expanded && (
        <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {/* Status filters */}
            {!baseFilters?.approval_status && (
              <div className="space-y-1">
                <Label className="text-xs">Approval Status</Label>
                <Select
                  value={draft.approval_status || "__any__"}
                  onValueChange={(v) => setDraft((p) => ({ ...p, approval_status: v === "__any__" ? "" : v as BillFilters["approval_status"] }))}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Any" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__any__">Any</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="rejected">Rejected</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs">Payment Status</Label>
              <Select
                value={draft.payment_status || "__any__"}
                onValueChange={(v) => setDraft((p) => ({ ...p, payment_status: v === "__any__" ? "" : v as BillFilters["payment_status"] }))}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Any" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any__">Any</SelectItem>
                  <SelectItem value="unpaid">Unpaid</SelectItem>
                  <SelectItem value="partially_paid">Partially Paid</SelectItem>
                  <SelectItem value="paid">Paid</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Batch Type</Label>
              <Select
                value={draft.payment_batch_type || "__any__"}
                onValueChange={(v) => setDraft((p) => ({ ...p, payment_batch_type: v === "__any__" ? "" : v as BillFilters["payment_batch_type"] }))}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Any" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any__">Any</SelectItem>
                  <SelectItem value="immediate">Immediate</SelectItem>
                  <SelectItem value="15th">15th</SelectItem>
                  <SelectItem value="25th">25th</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {!baseFilters?.vendor_id && (
              <div className="space-y-1">
                <Label className="text-xs">Vendor</Label>
                <SearchableSelect
                  options={vendorOptions}
                  value={draft.vendor_id}
                  onValueChange={(v) => setDraft((p) => ({ ...p, vendor_id: v }))}
                  placeholder="Any vendor"
                  searchPlaceholder="Search vendors…"
                  emptyMessage="No vendors found."
                  className="h-8 text-xs"
                />
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs">Has IRN</Label>
              <Select
                value={draft.has_irn || "__any__"}
                onValueChange={(v) => setDraft((p) => ({ ...p, has_irn: v === "__any__" ? "" : v as BillFilters["has_irn"] }))}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Any" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any__">Any</SelectItem>
                  <SelectItem value="true">Yes</SelectItem>
                  <SelectItem value="false">No</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Date ranges */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {DateRange("Invoice Date", draft, setDraft, "invoice_date_from", "invoice_date_to")}
            {DateRange("Due Date", draft, setDraft, "due_date_from", "due_date_to")}
            {DateRange("Approved Date", draft, setDraft, "approved_date_from", "approved_date_to")}
            {DateRange("Payment Date", draft, setDraft, "payment_date_from", "payment_date_to")}
            {DateRange("Created Date", draft, setDraft, "created_date_from", "created_date_to")}
            {DateRange("Batch Date", draft, setDraft, "payment_batch_date_from", "payment_batch_date_to")}
          </div>

          {/* Amount ranges */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <AmountRange label="Total Amount (₹)" draft={draft} setDraft={setDraft} minKey="min_amount" maxKey="max_amount" />
            <AmountRange label="Approved Amount (₹)" draft={draft} setDraft={setDraft} minKey="min_approved_amount" maxKey="max_approved_amount" />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t">
            <Button variant="ghost" size="sm" onClick={resetAll}>Clear all</Button>
            <Button size="sm" onClick={applyDraft}>Apply filters</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Small inline sub-components ─────────────────────────────────────────────

function DateRange(
  label: string,
  draft: BillFilters,
  setDraft: React.Dispatch<React.SetStateAction<BillFilters>>,
  fromKey: keyof BillFilters,
  toKey: keyof BillFilters,
) {
  return (
    <div className="space-y-1" key={fromKey}>
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-1.5">
        <Input
          type="date"
          value={String(draft[fromKey] ?? "")}
          onChange={(e) => setDraft((p) => ({ ...p, [fromKey]: e.target.value }))}
          className="h-8 text-xs"
        />
        <span className="text-xs text-muted-foreground">to</span>
        <Input
          type="date"
          value={String(draft[toKey] ?? "")}
          onChange={(e) => setDraft((p) => ({ ...p, [toKey]: e.target.value }))}
          className="h-8 text-xs"
        />
      </div>
    </div>
  );
}

function AmountRange({
  label, draft, setDraft, minKey, maxKey,
}: {
  label: string;
  draft: BillFilters;
  setDraft: React.Dispatch<React.SetStateAction<BillFilters>>;
  minKey: keyof BillFilters;
  maxKey: keyof BillFilters;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          placeholder="Min"
          value={String(draft[minKey] ?? "")}
          onChange={(e) => setDraft((p) => ({ ...p, [minKey]: e.target.value }))}
          className="h-8 text-xs"
        />
        <span className="text-xs text-muted-foreground">to</span>
        <Input
          type="number"
          placeholder="Max"
          value={String(draft[maxKey] ?? "")}
          onChange={(e) => setDraft((p) => ({ ...p, [maxKey]: e.target.value }))}
          className="h-8 text-xs"
        />
      </div>
    </div>
  );
}

// Re-export for caller convenience
export { parseBillFilters, filtersToParams, EMPTY_FILTERS };
export type { BillFilters };
