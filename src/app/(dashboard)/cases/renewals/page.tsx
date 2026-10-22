"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { LocationSelector } from "@/components/shared/location-selector";
import { pushTrailEntry } from "@/lib/nav-trail";
import { formatDate, formatCurrency, cn } from "@/lib/utils";
import {
  RENEWAL_DESK_TABS,
  RENEWAL_DESK_TAB_LABELS,
  renewalDeskTabHint,
  DEFAULT_RENEWAL_GRACE_DAYS,
  RENEWAL_DESK_WINDOW_DAYS,
  daysUntil,
  relativeEnd,
  type RenewalDeskTab,
} from "@/lib/vo-renewal-desk";
import { toast } from "sonner";
import { nextStepFor, needsRole, type RenewalJourney } from "@/lib/vo-renewal-journey";
import { RenewalTermHint } from "@/components/cases/renewal-guidance";
import type { RenewalTerm } from "@/lib/vo-renewal-guidance";

interface DeskRow {
  id: string;
  case_number: string | null;
  client: string;
  purpose: string;
  status: string;
  location: string | null;
  tab: RenewalDeskTab;
  end_date: string | null;
  days_left: number | null;
  /** Last day still in grace, for a case on the In grace tab. */
  grace_last_day: string | null;
  payer: { kind: "client" | "aggregator"; name: string; postpaid: boolean; blocked: string | null };
  fee: number | null;
  escalation_percentage: number | null;
  notices_enabled: boolean | null;
  open_bill: { id: string; statement_number: string | null; total_amount: number; payment_status: string; created_at: string } | null;
  partner_confirmation: { term_start: string; new_rate: number } | null;
  reminders: { count: number; last_sent_at: string | null };
  draft_documents: number;
  journey: RenewalJourney | null;
}

type PayerFilter = "all" | "client" | "partner";

const PILL: Record<string, string> = {
  gray: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  blue: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  orange: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
  red: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
};

/** One line on where the renewal stands, from data the desk already has. */
function whereItStands(r: DeskRow): { text: string; tone: keyof typeof PILL } {
  if (r.payer.postpaid) {
    return r.partner_confirmation
      ? { text: `Partner confirmed · new term ${formatDate(r.partner_confirmation.term_start)}`, tone: "blue" }
      : { text: "Partner not yet confirmed", tone: "amber" };
  }
  if (r.payer.blocked) return { text: "Billing party not set", tone: "amber" };
  switch (r.tab) {
    case "coming":
      return { text: "Not contacted", tone: "gray" };
    case "due":
      if (!r.open_bill) return { text: "Marked due, no bill", tone: "amber" };
      return {
        text: r.reminders.count > 1 ? `${r.reminders.count} notices sent` : "Notice sent",
        tone: "amber",
      };
    case "grace":
      return { text: r.open_bill ? "Unpaid, bill sent" : "Unpaid, no bill", tone: "orange" };
    case "lapsed":
      return r.draft_documents > 0
        ? { text: `${r.draft_documents} draft${r.draft_documents === 1 ? "" : "s"} to review`, tone: "red" }
        : { text: "Decision needed", tone: "red" };
  }
}

/** "3 grace days left" / "last grace day today", counting the last day itself. */
function graceLeft(lastDay: string, today: string): string {
  const left = daysUntil(lastDay, today);
  if (left <= 0) return "last grace day today";
  return `${left} grace day${left === 1 ? "" : "s"} left`;
}

/** Desk tabs whose name is a renewal term with a definition on hover. */
const TAB_TERM: Partial<Record<RenewalDeskTab, RenewalTerm>> = { grace: "grace", lapsed: "lapsed" };

const DATE_COLUMN: Record<RenewalDeskTab, string> = {
  coming: "Ends",
  due: "Ends",
  grace: "Ended",
  lapsed: "Ended",
};

