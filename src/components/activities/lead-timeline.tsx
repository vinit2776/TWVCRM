"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Link from "next/link";
import {
  Phone,
  Users,
  FileText,
  Mail,
  MapPin,
  Clock,
  CalendarCheck,
  CalendarClock,
  ClipboardList,
  UserCheck,
  UserPlus,
  Receipt,
  ScrollText,
  CalendarDays,
  Send,
  BellRing,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { formatDate, formatDuration, formatCurrency } from "@/lib/utils";
import {
  ACTIVITY_TYPE_LABELS,
  CALL_OUTCOME_LABELS,
  PROPOSAL_STATUS_LABELS,
  CONTRACT_STATUS_LABELS,
  INVOICE_STATUS_LABELS,
  BOOKING_STATUS_LABELS,
} from "@/lib/constants";
import type {
  Activity,
  Proposal,
  ProformaInvoice,
  Contract,
  Booking,
  Lead,
} from "@/types";
import { ActivityForm } from "@/components/activities/activity-form";

// ─── Billing communication event (from /api/leads/[id]/billing-communications) ─
interface BillingCommEvent {
  kind: "proforma_sent" | "gst_invoice_sent" | "reminder_sent" | "payment_received"
    | "proposal_deposit_paid" | "proposal_prorata_paid";
  occurred_at: string;
  statement_id: string;
  statement_number: string | null;
  contract_number: string | null;
  detail: string;
  recipient?: string;
  status?: "sent" | "failed";
  amount?: number;
}

// ─── Unified timeline item type ───────────────────────────────────────────────
type TimelineItem =
  | { kind: "created"; date: string; lead: Lead }
  | { kind: "activity"; date: string; activity: Activity }
  | { kind: "proposal"; date: string; proposal: Proposal }
  | { kind: "invoice"; date: string; invoice: ProformaInvoice }
  | { kind: "contract"; date: string; contract: Contract }
  | { kind: "booking"; date: string; booking: Booking }
  | { kind: "billing_comm"; date: string; event: BillingCommEvent };

// ─── Activity-type icon + colour maps ────────────────────────────────────────
const ACTIVITY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  call: Phone,
  meeting: Users,
  note: FileText,
  email: Mail,
  tour: MapPin,
};

const ACTIVITY_COLORS: Record<string, string> = {
  call: "bg-blue-100 text-blue-600",
  meeting: "bg-purple-100 text-purple-600",
  note: "bg-gray-100 text-gray-600",
  email: "bg-green-100 text-green-600",
  tour: "bg-orange-100 text-orange-600",
};

// ─── Shared icon circle with optional vertical connector ──────────────────────
function TimelineIcon({
  colorClass,
  icon: Icon,
  isLast,
}: {
  colorClass: string;
  icon: React.ComponentType<{ className?: string }>;
  isLast?: boolean;
}) {
  return (
    <div className="flex flex-col items-center shrink-0">
      <div className={`rounded-full p-2 ${colorClass}`}>
        <Icon className="h-4 w-4" />
      </div>
      {!isLast && <div className="flex-1 w-px bg-border mt-2" />}
    </div>
  );
}

