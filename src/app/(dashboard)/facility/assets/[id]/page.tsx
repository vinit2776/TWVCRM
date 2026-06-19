"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, Pencil, Printer, Server, MapPin, Calendar,
  AlertTriangle, Wrench, CheckCircle2, Clock, ExternalLink,
  Upload, FileText, Trash2, Loader2, X, Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatDate, formatCurrency } from "@/lib/utils";
import { PRIORITY_STYLES, STATUS_STYLES, timeAgo } from "@/lib/facility-ui";
import { FacilityAssetFormDialog } from "@/components/facility/asset-form-dialog";
import { AssetEventDialog, type OpenIssue } from "@/components/facility/asset-event-dialog";
import type { FacilityAsset, FacilityIssue, FacilityAssetEvent, FacilityAssetEventType, FacilityLifecycleStage, CategoryCustomField, AmcStatus, AssetDocument, AssetDocumentTier } from "@/types";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

const EVENT_TYPE_LABEL: Record<FacilityAssetEventType, string> = {
  maintenance: "Maintenance done",
  inspection: "Inspection",
  fault_observed: "Fault observed",
  part_replaced: "Part replaced",
  cleaning: "Cleaning",
  installation: "Installation",
  relocation: "Relocation",
  other: "Other",
};

const EVENT_TYPE_EMOJI: Record<FacilityAssetEventType, string> = {
  maintenance: "🔧",
  inspection: "🔍",
  fault_observed: "⚠️",
  part_replaced: "🔄",
  cleaning: "🧹",
  installation: "📦",
  relocation: "📍",
  other: "📝",
};

type AssetWithHistory = FacilityAsset & { issue_history: FacilityIssue[] };

type Tab = "details" | "amc" | "documents";

