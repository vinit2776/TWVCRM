"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Flag, TrendingUp, TrendingDown, Minus, Check } from "lucide-react";
import { toast } from "sonner";
import { useCurrentUser } from "@/providers/current-user-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  BOOKING_LATE_CLOSE_OUT, PROCESS_DEVIATIONS, REVIEW_OUTCOMES, findReason, daysBetween,
  type ReviewOutcome,
} from "@/lib/process-registry";

interface PersonRow {
  user_id: string | null;
  full_name: string;
  role: string | null;
  counted: number;
  total: number;
  unreviewed: number;
  amount_at_stake: number;
  top_reason: string | null;
  trend: number;
}

interface Item {
  id: string;
  process_key: string;
  deviation_type: string;
  entity_type: string;
  entity_id: string;
  due_on: string | null;
  recorded_at: string;
  reason_code: string;
  comment: string | null;
  counts_against_person: boolean;
  amount_at_stake: number | string | null;
  details: { booking_number?: string; outcome?: string; closed_unpaid?: boolean; unpaid_note?: string | null } | null;
  accountable: { full_name: string; role: string } | null;
  recorder: { full_name: string; role: string } | null;
  location: { name: string } | null;
  reviewed_at: string | null;
  review_outcome: ReviewOutcome | null;
  review_note: string | null;
}

interface Payload {
  days: number;
  summary: {
    people: PersonRow[];
    reasons: Array<{ reason_code: string; count: number }>;
    totals: { total: number; counted: number; unreviewed: number; amount_at_stake: number };
  };
  items: Item[];
}

const KEY = BOOKING_LATE_CLOSE_OUT;

function reasonLabel(code: string): string {
  return findReason(KEY, code)?.label ?? code;
}

function Trend({ value }: { value: number }) {
  if (value > 0) return <span className="inline-flex items-center gap-1 text-red-700"><TrendingUp className="h-3.5 w-3.5" />up {value}</span>;
  if (value < 0) return <span className="inline-flex items-center gap-1 text-green-700"><TrendingDown className="h-3.5 w-3.5" />down {Math.abs(value)}</span>;
  return <span className="inline-flex items-center gap-1 text-muted-foreground"><Minus className="h-3.5 w-3.5" />same</span>;
}