// ─── Activity item — preserves all follow-up / reschedule actions ─────────────
function ActivityItem({
  activity,
  leadId,
  onActionComplete,
  highlightId,
  isLast,
}: {
  activity: Activity;
  leadId: string;
  onActionComplete: () => void;
  highlightId?: string;
  isLast?: boolean;
}) {
  const Icon = ACTIVITY_ICONS[activity.type] || FileText;
  const colorClass = ACTIVITY_COLORS[activity.type] || "bg-gray-100 text-gray-600";

  const [acting, setActing] = useState(false);
  const [isRescheduling, setIsRescheduling] = useState(false);
  const [newDate, setNewDate] = useState("");
  const [highlighted, setHighlighted] = useState(false);
  const [logActivityOpen, setLogActivityOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlightId === activity.id && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlighted(true);
      const t = setTimeout(() => setHighlighted(false), 3000);
      return () => clearTimeout(t);
    }
  }, [highlightId, activity.id]);

  const hasPendingFollowUp = activity.follow_up_date && !activity.is_follow_up_done;

  const handleLogAndClose = async () => {
    try {
      await fetch(`/api/activities/${activity.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close" }),
      });
    } catch {
      // Non-fatal
    }
    onActionComplete();
  };

  const handleReschedule = async () => {
    if (!newDate) return;
    setActing(true);
    try {
      const res = await fetch(`/api/activities/${activity.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reschedule", follow_up_date: newDate }),
      });
      if (res.ok) {
        setIsRescheduling(false);
        setNewDate("");
        onActionComplete();
      }
    } finally {
      setActing(false);
    }
  };

  return (
    <div
      ref={rowRef}
      className={`flex gap-3 rounded-md transition-colors duration-500 ${
        highlighted ? "bg-orange-50 -mx-3 px-3" : ""
      }`}
    >
      <TimelineIcon colorClass={colorClass} icon={Icon} isLast={isLast} />

      <div className="flex-1 pb-6">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="text-xs">
                {ACTIVITY_TYPE_LABELS[activity.type]}
              </Badge>
              {activity.subject && (
                <span className="font-medium text-sm">{activity.subject}</span>
              )}
            </div>

            {activity.description && (
              <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">
                {activity.description}
              </p>
            )}

            {/* Call details */}
            {activity.type === "call" && (
              <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                {activity.call_outcome && (
                  <span className="flex items-center gap-1">
                    <Phone className="h-3 w-3" />
                    {CALL_OUTCOME_LABELS[activity.call_outcome]}
                  </span>
                )}
                {activity.call_duration_seconds != null &&
                  activity.call_duration_seconds > 0 && (
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {formatDuration(activity.call_duration_seconds)}
                    </span>
                  )}
              </div>
            )}

            {/* Meeting details */}
            {activity.type === "meeting" && activity.meeting_location && (
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {activity.meeting_location}
              </p>
            )}

            {/* Follow-up section */}
            {activity.follow_up_date && (
              <div className="mt-2 space-y-1 text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-1">
                    <CalendarCheck className="h-3 w-3 shrink-0" />
                    <span
                      className={
                        activity.is_follow_up_done
                          ? "text-green-600"
                          : "text-orange-600 font-medium"
                      }
                    >
                      Follow-up: {formatDate(activity.follow_up_date)}
                      {activity.is_follow_up_done ? " (Done)" : ""}
                    </span>
                  </div>

                  {hasPendingFollowUp && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setLogActivityOpen(true)}
                        className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-green-700 bg-green-50 border border-green-200 hover:bg-green-100 transition-colors"
                        title="Log what was done and close this follow-up"
                      >
                        <ClipboardList className="h-2.5 w-2.5" />
                        Log Activity
                      </button>
                      <button
                        onClick={() => {
                          if (isRescheduling) {
                            setIsRescheduling(false);
                            setNewDate("");
                          } else {
                            setNewDate(activity.follow_up_date!.split("T")[0]);
                            setIsRescheduling(true);
                          }
                        }}
                        disabled={acting}
                        className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-600 bg-slate-50 border border-slate-200 hover:bg-slate-100 transition-colors disabled:opacity-40"
                        title="Reschedule follow-up"
                      >
                        <CalendarClock className="h-2.5 w-2.5" />
                        Reschedule
                      </button>
                    </div>
                  )}
                </div>

                {isRescheduling && (
                  <div className="flex items-center gap-2 pl-4 pt-0.5">
                    <input
                      type="date"
                      value={newDate}
                      onChange={(e) => setNewDate(e.target.value)}
                      className="text-xs border rounded px-2 py-0.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                      min={new Date().toISOString().split("T")[0]}
                    />
                    <button
                      onClick={handleReschedule}
                      disabled={!newDate || acting}
                      className="text-xs font-medium text-primary hover:underline disabled:opacity-40"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => {
                        setIsRescheduling(false);
                        setNewDate("");
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {activity.follow_up_actioned_at && activity.follow_up_actor && (
                  <div className="flex items-center gap-1 text-muted-foreground pl-0.5">
                    <UserCheck className="h-3 w-3 shrink-0" />
                    <span>
                      {activity.is_follow_up_done ? "Closed" : "Rescheduled"}{" "}
                      by{" "}
                      <span className="font-medium">
                        {activity.follow_up_actor.full_name}
                      </span>{" "}
                      on {formatDate(activity.follow_up_actioned_at)}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="text-right text-xs text-muted-foreground shrink-0">
            <p>{formatDate(activity.created_at)}</p>
            {activity.creator && (
              <p className="mt-0.5">{activity.creator.full_name}</p>
            )}
          </div>
        </div>
      </div>

      <ActivityForm
        leadId={leadId}
        open={logActivityOpen}
        onOpenChange={setLogActivityOpen}
        onSuccess={handleLogAndClose}
      />
    </div>
  );
}

// ─── Generic record row (proposal, invoice, contract, booking) ────────────────
function RecordItem({
  colorClass,
  icon,
  badgeLabel,
  title,
  href,
  subtitle,
  date,
  isLast,
}: {
  colorClass: string;
  icon: React.ComponentType<{ className?: string }>;
  badgeLabel: string;
  title: string;
  href?: string;
  subtitle?: string;
  date: string;
  isLast?: boolean;
}) {
  return (
    <div className="flex gap-3">
      <TimelineIcon colorClass={colorClass} icon={icon} isLast={isLast} />
      <div className="flex-1 pb-6">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="text-xs">
                {badgeLabel}
              </Badge>
              {href ? (
                <Link
                  href={href}
                  className="font-medium text-sm text-primary hover:underline"
                >
                  {title}
                </Link>
              ) : (
                <span className="font-medium text-sm">{title}</span>
              )}
            </div>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
            )}
          </div>
          <p className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
            {formatDate(date)}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Billing communication row (proforma/GST send, reminder, payment) ─────────
const BILLING_COMM_ICONS: Record<BillingCommEvent["kind"], React.ComponentType<{ className?: string }>> = {
  proforma_sent: Send,
  gst_invoice_sent: Send,
  reminder_sent: BellRing,
  payment_received: CheckCircle2,
  proposal_deposit_paid: CheckCircle2,
  proposal_prorata_paid: CheckCircle2,
};

const BILLING_COMM_COLORS: Record<BillingCommEvent["kind"], string> = {
  proforma_sent: "bg-cyan-100 text-cyan-600",
  gst_invoice_sent: "bg-emerald-100 text-emerald-600",
  reminder_sent: "bg-amber-100 text-amber-600",
  payment_received: "bg-green-100 text-green-600",
  proposal_deposit_paid: "bg-green-100 text-green-600",
  proposal_prorata_paid: "bg-green-100 text-green-600",
};

const BILLING_COMM_LABELS: Record<BillingCommEvent["kind"], string> = {
  proforma_sent: "Proforma",
  gst_invoice_sent: "GST Invoice",
  reminder_sent: "Reminder",
  payment_received: "Payment",
  proposal_deposit_paid: "Deposit",
  proposal_prorata_paid: "Pro-rata",
};

function BillingCommItem({ event, isLast }: { event: BillingCommEvent; isLast?: boolean }) {
  const Icon = BILLING_COMM_ICONS[event.kind];
  const colorClass = BILLING_COMM_COLORS[event.kind];
  const failed = event.status === "failed";

  return (
    <div className="flex gap-3">
      <TimelineIcon colorClass={colorClass} icon={Icon} isLast={isLast} />
      <div className="flex-1 pb-6">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="text-xs">
                {BILLING_COMM_LABELS[event.kind]}
              </Badge>
              <span className="font-medium text-sm">{event.detail}</span>
              {failed && (
                <span className="flex items-center gap-0.5 text-xs text-red-600">
                  <XCircle className="h-3 w-3" /> failed
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {[
                event.contract_number,
                event.statement_number,
                event.recipient,
                event.amount != null ? formatCurrency(event.amount) : null,
              ].filter(Boolean).join(" · ")}
            </p>
          </div>
          <p className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
            {formatDate(event.occurred_at)}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Lead created anchor (always last in the list) ────────────────────────────
function LeadCreatedItem({ lead }: { lead: Lead }) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center shrink-0">
        <div className="rounded-full p-2 bg-amber-100 text-amber-600">
          <UserPlus className="h-4 w-4" />
        </div>
        {/* No connector — this is the last item */}
      </div>
      <div className="flex-1 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                Lead Created
              </Badge>
              <span className="font-medium text-sm">
                {lead.first_name} {lead.last_name}
              </span>
            </div>
            {lead.company && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {lead.company}
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
            {formatDate(lead.created_at)}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
interface LeadTimelineProps {
  leadId: string;
  lead: Lead;
  /** Activity ID to scroll-to + highlight on mount */
  highlightId?: string;
}

const BILLING_COMMS_PAGE_SIZE = 50;

export function LeadTimeline({ leadId, lead, highlightId }: LeadTimelineProps) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  // Billing communications are kept separate from `items` so "Load more" can
  // fetch and append the next page without re-fetching activities/proposals/etc.
  const [billingComms, setBillingComms] = useState<BillingCommEvent[]>([]);
  const [billingCommsHasMore, setBillingCommsHasMore] = useState(false);
  const [billingCommsLoadingMore, setBillingCommsLoadingMore] = useState(false);

  // Stable refs — avoid re-creating fetchAll (and re-fetching) on every parent render.
  // The lead object changes reference on every parent render; keeping it in useCallback
  // deps would re-trigger all 5 fetches on every keystroke/state update in the parent.
  const leadRef = useRef(lead);
  leadRef.current = lead;
  const leadCreatedAtRef = useRef(lead.created_at);
  leadCreatedAtRef.current = lead.created_at;

  const fetchAll = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const opts = signal ? { signal } : {};
      const [activitiesRes, proposalsRes, invoicesRes, contractsRes, bookingsRes, billingCommsRes] =
        await Promise.all([
          fetch(`/api/leads/${leadId}/activities`, opts),
          fetch(`/api/proposals?lead_id=${leadId}`, opts),
          fetch(`/api/invoices?lead_id=${leadId}`, opts),
          fetch(`/api/contracts?lead_id=${leadId}`, opts),
          fetch(`/api/bookings?lead_id=${leadId}&limit=50`, opts),
          fetch(`/api/leads/${leadId}/billing-communications?limit=${BILLING_COMMS_PAGE_SIZE}&offset=0`, opts),
        ]);

      if (signal?.aborted) return;

      const merged: TimelineItem[] = [];

      if (activitiesRes.ok) {
        const json = await activitiesRes.json();
        (json.data || []).forEach((a: Activity) =>
          merged.push({ kind: "activity", date: a.created_at, activity: a })
        );
      }
      if (proposalsRes.ok) {
        const json = await proposalsRes.json();
        (json.data || []).forEach((p: Proposal) =>
          merged.push({ kind: "proposal", date: p.created_at, proposal: p })
        );
      }
      if (invoicesRes.ok) {
        const json = await invoicesRes.json();
        (json.data || []).forEach((inv: ProformaInvoice) =>
          merged.push({ kind: "invoice", date: inv.created_at, invoice: inv })
        );
      }
      if (contractsRes.ok) {
        const json = await contractsRes.json();
        (json.data || []).forEach((c: Contract) =>
          merged.push({ kind: "contract", date: c.created_at, contract: c })
        );
      }
      if (bookingsRes.ok) {
        const json = await bookingsRes.json();
        (json.data || []).forEach((b: Booking) =>
          merged.push({ kind: "booking", date: b.created_at, booking: b })
        );
      }
      // 403 for roles outside admin/manager/accounts — silently omit, not an error.
      if (billingCommsRes.ok) {
        const json = await billingCommsRes.json();
        setBillingComms(json.data || []);
        setBillingCommsHasMore(Boolean(json.has_more));
      } else {
        setBillingComms([]);
        setBillingCommsHasMore(false);
      }

      // Sort newest-first; lead creation is pinned at the very end
      merged.sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      );
      merged.push({ kind: "created", date: leadCreatedAtRef.current, lead: leadRef.current });

      setItems(merged);
    } catch (err) {
      if ((err as Error).name !== "AbortError") console.error("[timeline] fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, [leadId, refreshKey]); // leadRef/leadCreatedAtRef are stable refs — no need in deps

  useEffect(() => {
    const controller = new AbortController();
    fetchAll(controller.signal);
    return () => controller.abort();
  }, [fetchAll]);

  const handleRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const loadMoreBillingComms = useCallback(async () => {
    setBillingCommsLoadingMore(true);
    try {
      const res = await fetch(
        `/api/leads/${leadId}/billing-communications?limit=${BILLING_COMMS_PAGE_SIZE}&offset=${billingComms.length}`
      );
      if (res.ok) {
        const json = await res.json();
        setBillingComms((prev) => [...prev, ...(json.data || [])]);
        setBillingCommsHasMore(Boolean(json.has_more));
      }
    } catch (err) {
      console.error("[timeline] load more billing comms failed:", err);
    } finally {
      setBillingCommsLoadingMore(false);
    }
  }, [leadId, billingComms.length]);

  // Merge the currently-loaded billing comm events into the sorted item list.
  // Kept separate from `items` (see fetchAll) so "Load more" only appends here
  // instead of re-fetching activities/proposals/contracts/bookings.
  const displayItems = useMemo(() => {
    const created = items[items.length - 1];
    const rest = items.slice(0, -1);
    const billingItems: TimelineItem[] = billingComms.map((e) => ({
      kind: "billing_comm",
      date: e.occurred_at,
      event: e,
    }));
    const merged = [...rest, ...billingItems].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
    if (created) merged.push(created);
    return merged;
  }, [items, billingComms]);

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-full" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      {displayItems.map((item, idx) => {
        const isLast = idx === displayItems.length - 1;

        if (item.kind === "created") {
          return <LeadCreatedItem key="created" lead={item.lead} />;
        }

        if (item.kind === "activity") {
          return (
            <ActivityItem
              key={`act-${item.activity.id}`}
              activity={item.activity}
              leadId={leadId}
              onActionComplete={handleRefresh}
              highlightId={highlightId}
              isLast={isLast}
            />
          );
        }

        if (item.kind === "proposal") {
          const p = item.proposal;
          return (
            <RecordItem
              key={`prop-${p.id}`}
              colorClass="bg-indigo-100 text-indigo-600"
              icon={FileText}
              badgeLabel="Proposal"
              title={`${p.proposal_number} — ${p.title}`}
              href={`/proposals/${p.id}`}
              subtitle={`${PROPOSAL_STATUS_LABELS[p.status] ?? p.status} · ${formatCurrency(p.total_amount)}`}
              date={p.created_at}
              isLast={isLast}
            />
          );
        }

        if (item.kind === "invoice") {
          const inv = item.invoice;
          return (
            <RecordItem
              key={`inv-${inv.id}`}
              colorClass="bg-emerald-100 text-emerald-600"
              icon={Receipt}
              badgeLabel="Invoice"
              title={`${inv.invoice_number} — ${inv.title}`}
              subtitle={`${INVOICE_STATUS_LABELS[inv.status] ?? inv.status} · ${formatCurrency(inv.total_amount)}`}
              date={inv.created_at}
              isLast={isLast}
            />
          );
        }

        if (item.kind === "contract") {
          const c = item.contract;
          return (
            <RecordItem
              key={`con-${c.id}`}
              colorClass="bg-violet-100 text-violet-600"
              icon={ScrollText}
              badgeLabel="Contract"
              title={`${c.contract_number} — ${c.title}`}
              href={`/contracts/${c.id}`}
              subtitle={`${CONTRACT_STATUS_LABELS[c.status] ?? c.status} · ${formatCurrency(c.total_amount)}`}
              date={c.created_at}
              isLast={isLast}
            />
          );
        }

        if (item.kind === "billing_comm") {
          return (
            <BillingCommItem
              key={`bc-${item.event.statement_id}-${item.event.kind}-${item.event.occurred_at}-${item.event.recipient ?? ""}`}
              event={item.event}
              isLast={isLast}
            />
          );
        }

        if (item.kind === "booking") {
          const b = item.booking;
          const spaceName = (b.space as { name: string } | undefined)?.name;
          const customer =
            b.guest_name ||
            (b.lead
              ? b.lead.company ||
                `${b.lead.first_name} ${b.lead.last_name}`
              : null);
          return (
            <RecordItem
              key={`bkg-${b.id}`}
              colorClass="bg-sky-100 text-sky-600"
              icon={CalendarDays}
              badgeLabel="Booking"
              title={`${b.booking_number}${spaceName ? ` — ${spaceName}` : ""}`}
              subtitle={`${BOOKING_STATUS_LABELS[b.status] ?? b.status}${customer ? ` · ${customer}` : ""} · ${b.booking_date} ${b.start_time}–${b.end_time}`}
              date={b.created_at}
              isLast={isLast}
            />
          );
        }

        return null;
      })}

      {billingCommsHasMore && (
        <div className="flex justify-center pb-6">
          <button
            onClick={loadMoreBillingComms}
            disabled={billingCommsLoadingMore}
            className="text-xs font-medium text-primary hover:underline disabled:opacity-40"
          >
            {billingCommsLoadingMore ? "Loading…" : "Load more billing communications"}
          </button>
        </div>
      )}

      {items.length === 1 && items[0].kind === "created" && (
        <p className="text-sm text-muted-foreground text-center py-6">
          No activities yet. Log your first interaction above.
        </p>
      )}
    </div>
  );
}