const LIFECYCLE_LABELS: Record<FacilityLifecycleStage, { label: string; color: string }> = {
  procured: { label: "Procured", color: "bg-blue-50 text-blue-700 ring-blue-200" },
  installed: { label: "Installed", color: "bg-indigo-50 text-indigo-700 ring-indigo-200" },
  testing_commissioning: { label: "T&C", color: "bg-purple-50 text-purple-700 ring-purple-200" },
  operational: { label: "Operational", color: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  under_amc: { label: "Under AMC", color: "bg-teal-50 text-teal-700 ring-teal-200" },
  decommissioned: { label: "Decommissioned", color: "bg-slate-100 text-slate-600 ring-slate-200" },
};

const AMC_STATUS_CHIP: Record<AmcStatus, string> = {
  inactive: "bg-gray-100 text-gray-600",
  active: "bg-green-100 text-green-700",
  expiring: "bg-amber-100 text-amber-700",
  exhausted: "bg-red-100 text-red-700",
  expired: "bg-red-100 text-red-600",
};

const AMC_EVENT_TYPE_LABEL: Record<string, string> = {
  breakdown: "Breakdown",
  preventive: "Preventive",
  remote_support: "Remote",
  annual_service: "Annual Service",
};

interface AmcContract {
  id: string;
  po_number: string;
  amc_status: AmcStatus;
  amc_start_date: string | null;
  amc_end_date: string | null;
  amc_visits_covered: number | null;
  amc_visits_used: number;
  amc_contact_name: string | null;
  amc_helpline_number: string | null;
  amc_contact_email: string | null;
  total_ordered_amount: number;
  procurement_vendors: { id: string; name: string } | null;
}

interface AmcEvent {
  id: string;
  po_id: string;
  event_number: number;
  event_type: string;
  event_date: string;
  technician_name: string | null;
  issue_description: string;
  resolution_notes: string | null;
  next_scheduled_date: string | null;
  report_file_url: string | null;
  created_at: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
  vendor_notes: string | null;
  vendor_submitted_at: string | null;
  logger: { id: string; full_name: string } | null;
  confirmer: { id: string; full_name: string } | null;
  checklist: { id: string; checked: boolean }[] | null;
}

export default function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [asset, setAsset] = useState<AssetWithHistory | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("details");
  const [amcContracts, setAmcContracts] = useState<AmcContract[]>([]);
  const [amcEvents, setAmcEvents] = useState<AmcEvent[]>([]);
  const [amcLoaded, setAmcLoaded] = useState(false);
  const [docs, setDocs] = useState<AssetDocument[]>([]);
  const [docsLoaded, setDocsLoaded] = useState(false);
  const [userRole, setUserRole] = useState<string>("");
  const [eventDialogOpen, setEventDialogOpen] = useState(false);
  const [events, setEvents] = useState<FacilityAssetEvent[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);

  const fetchData = async () => {
    const res = await fetch(`/api/facility/assets/${id}`);
    const json = await res.json();
    if (res.ok) setAsset(json.data);
  };

  const fetchAmc = async () => {
    const res = await fetch(`/api/facility/assets/${id}/amc`);
    const json = await res.json();
    if (res.ok) {
      setAmcContracts(json.contracts || []);
      setAmcEvents(json.events || []);
    }
    setAmcLoaded(true);
  };

  const fetchDocs = async () => {
    const res = await fetch(`/api/facility/assets/${id}/documents`);
    const json = await res.json();
    if (res.ok) setDocs(json.data || []);
    setDocsLoaded(true);
  };

  const fetchEvents = async () => {
    const res = await fetch(`/api/facility/assets/${id}/events`);
    const json = await res.json();
    if (res.ok) setEvents(json.data || []);
    setEventsLoaded(true);
  };

  useEffect(() => {
    fetchData();
    fetchEvents();
    fetch("/api/me").then(r => r.json()).then(j => setUserRole(j.role || ""));
    /* eslint-disable-next-line */
  }, [id]);
  useEffect(() => { if (tab === "amc" && !amcLoaded) fetchAmc(); /* eslint-disable-next-line */ }, [tab]);
  useEffect(() => { if (tab === "documents" && !docsLoaded) fetchDocs(); /* eslint-disable-next-line */ }, [tab]);

  if (!asset) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const openCount = asset.issue_history.filter((i) =>
    ["new", "acknowledged", "in_progress", "reopened"].includes(i.status)
  ).length;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2 min-w-0">
          <Button variant="ghost" size="icon" className="shrink-0" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <code className="text-xs font-mono">{asset.asset_code}</code>
              <span className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full ring-1",
                asset.status === "active" && "bg-emerald-50 text-emerald-700 ring-emerald-200",
                asset.status === "maintenance" && "bg-amber-50 text-amber-700 ring-amber-200",
                asset.status === "retired" && "bg-slate-100 text-slate-600 ring-slate-200",
              )}>{asset.status}</span>
              {asset.lifecycle_stage && (
                <span className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded-full ring-1",
                  LIFECYCLE_LABELS[asset.lifecycle_stage]?.color || "bg-slate-50 text-slate-600 ring-slate-200",
                )}>{LIFECYCLE_LABELS[asset.lifecycle_stage]?.label || asset.lifecycle_stage}</span>
              )}
            </div>
            <h1 className="text-base md:text-lg font-semibold mt-0.5">{asset.name}</h1>
          </div>
        </div>
        <div className="flex items-center gap-2 pl-10 sm:pl-0 sm:ml-auto shrink-0">
          <Button size="sm" onClick={() => setEventDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Log Event
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.open(`/facility/assets/${id}/print`, "_blank")}>
            <Printer className="h-4 w-4 mr-1" /> Print QR
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
            <Pencil className="h-4 w-4 mr-1" /> Edit
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {([
          { key: "details" as Tab, label: "Details & Issues" },
          { key: "amc" as Tab, label: "AMC" },
          { key: "documents" as Tab, label: "Documents" },
        ]).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              tab === t.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── DETAILS TAB ──────────────────────────────────────────────── */}
      {tab === "details" && (
        <>
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
                {asset.installation_date && <Field label="Installed" value={asset.installation_date} icon={<Calendar className="h-3.5 w-3.5" />} />}
              </div>
              {asset.custom_field_values && Object.keys(asset.custom_field_values).length > 0 && (
                <div className="pt-2 border-t space-y-1">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{asset.category?.name} details</div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {((asset.category?.custom_field_schema as CategoryCustomField[] | undefined) || []).map((f) => {
                      const val = asset.custom_field_values?.[f.key];
                      if (val === undefined || val === null || val === "") return null;
                      return <Field key={f.key} label={f.label} value={String(val)} />;
                    })}
                  </div>
                </div>
              )}
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

          <section className="rounded-lg border bg-card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Event log</div>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEventDialogOpen(true)}>
                <Plus className="h-3 w-3 mr-1" /> Log
              </Button>
            </div>
            {!eventsLoaded ? (
              <p className="text-sm text-muted-foreground py-3">Loading…</p>
            ) : events.length === 0 ? (
              <p className="text-sm text-muted-foreground italic py-3">No events logged yet. Use &ldquo;Log Event&rdquo; to record maintenance, inspections, or observations.</p>
            ) : (
              <div className="space-y-1.5">
                {events.map((ev) => (
                  <div key={ev.id} className="flex items-start gap-2 p-2 rounded-md hover:bg-muted/40 text-sm">
                    <span className="text-base shrink-0 leading-none mt-0.5">{EVENT_TYPE_EMOJI[ev.event_type as FacilityAssetEventType] || "📝"}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-xs">{EVENT_TYPE_LABEL[ev.event_type as FacilityAssetEventType] || ev.event_type}</span>
                        <span className="text-xs text-muted-foreground">{timeAgo(ev.created_at)}</span>
                        {ev.logger && <span className="text-xs text-muted-foreground">· {ev.logger.full_name}</span>}
                      </div>
                      {ev.issue && (
                        <Link href={`/facility/issues/${ev.issue.id}`} className="inline-flex items-center gap-1 text-[11px] text-[#015E65] hover:underline mt-0.5">
                          <code className="font-mono">{ev.issue.issue_number}</code>
                          <span className="truncate max-w-[180px]">{ev.issue.title}</span>
                        </Link>
                      )}
                      {ev.note && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{ev.note}</p>}
                      {ev.photo_urls?.length > 0 && (
                        <div className="flex gap-1.5 mt-1">
                          {ev.photo_urls.map((url, i) => (
                            <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="block h-10 w-10 rounded border overflow-hidden hover:ring-2 ring-primary/30">
                              <img src={url} alt="" className="h-full w-full object-cover" />
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {/* ── AMC TAB ──────────────────────────────────────────────────── */}
      {tab === "amc" && (
        <>
          {!amcLoaded ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Loading AMC data…</div>
          ) : (
            <>
              {/* Contracts */}
              <section className="space-y-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">AMC Contracts</div>
                {amcContracts.length === 0 ? (
                  <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
                    <Wrench className="h-6 w-6 mx-auto mb-2 opacity-30" />
                    <p>No AMC contract linked to this asset yet.</p>
                    <p className="text-xs mt-1">Link this asset from Procurement &gt; AMC when creating or editing a service PO.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {amcContracts.map((c) => (
                      <Link
                        key={c.id}
                        href={`/procurement/orders/${c.id}`}
                        className="block rounded-lg border bg-card p-4 hover:bg-accent/30 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <code className="text-xs font-mono">{c.po_number}</code>
                              <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium", AMC_STATUS_CHIP[c.amc_status])}>
                                {c.amc_status}
                              </span>
                            </div>
                            <div className="text-sm">{c.procurement_vendors?.name || "—"}</div>
                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                              {c.amc_start_date && <span>{formatDate(c.amc_start_date)} — {c.amc_end_date ? formatDate(c.amc_end_date) : "Open"}</span>}
                              {c.amc_contact_name && <span>{c.amc_contact_name}</span>}
                              {c.amc_helpline_number && <span>{c.amc_helpline_number}</span>}
                            </div>
                          </div>
                          <div className="text-right shrink-0 space-y-1">
                            <div className="text-sm font-semibold">{formatCurrency(c.total_ordered_amount)}</div>
                            <div className="text-xs text-muted-foreground">
                              {c.amc_visits_used}{c.amc_visits_covered ? ` / ${c.amc_visits_covered}` : ""} visits
                            </div>
                            <ExternalLink className="h-3.5 w-3.5 ml-auto text-muted-foreground" />
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </section>

              {/* Visit history */}
              <section className="space-y-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Service Visit History ({amcEvents.length})
                </div>
                {amcEvents.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic py-3">No service events logged for this asset.</p>
                ) : (
                  <div className="space-y-2">
                    {amcEvents.map((e) => (
                      <div key={e.id} className="rounded-lg border bg-card p-3 space-y-1.5">
                        <div className="flex items-center gap-2 text-sm">
                          <span className={cn(
                            "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                            e.event_type === "breakdown" ? "bg-red-100 text-red-700" :
                            e.event_type === "preventive" ? "bg-blue-100 text-blue-700" :
                            "bg-gray-100 text-gray-700",
                          )}>
                            {AMC_EVENT_TYPE_LABEL[e.event_type] || e.event_type}
                          </span>
                          <span className="font-medium">#{e.event_number}</span>
                          <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {formatDate(e.event_date)}
                          </span>
                        </div>
                        <p className="text-sm">{e.issue_description}</p>
                        {e.resolution_notes && (
                          <div className="text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">Resolution:</span> {e.resolution_notes}
                          </div>
                        )}
                        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                          {e.technician_name && <span>Tech: {e.technician_name}</span>}
                          {e.logger && <span>Logged by: {e.logger.full_name}</span>}
                          {e.checklist && e.checklist.length > 0 && (() => {
                            const done = e.checklist.filter(c => c.checked).length;
                            const total = e.checklist.length;
                            return (
                              <span className={cn("flex items-center gap-1", done === total ? "text-emerald-600" : "")}>
                                <CheckCircle2 className="h-3 w-3" />
                                {done}/{total} checks
                              </span>
                            );
                          })()}
                          {e.confirmed_at ? (
                            <span className="flex items-center gap-1 text-emerald-600">
                              <CheckCircle2 className="h-3 w-3" />
                              Confirmed{e.confirmer ? ` by ${e.confirmer.full_name}` : ""}
                            </span>
                          ) : (
                            <span className="text-amber-600">Unconfirmed</span>
                          )}
                          {e.next_scheduled_date && (
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" /> Next: {formatDate(e.next_scheduled_date)}
                            </span>
                          )}
                          {e.report_file_url && (
                            <a href={e.report_file_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                              View report
                            </a>
                          )}
                          {e.vendor_submitted_at && (
                            <span className="flex items-center gap-1 text-purple-600">
                              <FileText className="h-3 w-3" />
                              Vendor reported
                            </span>
                          )}
                        </div>
                        {e.vendor_notes && (
                          <div className="text-xs text-purple-700 bg-purple-50 rounded px-2 py-1.5">
                            <span className="font-medium">Vendor notes:</span> {e.vendor_notes}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}

      {/* ── DOCUMENTS TAB ────────────────────────────────────────────── */}
      {tab === "documents" && (
        <DocumentsSection
          assetId={id}
          docs={docs}
          loaded={docsLoaded}
          userRole={userRole}
          onRefresh={fetchDocs}
        />
      )}

      <FacilityAssetFormDialog open={editOpen} onOpenChange={setEditOpen} asset={asset} onSuccess={() => fetchData()} />
      <AssetEventDialog
        open={eventDialogOpen}
        onOpenChange={setEventDialogOpen}
        assetId={asset.id}
        assetName={asset.name}
        assetCode={asset.asset_code}
        openIssues={asset.issue_history.filter((i): i is OpenIssue & FacilityIssue =>
          ["new", "acknowledged", "in_progress", "reopened"].includes(i.status)
        )}
        onCreated={() => { fetchEvents(); fetchData(); }}
      />
    </div>
  );
}

/* ── Documents Section ─────────────────────────────────────────── */

const TIER_CHIP: Record<AssetDocumentTier, string> = {
  commercial: "bg-amber-100 text-amber-700",
  operational: "bg-blue-100 text-blue-700",
};

const DOC_LABELS = [
  "Purchase Invoice", "Warranty Card", "AMC Contract", "Tax Invoice",
  "Installation Photo", "User Manual", "Service Report", "Inspection Certificate",
  "Floor Plan", "Other",
];

const ACCEPTED = ["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_SIZE = 10 * 1024 * 1024;

function DocumentsSection({
  assetId, docs, loaded, userRole, onRefresh,
}: {
  assetId: string;
  docs: AssetDocument[];
  loaded: boolean;
  userRole: string;
  onRefresh: () => void;
}) {
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [tier, setTier] = useState<AssetDocumentTier>("operational");
  const [label, setLabel] = useState("Other");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const canUpload = ["admin", "manager", "fms", "accounts", "office_admin", "it_manager"].includes(userRole);
  const canDelete = ["admin", "manager"].includes(userRole);

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    try {
      const supabase = createClient();
      const ext = file.name.split(".").pop() ?? "bin";
      const path = `asset-docs/${assetId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const { error: upErr } = await supabase.storage.from("procurement-docs").upload(path, file);
      if (upErr) throw new Error(upErr.message);
      const { data: urlData } = supabase.storage.from("procurement-docs").getPublicUrl(path);

      const res = await fetch(`/api/facility/assets/${assetId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier,
          label,
          file_url: urlData.publicUrl,
          file_name: file.name,
          file_size: file.size,
          mime_type: file.type,
          notes: notes || undefined,
        }),
      });
      if (!res.ok) {
        const j = await res.json();
        throw new Error(typeof j.error === "string" ? j.error : "Upload failed");
      }
      toast.success("Document uploaded");
      setShowUpload(false);
      setFile(null);
      setNotes("");
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(docId: string) {
    if (!confirm("Delete this document?")) return;
    setDeleting(docId);
    try {
      const res = await fetch(`/api/facility/assets/${assetId}/documents?doc_id=${docId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      toast.success("Document deleted");
      onRefresh();
    } catch {
      toast.error("Failed to delete document");
    } finally {
      setDeleting(null);
    }
  }

  if (!loaded) return <div className="py-12 text-center text-sm text-muted-foreground">Loading documents…</div>;

  const commercial = docs.filter(d => d.tier === "commercial");
  const operational = docs.filter(d => d.tier === "operational");

  return (
    <div className="space-y-4">
      {/* Upload form */}
      {canUpload && (
        <div>
          {!showUpload ? (
            <Button size="sm" variant="outline" onClick={() => setShowUpload(true)}>
              <Upload className="h-4 w-4 mr-1" /> Upload Document
            </Button>
          ) : (
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Upload Document</div>
                <button onClick={() => { setShowUpload(false); setFile(null); }}>
                  <X className="h-4 w-4 text-muted-foreground" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Access Tier</label>
                  <select
                    value={tier}
                    onChange={(e) => setTier(e.target.value as AssetDocumentTier)}
                    className="w-full h-9 px-2 rounded-md border bg-background text-sm"
                  >
                    <option value="operational">Operational (FMS, IT)</option>
                    <option value="commercial">Commercial (Accounts, Finance)</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Label</label>
                  <select
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    className="w-full h-9 px-2 rounded-md border bg-background text-sm"
                  >
                    {DOC_LABELS.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Notes (optional)</label>
                <input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Invoice for July 2025 servicing"
                  className="w-full h-9 px-2 rounded-md border bg-background text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">File (PDF, JPEG, PNG, WebP — max 10 MB)</label>
                {file ? (
                  <div className="flex items-center gap-2 text-sm">
                    <FileText className="h-4 w-4 text-primary" />
                    <span className="truncate">{file.name}</span>
                    <span className="text-xs text-muted-foreground">({(file.size / 1024).toFixed(0)} KB)</span>
                    <button onClick={() => setFile(null)}><X className="h-3.5 w-3.5 text-muted-foreground" /></button>
                  </div>
                ) : (
                  <input
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png,.webp"
                    className="text-sm"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      if (!ACCEPTED.includes(f.type)) { toast.error("Unsupported file type"); return; }
                      if (f.size > MAX_SIZE) { toast.error("File too large (max 10 MB)"); return; }
                      setFile(f);
                    }}
                  />
                )}
              </div>
              <Button size="sm" onClick={handleUpload} disabled={uploading || !file}>
                {uploading && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                Upload
              </Button>
            </div>
          )}
        </div>
      )}

      {docs.length === 0 && (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          <FileText className="h-6 w-6 mx-auto mb-2 opacity-30" />
          <p>No documents attached to this asset yet.</p>
        </div>
      )}

      {/* Commercial docs */}
      {commercial.length > 0 && (
        <DocGroup
          title="Commercial Documents"
          tier="commercial"
          docs={commercial}
          canDelete={canDelete}
          deleting={deleting}
          onDelete={handleDelete}
        />
      )}

      {/* Operational docs */}
      {operational.length > 0 && (
        <DocGroup
          title="Operational Documents"
          tier="operational"
          docs={operational}
          canDelete={canDelete}
          deleting={deleting}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}

function DocGroup({
  title, tier, docs, canDelete, deleting, onDelete,
}: {
  title: string;
  tier: AssetDocumentTier;
  docs: AssetDocument[];
  canDelete: boolean;
  deleting: string | null;
  onDelete: (id: string) => void;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{title}</div>
        <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium", TIER_CHIP[tier])}>
          {tier}
        </span>
      </div>
      <div className="space-y-1.5">
        {docs.map((d) => (
          <div key={d.id} className="flex items-center gap-3 rounded-lg border bg-card p-3 text-sm">
            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{d.label}</div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {d.file_name && <span className="truncate max-w-[200px]">{d.file_name}</span>}
                {d.file_size && <span>{(d.file_size / 1024).toFixed(0)} KB</span>}
                {d.uploader && <span>by {d.uploader.full_name}</span>}
                <span>{formatDate(d.created_at)}</span>
              </div>
              {d.notes && <div className="text-xs text-muted-foreground mt-0.5">{d.notes}</div>}
            </div>
            <a
              href={d.file_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline shrink-0"
            >
              View
            </a>
            {canDelete && (
              <button
                onClick={() => onDelete(d.id)}
                disabled={deleting === d.id}
                className="text-muted-foreground hover:text-destructive shrink-0"
              >
                {deleting === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
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

