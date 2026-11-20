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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  RENEWAL_BOARD_TABS,
  RENEWAL_BOARD_TAB_LABELS,
  renewalBoardTabHint,
  type NoticeScheduleEntry,
  type RenewalBoardTab,
  DEFAULT_RENEWAL_GRACE_DAYS,
  RENEWAL_DESK_WINDOW_DAYS,
  daysUntil,
  relativeEnd,
} from "@/lib/vo-renewal-desk";
import { toast } from "sonner";

interface DeskRow {
  id: string;
  case_number: string | null;
  client: string;
  purpose: string;
  status: string;
  location: string | null;
  tab: RenewalBoardTab;
  needs_action: boolean;
  renewed_at: string | null;
  recipients: {
    billing: { kind: "client" | "aggregator"; name: string; email: string | null; phone: string | null };
    heads_up: { kind: "client" | "aggregator"; name: string; email: string | null; phone: string | null } | null;
  };
  notice_schedule: NoticeScheduleEntry[];
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
    case "active":
      return { text: "Nothing due yet", tone: "gray" };
    case "renewed":
      return { text: r.renewed_at ? `Renewed ${formatDate(r.renewed_at)}` : "Renewed", tone: "blue" };
  }
}

/** "3 grace days left" / "last grace day today", counting the last day itself. */
function graceLeft(lastDay: string, today: string): string {
  const left = daysUntil(lastDay, today);
  if (left <= 0) return "last grace day today";
  return `${left} grace day${left === 1 ? "" : "s"} left`;
}

const DATE_COLUMN: Record<RenewalBoardTab, string> = {
  active: "Ends",
  renewed: "Ended",
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
  const [tab, setTab] = useState<RenewalBoardTab>("coming");
  const [locationId, setLocationId] = useState<string | null>(null);
  const [payer, setPayer] = useState<PayerFilter>("all");
  const [onlyNeedsAction, setOnlyNeedsAction] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

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
      rows.filter((r) =>
        payer === "all" ? true : payer === "client" ? r.payer.kind === "client" : r.payer.kind === "aggregator",
      ),
    [rows, payer],
  );

  const counts = useMemo(() => {
    const c: Record<RenewalBoardTab, number> = { coming: 0, due: 0, grace: 0, lapsed: 0, active: 0, renewed: 0 };
    for (const r of filtered) if (!onlyNeedsAction || r.needs_action) c[r.tab] += 1;
    return c;
  }, [filtered, onlyNeedsAction]);

  const needsActionTotal = useMemo(() => filtered.filter((r) => r.needs_action).length, [filtered]);
  const visible = filtered.filter((r) => r.tab === tab && (!onlyNeedsAction || r.needs_action));
  const openRow = rows.find((r) => r.id === openId) ?? null;

  return (
    <div className="space-y-4">
      <PageBreadcrumb current={{ label: "Renewals" }} fallbackParent={{ href: "/cases", label: "Cases" }} />

      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Virtual office renewals</h1>
          <p className="text-sm text-muted-foreground">
            Every live case appears under Coming up {RENEWAL_DESK_WINDOW_DAYS} days before its end date and stays until it is renewed or closed. Active shows cases ending later; Renewed shows the last 60 days.
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
            variant={onlyNeedsAction ? "default" : "outline"}
            onClick={() => setOnlyNeedsAction((v) => !v)}
            aria-pressed={onlyNeedsAction}
          >
            Needs action{loading ? "" : ` (${needsActionTotal})`}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        {RENEWAL_BOARD_TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "flex flex-col items-start gap-0.5 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-muted/40",
              tab === t && "border-primary ring-1 ring-primary",
            )}
          >
            <span className="text-sm font-medium text-muted-foreground">{RENEWAL_BOARD_TAB_LABELS[t]}</span>
            <span className="text-2xl font-bold tabular-nums">{loading ? "–" : counts[t]}</span>
            <span className="text-xs text-muted-foreground">{renewalBoardTabHint(t, graceDays)}</span>
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
                    <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                      <Button type="button" variant="ghost" size="sm" onClick={() => setOpenId(r.id)}>
                        Details
                      </Button>
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

      <Sheet open={!!openRow} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          {openRow && <CaseDrawer row={openRow} today={today} />}
        </SheetContent>
      </Sheet>

      <p className="text-xs text-muted-foreground">
        Nothing on this screen contacts a customer. Start renewal sends only on the channels you tick, and recording a payment and starting discontinuation are always a person&apos;s click. The daily reminder job only follows up renewals started here, on cases switched on from their Renewal tab.
      </p>
    </div>
  );
}