export default function ProcessExceptionsPage() {
  const { user, loading: userLoading } = useCurrentUser();
  const allowed = user?.role === "admin" || user?.role === "manager";
  const [days, setDays] = useState("30");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [personFilter, setPersonFilter] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ReviewOutcome | "">("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/process-deviations?days=${days}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load");
      setData(json as Payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { if (allowed) void load(); }, [allowed, load]);

  async function saveReview(id: string) {
    if (!outcome) { toast.error("Pick an outcome"); return; }
    setSaving(true);
    const res = await fetch(`/api/process-deviations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome, note: note.trim() || undefined }),
    });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { toast.error(json.error || "Could not save"); return; }
    toast.success("Reviewed");
    setReviewing(null); setOutcome(""); setNote("");
    void load();
  }

  if (userLoading) return null;
  if (!allowed) {
    return <EmptyState icon={Flag} title="Admins and managers only" description="Staff exceptions is a coaching record, so it's limited to admins and managers." />;
  }

  const items = (data?.items ?? []).filter((i) => !personFilter || (i.accountable ? i.accountable.full_name : "Unassigned") === personFilter);

  return (
    <div className="space-y-6">
      <PageBreadcrumb resetTo={{ label: "Staff exceptions" }} />
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Staff exceptions</h1>
          <p className="text-sm text-muted-foreground">
            Where people stepped off the standard path. Every one went through, and each needs a look.
          </p>
        </div>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading && !data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : data && data.summary.totals.total === 0 ? (
        <EmptyState icon={Flag} title="No exceptions in this period" description="Nothing has been closed out late or taken off the standard path." />
      ) : data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              ["Recorded", data.summary.totals.total],
              ["Count against staff", data.summary.totals.counted],
              ["Not yet reviewed", data.summary.totals.unreviewed],
              ["Unpaid at the time", formatCurrency(data.summary.totals.amount_at_stake)],
            ].map(([label, value]) => (
              <div key={label as string} className="rounded-lg bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-xl font-semibold">{value}</p>
              </div>
            ))}
          </div>

          <div className="rounded-lg border">
            <div className="grid grid-cols-[1.4fr_.7fr_1.2fr_.7fr_.6fr] gap-2 px-3 py-2 text-xs text-muted-foreground border-b">
              <span>Staff member</span><span>Counted</span><span>Top reason</span><span>Trend</span><span>Unreviewed</span>
            </div>
            {data.summary.people.map((p) => (
              <button
                key={p.user_id ?? "none"}
                onClick={() => setPersonFilter(personFilter === p.full_name ? null : p.full_name)}
                className={`w-full text-left grid grid-cols-[1.4fr_.7fr_1.2fr_.7fr_.6fr] gap-2 px-3 py-2.5 text-sm border-b last:border-0 hover:bg-muted/40 ${personFilter === p.full_name ? "bg-muted/60" : ""}`}
              >
                <span>{p.full_name}{p.role && <span className="block text-xs text-muted-foreground">{p.role.replace("_", " ")}</span>}</span>
                <span>{p.counted}{p.total !== p.counted && <span className="text-xs text-muted-foreground"> of {p.total}</span>}</span>
                <span>{p.top_reason ? reasonLabel(p.top_reason) : "-"}</span>
                <span className="text-xs"><Trend value={p.trend} /></span>
                <span>{p.unreviewed}</span>
              </button>
            ))}
          </div>

          <div className="space-y-2">
            <h2 className="text-sm font-medium">
              {personFilter ? `${personFilter}'s exceptions` : "Recent exceptions"}
              {personFilter && <button className="ml-2 text-xs text-muted-foreground underline" onClick={() => setPersonFilter(null)}>show all</button>}
            </h2>
            {items.map((i) => {
              const late = i.due_on ? Math.max(0, daysBetween(i.due_on, i.recorded_at.slice(0, 10))) : null;
              const def = PROCESS_DEVIATIONS[KEY];
              return (
                <div key={i.id} className="rounded-lg border p-3 text-sm space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{def.label}</span>
                    {i.entity_type === "booking" ? (
                      <Link className="text-blue-700 underline" href={`/bookings/${i.entity_id}`}>{i.details?.booking_number ?? "Booking"}</Link>
                    ) : null}
                    <Badge variant="outline">{reasonLabel(i.reason_code)}</Badge>
                    {!i.counts_against_person && <Badge variant="outline" className="bg-gray-50">Not counted</Badge>}
                    {i.details?.closed_unpaid && <Badge variant="outline" className="bg-red-50 text-red-800">Closed unpaid</Badge>}
                    {i.reviewed_at ? (
                      <Badge variant="outline" className="bg-green-50 text-green-800">
                        <Check className="h-3 w-3 mr-1" />{REVIEW_OUTCOMES.find((o) => o.value === i.review_outcome)?.label}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="bg-amber-50 text-amber-800">Needs review</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    On {i.accountable?.full_name ?? "unassigned"}, closed by {i.recorder?.full_name ?? "unknown"}
                    {i.location ? ` · ${i.location.name}` : ""}
                    {i.due_on ? ` · due ${formatDate(i.due_on)}` : ""}
                    {late !== null ? ` · ${late}d late` : ""}
                    {Number(i.amount_at_stake) > 0 ? ` · ${formatCurrency(Number(i.amount_at_stake))} unpaid then` : ""}
                  </p>
                  {i.comment && <p className="text-sm">&ldquo;{i.comment}&rdquo;</p>}
                  {i.details?.closed_unpaid && i.details.unpaid_note && (
                    <p className="text-sm">Closed without payment: &ldquo;{i.details.unpaid_note}&rdquo;</p>
                  )}
                  {i.review_note && <p className="text-xs italic text-muted-foreground">Review: {i.review_note}</p>}
                  {!i.reviewed_at && (
                    reviewing === i.id ? (
                      <div className="space-y-2 pt-1">
                        <Select value={outcome} onValueChange={(v) => setOutcome(v as ReviewOutcome)}>
                          <SelectTrigger className="w-56"><SelectValue placeholder="Outcome" /></SelectTrigger>
                          <SelectContent>
                            {REVIEW_OUTCOMES.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
                        <div className="flex gap-2">
                          <Button size="sm" disabled={saving} onClick={() => saveReview(i.id)}>
                            {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Save review
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => { setReviewing(null); setOutcome(""); setNote(""); }}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setReviewing(i.id)}>Review</Button>
                    )
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
