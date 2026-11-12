"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  customerForUnit,
  searchCustomerOptions,
  type TicketCustomerOption,
} from "@/lib/facility/ticket-customer";

const MAX_SHOWN = 6;

/**
 * "Which customer is this about?" for the facility report wizard. Optional.
 * Searches the center's live contracts by customer, contract number or unit.
 * When a space unit is chosen and exactly one customer holds it, that customer
 * is suggested (never forced, and never over a choice already made).
 */
export function TicketCustomerPicker({
  locationId,
  spaceUnitId,
  value,
  onChange,
  disabled,
}: {
  locationId: string;
  spaceUnitId: string;
  value: TicketCustomerOption | null;
  onChange: (option: TicketCustomerOption | null) => void;
  disabled?: boolean;
}) {
  const [options, setOptions] = useState<TicketCustomerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [suggested, setSuggested] = useState(false);
  // Set once the person has picked or cleared a customer themselves.
  const chosenByHand = useRef(false);

  useEffect(() => {
    chosenByHand.current = false;
    setSuggested(false);
    setQuery("");
    setOptions([]);
    setFailed(false);
    if (!locationId) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/facility/customer-lookup?location_id=${encodeURIComponent(locationId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("lookup failed"))))
      .then((j: { data: TicketCustomerOption[] }) => {
        if (!cancelled) setOptions(j.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  // Suggest the unit's single holder, unless a choice has already been made by hand.
  useEffect(() => {
    if (chosenByHand.current) return;
    // A suggestion belongs to the space it came from: if the space changes, drop it and re-suggest.
    if (value && !suggested) return;
    const holder = customerForUnit(options, spaceUnitId);
    if (holder) {
      onChange(holder);
      setSuggested(true);
    } else if (value) {
      onChange(null);
      setSuggested(false);
    }
    // onChange is a state setter from the parent; the effect should react to data, not to its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceUnitId, options]);

  const matches = useMemo(() => searchCustomerOptions(options, query).slice(0, MAX_SHOWN), [options, query]);
  const totalMatches = useMemo(() => searchCustomerOptions(options, query).length, [options, query]);

  const choose = (o: TicketCustomerOption | null) => {
    chosenByHand.current = true;
    setSuggested(false);
    setQuery("");
    onChange(o);
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor="ticket-customer" className="text-xs">Which customer is this about? (optional)</Label>

      {value ? (
        <div className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-sm">
          <span className="min-w-0">
            <span className="font-medium">{value.customerName}</span>
            <span className="text-muted-foreground"> · {value.contractNumber}{value.units.length ? ` · ${value.units.join(", ")}` : ""}</span>
            {suggested && <span className="ml-2 text-xs text-muted-foreground">(suggested from the space)</span>}
          </span>
          <button
            type="button"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
            onClick={() => choose(null)}
            disabled={disabled}
            aria-label="Clear customer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              id="ticket-customer"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={locationId ? "Search customer, contract or space" : "Choose a location first"}
              className="pl-8"
              disabled={disabled || !locationId}
              autoComplete="off"
            />
          </div>
          {locationId && (
            <div className="rounded-md border">
              {loading ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">Loading customers…</p>
              ) : failed ? (
                <p className="px-3 py-2 text-xs text-destructive">Couldn&apos;t load customers. You can still log the ticket without one.</p>
              ) : matches.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">{options.length === 0 ? "No active customers at this location." : "No customer matches that search."}</p>
              ) : (
                <ul className="divide-y">
                  {matches.map((o) => (
                    <li key={o.contractId}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                        onClick={() => choose(o)}
                        disabled={disabled}
                      >
                        <span className="min-w-0">
                          <span className="font-medium">{o.customerName}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {o.contractNumber}{o.units.length ? ` · ${o.units.join(", ")}` : ""}
                          </span>
                        </span>
                        <Check className="h-4 w-4 shrink-0 opacity-0" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                  {totalMatches > matches.length && (
                    <li className="px-3 py-1.5 text-xs text-muted-foreground">{totalMatches - matches.length} more. Keep typing to narrow it down.</li>
                  )}
                </ul>
              )}
            </div>
          )}
        </>
      )}
      <p className="text-xs text-muted-foreground">
        Pick the customer so their Value score counts this ticket. Leave it empty for shared or internal issues.
      </p>
    </div>
  );
}
