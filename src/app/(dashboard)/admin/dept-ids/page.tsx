"use client";

/**
 * Bulk Department-ID assignment page.
 *
 * Most existing contracts don't have a printer department_id mapped yet.
 * Without that mapping, monthly print reports can't bill anyone for overage.
 * This page surfaces every active contract grouped by location and lets
 * admin/manager keyboard-tab through assigning IDs quickly.
 *
 * Behaviour:
 *   - Only active contracts shown (other statuses can't be billed anyway)
 *   - Grouped by location so the admin can match the printer's report
 *     (which is per-location)
 *   - Inline-edit: change a value, blur or hit Enter → autosave
 *   - Per-row save status indicator
 *   - Duplicate detection per location: if two contracts at the same
 *     location have the same ID, both rows turn red and neither saves
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Search, Loader2, Check, AlertCircle, ExternalLink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface ContractRow {
  id: string;
  contract_number: string;
  status: string;
  location_id: string | null;
  location?: { id: string; name: string; code: string } | null;
  lead?: { first_name?: string; last_name?: string; company?: string } | null;
  department_id: string | null;
  // Local UI state
  draft: string;
  saving: boolean;
  saved: boolean;
  error: string | null;
}

export default function BulkDeptIdsPage() {
  const [rows, setRows] = useState<ContractRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [hideAssigned, setHideAssigned] = useState(true);

  // Active contracts WITHOUT a location are hidden — they're not allocated
  // to a physical space yet, so there's no printer to map. Track the count
  // for an inline banner.
  const [skippedNoLocation, setSkippedNoLocation] = useState(0);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/contracts?status=active&limit=500");
      const json = await res.json();
      const all = (json.data || []) as ContractRow[];
      const withLocation = all.filter((c) => !!c.location_id);
      setSkippedNoLocation(all.length - withLocation.length);
      const items = withLocation.map((c) => ({
        ...c,
        draft: c.department_id || "",
        saving: false,
        saved: false,
        error: null,
      }));
      // Group by location alphabetically
      items.sort((a: ContractRow, b: ContractRow) => {
        const la = a.location?.name || "ZZZ";
        const lb = b.location?.name || "ZZZ";
        if (la !== lb) return la.localeCompare(lb);
        return a.contract_number.localeCompare(b.contract_number);
      });
      setRows(items);
      setLoading(false);
    })();
  }, []);

  // Per-location dup detection — Department IDs are unique within a
  // location (each location has its own print server, so the same numeric
  // ID across locations is fine). Surface conflicts inline before the API
  // rejects them.
  const dupKeys = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const v = r.draft.trim();
      if (!v || !r.location_id) continue;
      const key = `${r.location_id}::${v}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return new Set(Array.from(counts.entries()).filter(([, n]) => n > 1).map(([k]) => k));
  }, [rows]);

  const filtered = useMemo(() => {
    let out = rows;
    if (hideAssigned) out = out.filter((r) => !r.department_id);
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter((r) =>
        r.contract_number.toLowerCase().includes(q) ||
        (r.location?.name || "").toLowerCase().includes(q) ||
        (r.lead?.company || "").toLowerCase().includes(q) ||
        ((r.lead?.first_name || "") + " " + (r.lead?.last_name || "")).toLowerCase().includes(q)
      );
    }
    return out;
  }, [rows, search, hideAssigned]);

  const updateField = (idx: number, patch: Partial<ContractRow>) => {
    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, ...patch } : r));
  };

  const save = async (idx: number) => {
    const r = rows[idx];
    const newVal = r.draft.trim() || null;
    if (newVal === (r.department_id || null)) return;     // no change

    if (newVal && r.location_id) {
      const key = `${r.location_id}::${newVal}`;
      if (dupKeys.has(key)) {
        updateField(idx, { error: "Duplicate at this location", saving: false });
        toast.error(`Department ID "${newVal}" used by another contract at this location`);
        return;
      }
    }

    updateField(idx, { saving: true, error: null });
    try {
      const res = await fetch(`/api/contracts/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ department_id: newVal }),
      });
      const json = await res.json();
      if (!res.ok) {
        updateField(idx, { saving: false, error: json.error || "Save failed" });
        toast.error(json.error || "Save failed");
        return;
      }
      updateField(idx, {
        saving: false,
        saved: true,
        error: null,
        department_id: newVal,
      });
      // Hide the green checkmark after 2 seconds
      setTimeout(() => updateField(idx, { saved: false }), 2000);
    } catch (e) {
      updateField(idx, { saving: false, error: e instanceof Error ? e.message : "Save failed" });
    }
  };

  // Group view
  const grouped = useMemo(() => {
    const m = new Map<string, ContractRow[]>();
    for (const r of filtered) {
      const k = r.location?.name || "— Unassigned location —";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return Array.from(m.entries());
  }, [filtered]);

  const unassignedCount = rows.filter((r) => !r.department_id).length;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-4">
      <div>
        <h1 className="text-xl md:text-2xl font-semibold">Bulk Department ID Assignment</h1>
        <p className="text-xs md:text-sm text-muted-foreground">
          Map each active contract to its printer-server Department ID.
          IDs are unique <span className="font-medium">within a location</span> —
          the same number can be reused across locations because each has its own
          print server. Without this mapping, monthly print reports can&apos;t bill
          the right customer.
        </p>
        {skippedNoLocation > 0 && (
          <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {skippedNoLocation} active contract{skippedNoLocation > 1 ? "s are" : " is"} hidden because no location has been assigned.
            Assign a location on those contracts first — there&apos;s no printer to map until then.
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search contract number, location, customer…"
            className="pl-9"
          />
        </div>
        <label className="text-xs flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={hideAssigned}
            onChange={(e) => setHideAssigned(e.target.checked)}
            className="rounded"
          />
          Hide already-assigned ({rows.length - unassignedCount})
        </label>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground py-12 text-center">Loading active contracts…</div>
      ) : grouped.length === 0 ? (
        <div className="text-sm text-muted-foreground py-12 text-center">
          {hideAssigned && unassignedCount === 0
            ? "All active contracts have a Department ID assigned."
            : "No contracts match these filters."}
        </div>
      ) : (
        <div className="space-y-5">
          {grouped.map(([locName, items]) => (
            <section key={locName}>
              <h2 className="text-sm font-semibold mb-2">{locName} <span className="text-muted-foreground font-normal">({items.length})</span></h2>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Contract</th>
                      <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">Customer</th>
                      <th className="text-left px-3 py-2 font-medium w-[180px]">Department ID</th>
                      <th className="w-12"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((r) => {
                      const idx = rows.findIndex((x) => x.id === r.id);
                      const customer = r.lead?.company ||
                        [r.lead?.first_name, r.lead?.last_name].filter(Boolean).join(" ") || "—";
                      const isDup = !!r.draft.trim() && r.location_id ? dupKeys.has(`${r.location_id}::${r.draft.trim()}`) : false;
                      return (
                        <tr key={r.id} className="border-t hover:bg-muted/20">
                          <td className="px-3 py-2">
                            <Link href={`/contracts/${r.id}`} className="text-primary hover:underline font-mono text-xs inline-flex items-center gap-1">
                              {r.contract_number}
                              <ExternalLink className="h-3 w-3" />
                            </Link>
                          </td>
                          <td className="px-3 py-2 hidden sm:table-cell text-xs">{customer}</td>
                          <td className="px-3 py-2">
                            <Input
                              value={r.draft}
                              onChange={(e) => updateField(idx, { draft: e.target.value })}
                              onBlur={() => save(idx)}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                              placeholder="e.g. 1, 110, 3110"
                              className={cn(
                                "h-8 font-mono",
                                (isDup || r.error) && "border-red-400 focus-visible:ring-red-500",
                              )}
                              disabled={r.saving}
                            />
                            {(isDup || r.error) && (
                              <p className="text-[10px] text-red-600 mt-0.5">
                                {isDup ? "Duplicate at this location" : r.error}
                              </p>
                            )}
                          </td>
                          <td className="px-1">
                            {r.saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                            {r.saved && <Check className="h-4 w-4 text-emerald-500" />}
                            {!r.saving && !r.saved && r.error && <AlertCircle className="h-4 w-4 text-red-500" />}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