const PAYMENT_LABEL: Record<string, string> = {
  unpaid: "Unpaid",
  partial: "Partly paid",
  paid: "Paid",
  overdue: "Overdue",
};

/** Read-only detail for one case: who is billed, the notice schedule and where payment stands. */
function CaseDrawer({ row, today }: { row: DeskRow; today: string | null }) {
  const people = [
    { role: "Billed party", p: row.recipients.billing },
    ...(row.recipients.heads_up ? [{ role: "Heads-up copy (end client)", p: row.recipients.heads_up }] : []),
  ];
  return (
    <>
      <SheetHeader>
        <SheetTitle>{row.client}</SheetTitle>
        <p className="text-xs text-muted-foreground">
          {row.case_number}
          {row.end_date ? ` · ends ${formatDate(row.end_date)}` : ""}
        </p>
      </SheetHeader>
      <div className="mt-4 space-y-5 text-sm">
        <section>
          <h3 className="mb-1 font-semibold">Recipients</h3>
          {row.payer.blocked && <p className="mb-1 text-xs text-amber-700 dark:text-amber-300">{row.payer.blocked}</p>}
          <ul className="space-y-2">
            {people.map(({ role, p }) => (
              <li key={role} className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">{role}</div>
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-muted-foreground">{p.email ?? "No email on file"}</div>
                <div className="text-xs text-muted-foreground">{p.phone ?? "No phone on file"}</div>
              </li>
            ))}
          </ul>
          {row.payer.postpaid && (
            <p className="mt-1 text-xs text-muted-foreground">Postpaid partner: billed monthly, no renewal bill.</p>
          )}
        </section>

        <section>
          <h3 className="mb-1 font-semibold">Notice schedule</h3>
          {row.notice_schedule.length === 0 ? (
            <p className="text-xs text-muted-foreground">No end date, so no schedule.</p>
          ) : (
            <ul className="space-y-1">
              {row.notice_schedule.map((n) => (
                <li key={n.number} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5">
                  <div>
                    <div className="font-medium">{n.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {n.status === "sent" && n.sent_at
                        ? `Sent ${formatDate(n.sent_at)}${n.channels.length ? ` by ${n.channels.join(" and ")}` : ""}`
                        : `Due ${formatDate(n.due_date)}`}
                    </div>
                  </div>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs font-semibold",
                      n.status === "sent" ? PILL.blue : n.overdue && today ? PILL.amber : PILL.gray,
                    )}
                  >
                    {n.status === "sent" ? "Sent" : n.overdue ? "Pending, past due" : "Pending"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            Reminder 1 is sent by a person from Start renewal; the daily job sends the rest, only for cases switched on.
            Automatic reminders: {row.notices_enabled ? "on" : "off"}.
          </p>
        </section>

        <section>
          <h3 className="mb-1 font-semibold">Payment</h3>
          {row.tab === "renewed" ? (
            <p>Renewed{row.renewed_at ? ` on ${formatDate(row.renewed_at)}` : ""}.</p>
          ) : row.open_bill ? (
            <p>
              {row.open_bill.statement_number ?? "Renewal bill"} · {formatCurrency(row.open_bill.total_amount)} ·{" "}
              <strong>{PAYMENT_LABEL[row.open_bill.payment_status] ?? row.open_bill.payment_status}</strong>
            </p>
          ) : row.payer.postpaid ? (
            <p className="text-muted-foreground">No renewal bill (monthly billing).</p>
          ) : (
            <p className="text-muted-foreground">No renewal bill yet.</p>
          )}
        </section>
      </div>
    </>
  );
}
