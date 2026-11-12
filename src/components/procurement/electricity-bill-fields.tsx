"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Zap } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { matchConnection, type VendorConnection } from "@/lib/electricity-bill-match";

export interface ElectricityBillFieldsValue {
  location_id: string;
  connection_id: string;
  consumer_number: string;
  printed_name: string;
  acknowledge_mismatch: boolean;
  remember_name: boolean;
}

export const EMPTY_ELECTRICITY_FIELDS: ElectricityBillFieldsValue = {
  location_id: "",
  connection_id: "",
  consumer_number: "",
  printed_name: "",
  acknowledge_mismatch: false,
  remember_name: false,
};

interface LocationOption { id: string; name: string; company_id: string | null; company_name: string | null }

interface Props {
  vendorId: string;
  companyId: string;
  value: ElectricityBillFieldsValue;
  onChange: (next: ElectricityBillFieldsValue) => void;
  /** Reports whether the bill can be saved yet, and why not. */
  onStatus: (status: { ok: boolean; reason: string | null }) => void;
  /** Lets the form switch the bill's company when a recognised connection belongs to another one. */
  onRequestCompany?: (companyId: string) => void;
}

const NONE = "__none__";

/**
 * Shown for a standalone bill from an electricity-provider vendor. The location is always chosen
 * from our own list — how the bill words the site is never relied on. The consumer number and the
 * wording printed on the bill only fill in the connection, and warn when they point somewhere other
 * than the location chosen.
 */