export default function RenewalsDeskPage() {
  const [rows, setRows] = useState<DeskRow[]>([]);
  const [today, setToday] = useState<string | null>(null);
  const [graceDays, setGraceDays] = useState(DEFAULT_RENEWAL_GRACE_DAYS);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<RenewalDeskTab>("coming");
  const [locationId, setLocationId] = useState<string | null>(null);
  const [payer, setPayer] = useState<PayerFilter>("all");
  const [role, setRole] = useState<string | null>(null);
  const [needsMe, setNeedsMe] = useState(false);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((j) => setRole(j.role ?? null))
      .catch(() => {
        // Without a role the desk still lists every case; only "Needs me" is unavailable.
      });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = locationId ? `?location_id=${locationId}` : "";
      const res = await fetch(`/api/cases/renewals${qs}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load renewals");
      setRows(json.data ?? []);
      setToday(json.today ?? null);
      if (json.grace_days) setGraceDays(json.grace_days);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load renewals");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [locationId]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        const payerOk = payer === "all" ? true : payer === "client" ? r.payer.kind === "client" : r.payer.kind === "aggregator";
        return payerOk && (!needsMe || (!!r.journey && needsRole(r.journey, role)));
      }),
    [rows, payer, needsMe, role],
  );

  const counts = useMemo(() => {
    const c: Record<RenewalDeskTab, number> = { coming: 0, due: 0, grace: 0, lapsed: 0 };
    for (const r of filtered) c[r.tab] += 1;
    return c;
  }, [filtered]);

  const visible = filtered.filter((r) => r.tab === tab);

  return (
    <div className="space-y-4">
      <PageBreadcrumb current={{ label: "Renewals" }} fallbackParent={{ href: "/cases", label: "Cases" }} />

      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Virtual office renewals</h1>
          <p className="text-sm text-muted-foreground">
            Every live case appears here {RENEWAL_DESK_WINDOW_DAYS} days before its end date and stays until it is renewed or closed.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="w-[180px]">
            <LocationSelector
              value={locationId}
              onValueChange={setLocationId}
              includeAllOption
              placeholder="All Locations"
            />
          </div>
          <Select value={payer} onValueChange={(v) => setPayer(v as PayerFilter)}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Billed to anyone</SelectItem>
              <SelectItem value="client">Billed to client</SelectItem>
              <SelectItem value="partner">Billed to partner</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant={needsMe ? "default" : "outline"}
            disabled={!role}
            onClick={() => setNeedsMe((v) => !v)}
            aria-pressed={needsMe}
            title="Show only the cases where the next step is yours to do"
          >
            Needs me
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {RENEWAL_DESK_TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "flex flex-col items-start gap-0.5 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-muted/40",
              tab === t && "border-primary ring-1 ring-primary",
            )}
          >
            <span className="text-sm font-medium text-muted-foreground">
              {TAB_TERM[t] ? <RenewalTermHint term={TAB_TERM[t]!}>{RENEWAL_DESK_TAB_LABELS[t]}</RenewalTermHint> : RENEWAL_DESK_TAB_LABELS[t]}
            </span>
            <span className="text-2xl font-bold tabular-nums">{loading ? "–" : counts[t]}</span>
            <span className="text-xs text-muted-foreground">{renewalDeskTabHint(t, graceDays)}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <TableSkeleton rows={6} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Nothing here"
          description={
            tab === "lapsed"
              ? "No case is past its grace period."
              : "No case is in this stage right now."
          }
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left">
                <th className="px-4 py-3 font-medium">Case</th>
                <th className="px-4 py-3 font-medium hidden md:table-cell">Billed to</th>
                <th className="px-4 py-3 font-medium">{DATE_COLUMN[tab]}</th>
                <th className="px-4 py-3 font-medium hidden lg:table-cell">Renewal fee</th>
                <th className="px-4 py-3 font-medium">Where it stands</th>
                <th className="px-4 py-3 font-medium text-right">Next step</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const stand = whereItStands(r);
                return (
                  <tr key={r.id} className="border-b last:border-0 align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium">{r.client}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.case_number}
                        {r.location ? ` · ${r.location}` : ""}
                      </div>
                      <StatusBadge type="vo_purpose" value={r.purpose} className="mt-1" />
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <div>{r.payer.kind === "client" ? "Client" : r.payer.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.payer.postpaid ? "Postpaid partner" : r.payer.kind === "aggregator" ? "Prepaid partner" : "Direct"}
                      </div>
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {r.end_date ? (
                        <>
                          <div>{formatDate(r.end_date)}</div>
                          {r.days_left !== null && (
                            <div className="text-xs text-muted-foreground">
                              {r.tab === "grace" && r.days_left < 0 && r.grace_last_day && today
                                ? `${relativeEnd(r.days_left)}, ${graceLeft(r.grace_last_day, today)}`
                                : relativeEnd(r.days_left)}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell tabular-nums">
                      {r.fee !== null ? (
                        <>
                          <div>{formatCurrency(r.fee)}</div>
                          <div className="text-xs text-muted-foreground">
                            {r.escalation_percentage ? `+${r.escalation_percentage}% agreed escalation` : "No escalation"}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">Monthly billing</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn("inline-block rounded-full px-2.5 py-1 text-xs font-semibold", PILL[stand.tone])}>
                        {stand.text}
                      </span>
                      {r.reminders.last_sent_at && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          Last notice {formatDate(r.reminders.last_sent_at)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {(() => {
                        const view = r.journey ? nextStepFor(r.journey, role) : null;
                        if (!view) return null;
                        return (
                          <div className="mb-1.5 text-xs">
                            <div className={cn("font-medium", view.mine ? "text-blue-700 dark:text-blue-300" : "text-muted-foreground")}>
                              {view.step.label}
                            </div>
                            <div className="text-muted-foreground">
                              {view.mine ? "Yours to do" : `Waiting on ${view.waitingOn?.toLowerCase()}`}
                            </div>
                          </div>
                        );
                      })()}
                      {(() => {
                        // A case with no renewal bill yet gets Start renewal; one
                        // already offered is followed up from the case.
                        const canStart = !r.payer.postpaid && !r.payer.blocked && !r.open_bill && r.tab !== "lapsed";
                        // A postpaid partner has no bill: staff confirm with the partner instead.
                        const canConfirmPartner = r.payer.postpaid && !r.partner_confirmation && r.tab !== "lapsed";
                        const primary = canStart || canConfirmPartner;
                        return (
                          <Button asChild variant={primary ? "default" : "outline"} size="sm">
                            <Link
                              href={`/cases/${r.id}?tab=renewal${canStart ? "&start_renewal=1" : ""}${canConfirmPartner ? "&partner_renewal=1" : ""}`}
                              onClick={() => pushTrailEntry({ href: `/cases/${r.id}`, label: r.client })}
                            >
                              {canStart ? "Start renewal" : canConfirmPartner ? "Confirm partner" : r.tab === "lapsed" ? "Decide" : "Open case"}
                            </Link>
                          </Button>
                        );
                      })()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Nothing on this screen contacts a customer. Start renewal sends only on the channels you tick, and recording a payment and starting discontinuation are always a person&apos;s click. The daily reminder job only follows up renewals started here, on cases switched on from their Renewal tab.
      </p>
    </div>
  );
}
