"use client";

/**
 * VoucherCustomerGroups — shows UniFi guest-portal devices grouped by the
 * CRM customer their voucher was issued to, resolved via
 * /api/unifi/voucher-devices. Three tiers, in order:
 *   confirmed  — resolved via an explicit database link
 *   suggested  — best-effort fuzzy match against a contract's company name;
 *                shown separately, never merged into confirmed
 *   unmatched  — no signal at all
 * Shared between the Vouchers page (UnifiPanel) and the Network page's
 * "Customers" tab.
 */

import { useState, useEffect, useCallback } from "react";
import { Users, ChevronDown, ChevronUp, RefreshCw, Wifi, HelpCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { toast } from "sonner";
import { formatDateTime } from "@/lib/utils";

interface DeviceRow {
  mac: string;
  hostname: string | null;
  label: string | null;
  last_seen: string | null;
  connected_now: boolean;
  bytes: number | null;
}

type Tier = "confirmed" | "suggested" | "unmatched";

interface CustomerGroup {
  key: string;
  customer_name: string | null;
  sub_label: string | null;
  contract_number: string | null;
  booking_number: string | null;
  tier: Tier;
  devices: DeviceRow[];
}

function fmtBytes(n: number | null): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function VoucherCustomerGroups({ locationId }: { locationId: string }) {
  const [groups, setGroups] = useState<CustomerGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/unifi/voucher-devices?location_id=${locationId}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setGroups(json.data ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load connected devices");
    } finally {
      setLoading(false);
    }
  }, [locationId]);

  useEffect(() => { load(); }, [load]);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const confirmed = groups.filter((g) => g.tier === "confirmed");
  const suggested = groups.filter((g) => g.tier === "suggested");
  const unmatched = groups.find((g) => g.tier === "unmatched");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Users className="h-4 w-4" /> Devices by Customer
          </span>
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="h-7 text-xs">
            <RefreshCw className={`h-3 w-3 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">No guest devices in the last 7 days</p>
        ) : (
          <>
            {confirmed.map((g) => (
              <GroupRow key={g.key} group={g} expanded={expanded.has(g.key)} onToggle={() => toggle(g.key)} />
            ))}
            {suggested.length > 0 && (
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide pt-2">
                Suggested — not confirmed
              </p>
            )}
            {suggested.map((g) => (
              <GroupRow key={g.key} group={g} expanded={expanded.has(g.key)} onToggle={() => toggle(g.key)} />
            ))}
            {unmatched && (
              <GroupRow
                key={unmatched.key}
                group={unmatched}
                expanded={expanded.has(unmatched.key)}
                onToggle={() => toggle(unmatched.key)}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function GroupRow({ group, expanded, onToggle }: { group: CustomerGroup; expanded: boolean; onToggle: () => void }) {
  const title = group.tier === "unmatched"
    ? "Unmatched devices"
    : group.customer_name ?? group.contract_number ?? group.booking_number ?? "Unknown";

  const rowStyle = group.tier === "unmatched"
    ? "opacity-70"
    : group.tier === "suggested"
      ? "border-amber-200 bg-amber-50/40"
      : "";

  return (
    <div className={`rounded-md border overflow-hidden ${rowStyle}`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          {group.tier === "unmatched" ? (
            <HelpCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : group.tier === "suggested" ? (
            <Sparkles className="h-4 w-4 shrink-0 text-amber-500" />
          ) : (
            <Wifi className="h-4 w-4 shrink-0 text-primary" />
          )}
          <div className="min-w-0">
            <span className="text-sm font-medium truncate">{title}</span>
            {group.sub_label && (
              <span className="text-xs text-muted-foreground ml-2">{group.sub_label}</span>
            )}
            {(group.contract_number || group.booking_number) && (
              <span className="text-xs text-muted-foreground ml-2">
                {group.contract_number ?? group.booking_number}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {group.tier === "suggested" && (
            <Badge variant="secondary" className="bg-amber-100 text-amber-800 text-[10px]">Suggested match</Badge>
          )}
          <Badge variant="secondary" className="text-xs">{group.devices.length} device{group.devices.length === 1 ? "" : "s"}</Badge>
          {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </button>
      {expanded && (
        <div className="border-t overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="px-3 py-2 text-left font-medium text-xs">MAC</th>
                <th className="px-3 py-2 text-left font-medium text-xs">Device</th>
                <th className="px-3 py-2 text-left font-medium text-xs">Last Seen</th>
                <th className="px-3 py-2 text-left font-medium text-xs">Data</th>
              </tr>
            </thead>
            <tbody>
              {group.devices.map((d, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="px-3 py-2 font-mono text-xs">{d.mac}</td>
                  <td className="px-3 py-2 text-xs">
                    {d.label ?? d.hostname ?? "—"}
                    {d.connected_now && (
                      <Badge variant="secondary" className="ml-2 bg-green-100 text-green-800 text-[10px]">Online</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{d.last_seen ? formatDateTime(d.last_seen) : "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{fmtBytes(d.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {group.tier === "suggested" && (
            <p className="px-3 py-2 text-xs text-amber-700 bg-amber-50">
              Best-effort match on voucher note text — verify before relying on this. Use the device label editor (Devices tab) to confirm or correct.
            </p>
          )}
          {group.tier === "unmatched" && (
            <p className="px-3 py-2 text-xs text-muted-foreground bg-muted/10">
              These devices used a voucher not linked to any CRM contract (ad-hoc voucher with no match found).
            </p>
          )}
        </div>
      )}
    </div>
  );
}
