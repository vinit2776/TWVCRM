"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Search, Pencil, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { FacilityAssetFormDialog } from "@/components/facility/asset-form-dialog";
import { QRScannerDialog } from "@/components/facility/qr-scanner-dialog";
import type { FacilityAsset } from "@/types";

interface Location { id: string; name: string }

export default function FacilityAssetsPage() {
  const [assets, setAssets] = useState<FacilityAsset[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [locationId, setLocationId] = useState("");
  const [openForm, setOpenForm] = useState(false);
  const [editing, setEditing] = useState<FacilityAsset | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    const params = new URLSearchParams({ include_stats: "true" });
    if (locationId) params.set("location_id", locationId);
    if (search.trim()) params.set("search", search.trim());
    const res = await fetch(`/api/facility/assets?${params.toString()}`);
    const json = await res.json();
    setAssets(json.data || []);
    setLoading(false);
  };

  useEffect(() => {
    fetch("/api/locations?is_active=true").then((r) => r.json()).then((j) => setLocations(j.data || []));
  }, []);

  useEffect(() => {
    const t = setTimeout(fetchData, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, search]);

  // Group by location for nicer presentation
  const grouped = useMemo(() => {
    const m = new Map<string, { name: string; rows: FacilityAsset[] }>();
    for (const a of assets) {
      const lid = a.location_id;
      if (!m.has(lid)) m.set(lid, { name: a.location?.name ?? "Unknown", rows: [] });
      m.get(lid)!.rows.push(a);
    }
    return Array.from(m.entries());
  }, [assets]);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold">Facility Assets</h1>
          <p className="text-xs md:text-sm text-muted-foreground">Equipment inventory: UDMs, switches, access points and more</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setScannerOpen(true)}>
            <ScanLine className="h-4 w-4 mr-1" /> Scan QR
          </Button>
          <Button size="sm" onClick={() => { setEditing(null); setOpenForm(true); }}>
            <Plus className="h-4 w-4 mr-1" /> Add Asset
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, code, serial, MAC…" className="pl-9" />
        </div>
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="h-10 px-2 rounded-md border bg-background text-sm">
          <option value="">All locations</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground py-12 text-center">Loading…</div>
      ) : grouped.length === 0 ? (
        <div className="max-w-md mx-auto py-14 px-4 text-center space-y-6">
          <div className="text-2xl font-semibold">Start your asset register</div>
          <p className="text-sm text-muted-foreground">
            Once assets are registered, your team can log issues and schedule AMC visits against specific devices — no more guessing which unit broke down.
          </p>
          <ol className="text-left space-y-4">
            {[
              {
                n: 1,
                title: "Add each asset",
                body: "Tap Add Asset and follow the 3 steps — location, specs, and a photo. Takes about 2 minutes per item.",
              },
              {
                n: 2,
                title: "Print or stick the QR code",
                body: "Open the asset and print its QR sticker. Stick it on the device so technicians can scan it on-site.",
              },
              {
                n: 3,
                title: "Log issues against it",
                body: "When something breaks, open the asset and raise an issue. This builds a history that helps with AMC and vendor decisions.",
              },
            ].map(({ n, title, body }) => (
              <li key={n} className="flex gap-3">
                <span className="flex-shrink-0 h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center font-semibold mt-0.5">{n}</span>
                <div>
                  <div className="text-sm font-medium">{title}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{body}</div>
                </div>
              </li>
            ))}
          </ol>
          <Button onClick={() => { setEditing(null); setOpenForm(true); }} className="w-full sm:w-auto">
            <Plus className="h-4 w-4 mr-1" /> Add your first asset
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(([lid, g]) => (
            <section key={lid}>
              <h2 className="text-sm font-semibold text-muted-foreground mb-2">{g.name}</h2>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Code</th>
                      <th className="text-left px-3 py-2 font-medium">Name</th>
                      <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">Category</th>
                      <th className="text-left px-3 py-2 font-medium hidden md:table-cell">Make / Model</th>
                      <th className="text-center px-3 py-2 font-medium">Issues</th>
                      <th className="text-right px-3 py-2 font-medium">Status</th>
                      <th className="w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((a) => (
                      <tr key={a.id} className="border-t hover:bg-muted/20">
                        <td className="px-3 py-2"><Link className="font-mono text-xs hover:underline" href={`/facility/assets/${a.id}`}>{a.asset_code}</Link></td>
                        <td className="px-3 py-2"><Link className="hover:underline" href={`/facility/assets/${a.id}`}>{a.name}</Link></td>
                        <td className="px-3 py-2 hidden sm:table-cell text-xs">{a.category?.name ?? "—"}</td>
                        <td className="px-3 py-2 hidden md:table-cell text-xs">{[a.make, a.model].filter(Boolean).join(" ") || "—"}</td>
                        <td className="px-3 py-2 text-center text-xs">
                          {a.open_issue_count ? (
                            <span className="text-red-600 font-medium">{a.open_issue_count} open</span>
                          ) : (
                            <span className="text-muted-foreground">{a.total_issue_count ?? 0} total</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className={cn(
                            "text-[10px] px-1.5 py-0.5 rounded-full ring-1",
                            a.status === "active" && "bg-emerald-50 text-emerald-700 ring-emerald-200",
                            a.status === "maintenance" && "bg-amber-50 text-amber-700 ring-amber-200",
                            a.status === "retired" && "bg-slate-100 text-slate-600 ring-slate-200",
                          )}>{a.status}</span>
                        </td>
                        <td className="px-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditing(a); setOpenForm(true); }}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}

      <FacilityAssetFormDialog
        open={openForm}
        onOpenChange={setOpenForm}
        asset={editing}
        defaultLocationId={locationId}
        onSuccess={() => fetchData()}
      />

      <QRScannerDialog open={scannerOpen} onClose={() => setScannerOpen(false)} />
    </div>
  );
}