export function ElectricityBillFields({ vendorId, companyId, value, onChange, onStatus, onRequestCompany }: Props) {
  // Every active location, with its company; the picker below shows only the bill's company's.
  const [allLocations, setAllLocations] = useState<LocationOption[] | null>(null);
  const [connections, setConnections] = useState<VendorConnection[]>([]);
  const rememberTouched = useRef(false);

  useEffect(() => {
    fetch("/api/locations?is_active=true")
      .then((r) => r.json())
      .then((j) =>
        setAllLocations(
          (j.data ?? []).map((l: { id: string; name: string; company_id?: string | null; companies?: { brand_name?: string; name?: string } | null }) => ({
            id: l.id,
            name: l.name,
            company_id: l.company_id ?? null,
            company_name: l.companies?.brand_name ?? l.companies?.name ?? null,
          }))
        )
      )
      .catch(() => setAllLocations([]));
  }, []);
  const locations = useMemo(
    () => (allLocations ? allLocations.filter((l) => !companyId || !l.company_id || l.company_id === companyId) : null),
    [allLocations, companyId]
  );

  useEffect(() => {
    if (!vendorId) { setConnections([]); return; }
    fetch(`/api/electricity-connections?vendor_id=${vendorId}`)
      .then((r) => r.json())
      .then((j) => setConnections(j.data ?? []))
      .catch(() => setConnections([]));
  }, [vendorId]);

  const set = (patch: Partial<ElectricityBillFieldsValue>) => onChange({ ...value, ...patch });

  const match = useMemo(
    () => matchConnection(connections, { consumer_number: value.consumer_number, printed_name: value.printed_name }),
    [connections, value.consumer_number, value.printed_name]
  );
  const locationName = (id: string) => allLocations?.find((l) => l.id === id)?.name ?? connections.find((c) => c.location_id === id)?.location_name ?? "that location";
  const here = connections.filter((c) => c.location_id === value.location_id);

  // A matched connection fills in the location when none is chosen yet — the person can still change it.
  useEffect(() => {
    if (match.status === "match" && !value.location_id && locations?.some((l) => l.id === match.connection.location_id)) {
      onChange({ ...value, location_id: match.connection.location_id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match, locations]);

  // Which connection the bill resolves to (shown, and sent): the one picked, else the matched one at this
  // location, else the only connection there.
  const resolved =
    here.find((c) => c.id === value.connection_id) ??
    (match.status === "match" && match.connection.location_id === value.location_id ? match.connection : undefined) ??
    (match.status === "none" && here.length === 1 ? here[0] : undefined);

  // A recognised connection whose location belongs to a different company from the one selected on the bill.
  const otherCompanyLocation =
    match.status === "match" ? allLocations?.find((l) => l.id === match.connection.location_id && !locations?.some((x) => x.id === l.id)) : undefined;

  const mismatch =
    match.status === "match" && !!value.location_id && match.connection.location_id !== value.location_id
      ? match
      : null;
  const conflict = match.status === "conflict" ? match : null;
  const needsAck = !!(mismatch || conflict);

  // Offer to remember the printed wording once it belongs to a resolved connection and is genuinely new.
  const canRemember =
    !!value.printed_name.trim() && !!resolved && match.status !== "conflict" && !(match.status === "match" && match.via.includes("name"));
  useEffect(() => {
    if (!canRemember) { if (value.remember_name) onChange({ ...value, remember_name: false }); return; }
    if (!rememberTouched.current && !value.remember_name) onChange({ ...value, remember_name: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRemember]);

  // Changing the location invalidates a confirmation and a connection picked for the old one.
  const pickLocation = (id: string) => {
    rememberTouched.current = false;
    onChange({ ...value, location_id: id, connection_id: "", acknowledge_mismatch: false });
  };

  const ok = !!value.location_id && (!needsAck || value.acknowledge_mismatch);
  const reason = !value.location_id
    ? "Choose the location this electricity bill is for"
    : needsAck && !value.acknowledge_mismatch
      ? "Confirm which location this bill is for"
      : null;
  useEffect(() => { onStatus({ ok, reason }); }, [ok, reason]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-start gap-2">
        <Zap className="mt-0.5 h-4 w-4 text-amber-600" />
        <div>
          <p className="text-sm font-medium">Electricity bill — which location is it for?</p>
          <p className="text-xs text-muted-foreground">
            You choose the location. What the bill itself calls the site doesn&apos;t matter — it is only used to fill in the connection and to warn you if it points somewhere else.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="elec-consumer">Consumer number on the bill</Label>
          <Input id="elec-consumer" value={value.consumer_number} onChange={(e) => set({ consumer_number: e.target.value, acknowledge_mismatch: false })} placeholder="if one is printed" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="elec-name">Name / site as printed on the bill</Label>
          <Input id="elec-name" value={value.printed_name} onChange={(e) => { rememberTouched.current = false; set({ printed_name: e.target.value, acknowledge_mismatch: false }); }} placeholder="e.g. tenant or plot name (optional)" />
        </div>
        <div className="space-y-1">
          <Label>Location <span className="text-red-500">*</span></Label>
          <Select value={value.location_id || NONE} onValueChange={(v) => pickLocation(v === NONE ? "" : v)}>
            <SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Select a location…</SelectItem>
              {(locations ?? []).map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Connection</Label>
          {here.length > 1 ? (
            <Select value={resolved?.id ?? NONE} onValueChange={(v) => set({ connection_id: v === NONE ? "" : v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not sure — leave unset</SelectItem>
                {here.map((c) => <SelectItem key={c.id} value={c.id}>{c.consumer_number ?? "no number"}{c.meter_label ? ` · ${c.meter_label}` : ""}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : (
            <p className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
              {resolved ? `${resolved.consumer_number ?? "No consumer number"}${resolved.meter_label ? ` · ${resolved.meter_label}` : ""}` : value.location_id ? "No connection set up here yet" : "—"}
            </p>
          )}
        </div>
      </div>

      {otherCompanyLocation && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <p>
            Recognised as the connection at <b className="font-medium">{otherCompanyLocation.name}</b>, which belongs to{" "}
            <b className="font-medium">{otherCompanyLocation.company_name ?? "another company"}</b> — not the company chosen above.
          </p>
          {onRequestCompany && otherCompanyLocation.company_id && (
            <button type="button" className="mt-1.5 font-medium text-blue-700 underline-offset-2 hover:underline" onClick={() => onRequestCompany(otherCompanyLocation.company_id!)}>
              Switch the bill&apos;s company to {otherCompanyLocation.company_name ?? "that company"}
            </button>
          )}
        </div>
      )}

      {match.status === "match" && !mismatch && !otherCompanyLocation && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Recognised by {match.via.includes("consumer_number") ? "the consumer number" : "the remembered name"} as the connection at {match.connection.location_name}.
        </p>
      )}

      {(mismatch || conflict) && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <p className="flex items-start gap-1.5 font-medium">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {conflict
              ? `The consumer number on this bill belongs to ${conflict.byNumber.location_name}, but the name belongs to ${conflict.byName.location_name}.`
              : `${mismatch!.via.includes("consumer_number") ? "The consumer number" : "The name"} on this bill belongs to ${mismatch!.connection.location_name}, not ${locationName(value.location_id)}.`}
          </p>
          <label className="mt-2 flex cursor-pointer items-start gap-2">
            <Checkbox checked={value.acknowledge_mismatch} onCheckedChange={(c) => set({ acknowledge_mismatch: c === true })} />
            <span>Yes — this bill is for <b className="font-medium">{locationName(value.location_id)}</b></span>
          </label>
        </div>
      )}

      {canRemember && (
        <label className="flex cursor-pointer items-start gap-2 text-xs">
          <Checkbox checked={value.remember_name} onCheckedChange={(c) => { rememberTouched.current = true; set({ remember_name: c === true }); }} />
          <span>
            Remember “{value.printed_name.trim()}” as this utility&apos;s wording for the connection{resolved?.consumer_number ? ` ${resolved.consumer_number}` : ""} — next time a bill carrying it is recognised by itself.
          </span>
        </label>
      )}
    </div>
  );
}
