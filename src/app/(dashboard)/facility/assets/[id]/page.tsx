"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Pencil, Server, MapPin, Calendar, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PRIORITY_STYLES, STATUS_STYLES, timeAgo } from "@/lib/facility-ui";
import { FacilityAssetFormDialog } from "@/components/facility/asset-form-dialog";
import type { FacilityAsset, FacilityIssue } from "@/types";

type AssetWithHistory = FacilityAsset & { issue_history: FacilityIssue[] };

export default function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [asset, setAsset] = useState<AssetWithHistory | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const fetchData = async () => {
    const res = await fetch(`/api/facility/assets/${id}`);
    const json = await res.json();
    if (res.ok) setAsset(json.data);
  };

  useEffect(() => { fetchData(); /* eslint-disable-next-line */ }, [id]);

  if (!asset) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const openCount = asset.issue_history.filter((i) =>
    ["new", "acknowledged", "in_progress", "reopened"].includes(i.status)
  ).length;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <code className="text-xs font-mono">{asset.asset_code}</code>
            <span className={cn(
              "text-[10px] px-1.5 py-0.5 rounded-full ring-1",
              asset.status === "active" && "bg-emerald-50 text-emerald-700 ring-emerald-200",
              asset.status === "maintenance" && "bg-amber-50 text-amber-700 ring-amber-200",
              asset.status === "retired" && "bg-slate-100 text-slate-600 ring-slate-200",
            )}>{asset.status}</span>
          </div>
          <h1 className="text-base md:text-lg font-semibold mt-0.5">{asset.name}</h1>
        </div>
        <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
          <Pencil className="h-4 w-4 mr-1" /> Edit
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2 rounded-lg border bg-card p-4 space-y-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Details</div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field label="Category" value={asset.category?.name ?? "—"} icon={<Server className="h-3.5 w-3.5" />} />
            <Field label="Location" value={asset.location?.name ?? "—"} icon={<MapPin className="h-3.5 w-3.5" />} />
            {asset.floor?.name && <Field label="Floor" value={asset.floor.name} />}
            {asset.space_unit?.name && <Field label="Space unit" value={`${asset.space_unit.code} · ${asset.space_unit.name}`} />}
            {asset.make && <Field label="Make" value={asset.make} />}
            {asset.model && <Field label="Model" value={asset.model} />}
            {asset.serial_number && <Field label="Serial" value={asset.serial_number} mono />}
            {asset.mac_address && <Field label="MAC" value={asset.mac_address} mono />}
            {asset.ip_address && <Field label="IP" value={asset.ip_address} mono />}
            {asset.vendor && <Field label="Vendor" value={asset.vendor} />}
            {asset.purchase_date && <Field label="Purchased" value={asset.purchase_date} icon={<Calendar className="h-3.5 w-3.5" />} />}
            {asset.warranty_expiry && <Field label="Warranty" value={asset.warranty_expiry} icon={<Calendar className="h-3.5 w-3.5" />} />}
          </div>
          {(asset.location_notes || asset.notes) && (
            <div className="pt-2 border-t space-y-1">
              {asset.location_notes && <div className="text-xs"><span className="text-muted-foreground">Location notes:</span> {asset.location_notes}</div>}
              {asset.notes && <div className="text-xs"><span className="text-muted-foreground">Notes:</span> {asset.notes}</div>}
            </div>
          )}
        </div>

        <aside className="rounded-lg border bg-card p-4 space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Stats</div>
          <Stat label="Open issues" value={openCount} highlight={openCount > 0} />
          <Stat label="Total issues" value={asset.issue_history.length} />
          {asset.issue_history.length > 0 && (
            <Stat label="Last reported" value={timeAgo(asset.issue_history[0].created_at)} />
          )}
        </aside>
      </div>

      <section className="rounded-lg border bg-card p-4 space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Issue history</div>
        {asset.issue_history.length === 0 ? (
          <p className="text-sm text-muted-foreground italic py-3">No issues reported against this asset yet.</p>
        ) : (
          <div className="space-y-1.5">
            {asset.issue_history.map((i) => (
              <Link key={i.id} href={`/facility/issues/${i.id}`} className="flex items-center gap-2 p-2 rounded-md hover:bg-muted/40 text-sm">
                <span className={cn("h-2 w-2 rounded-full shrink-0", PRIORITY_STYLES[i.priority].dot)} />
                <code className="text-[11px] font-mono text-muted-foreground">{i.issue_number}</code>
                <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full ring-1", STATUS_STYLES[i.status].chip)}>
                  {STATUS_STYLES[i.status].label}
                </span>
                <span className="truncate flex-1">{i.title}</span>
                {i.sla_breached && <AlertTriangle className="h-3 w-3 text-red-500 shrink-0" />}
                <span className="text-xs text-muted-foreground shrink-0">{timeAgo(i.created_at)}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <FacilityAssetFormDialog open={editOpen} onOpenChange={setEditOpen} asset={asset} onSuccess={() => fetchData()} />
    </div>
  );
}

function Field({ label, value, icon, mono }: { label: string; value: string; icon?: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {icon} {label}
      </div>
      <div className={cn("mt-0.5", mono && "font-mono text-xs")}>{value}</div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={cn("font-semibold", highlight && "text-red-600")}>{value}</span>
    </div>
  );
}
