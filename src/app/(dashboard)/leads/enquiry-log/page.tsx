"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LocationSelector } from "@/components/shared/location-selector";
import { useCurrentUser } from "@/providers/current-user-provider";
import { EnquiryLogRow } from "@/components/enquiries/enquiry-log-row";
import { PossibleLeadsTray } from "@/components/enquiries/possible-leads-tray";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";
import {
  toEnquiryItem,
  type EnquiryItem,
  type RawEnquiryRow,
} from "@/lib/enquiries";

type Summary = {
  total: number;
  unresolved: number;
  converted: number;
  notInterested: number;
  noResponse: number;
  superseded: number;
  spam?: number;
};

function defaultFromDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

export default function EnquiryLogPage() {
  const { user } = useCurrentUser();
  // Read-only role: names aren't links into the lead record and there's no mobile column.
  const readOnly = user?.role === ENQUIRY_VIEWER_ROLE;
  const [rows, setRows] = useState<EnquiryItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);

  const [source, setSource] = useState<string>("");
  const [outcome, setOutcome] = useState<string>("");
  const [from, setFrom] = useState<string>(defaultFromDate());
  const [to, setTo] = useState<string>("");
  const [locationId, setLocationId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const sp = new URLSearchParams();
    if (source) sp.set("source", source);
    if (outcome) sp.set("outcome", outcome);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);
    if (locationId) sp.set("location_id", locationId);
    const res = await fetch(`/api/leads/enquiry-log?${sp}`);
    if (res.ok) {
      const json = await res.json();
      setRows(
        ((json.data ?? []) as RawEnquiryRow[])
          .map(toEnquiryItem)
          .filter((i): i is EnquiryItem => i !== null)
      );
      setSummary(json.summary ?? null);
    }
    setLoading(false);
  }, [source, outcome, from, to, locationId]);

  useEffect(() => {
    load();
  }, [load]);

  const conversionRate = useMemo(() => {
    // Share of enquiries that reached a real outcome; superseded history has none.
    if (!summary) return 0;
    const decided = summary.converted + summary.notInterested + summary.noResponse;
    return decided === 0 ? 0 : Math.round((summary.converted / decided) * 100);
  }, [summary]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Enquiry Log</h1>
        <p className="text-sm text-muted-foreground">
          Campaign attribution and historical record of every enquiry from the public forms.
        </p>
      </div>

      {!readOnly && <PossibleLeadsTray onChanged={load} />}

      {/* Summary tiles */}
      {summary && (
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
          <Card className="p-3">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-xl font-semibold">{summary.total}</p>
          </Card>
          <Card className="p-3 border-red-200">
            <p className="text-xs text-muted-foreground">Unresolved</p>
            <p className="text-xl font-semibold text-red-700">{summary.unresolved}</p>
          </Card>
          <Card className="p-3 border-emerald-200">
            <p className="text-xs text-muted-foreground">Converted</p>
            <p className="text-xl font-semibold text-emerald-700">
              {summary.converted} <span className="text-xs text-muted-foreground">({conversionRate}%)</span>
            </p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-muted-foreground">Not interested</p>
            <p className="text-xl font-semibold text-slate-700">{summary.notInterested}</p>
          </Card>
          <Card className="p-3 border-amber-200">
            <p className="text-xs text-muted-foreground">No response</p>
            <p className="text-xl font-semibold text-amber-700">{summary.noResponse}</p>
            {summary.superseded > 0 && (
              <p className="text-[10px] text-muted-foreground">+ {summary.superseded} superseded</p>
            )}
          </Card>
        </div>
      )}

      {/* Filters */}
      <Card className="p-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Source</label>
            <Select value={source || "all"} onValueChange={(v) => setSource(v === "all" ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="All sources" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                <SelectItem value="google_ads">Google Ads</SelectItem>
                <SelectItem value="meta_ads">Meta Ads</SelectItem>
                <SelectItem value="direct_walkin">Walk-in</SelectItem>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Outcome</label>
            <Select value={outcome || "all"} onValueChange={(v) => setOutcome(v === "all" ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="All outcomes" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All outcomes</SelectItem>
                <SelectItem value="unresolved">Unresolved (still in queue)</SelectItem>
                <SelectItem value="converted">Converted</SelectItem>
                <SelectItem value="not_interested">Not interested</SelectItem>
                <SelectItem value="no_response">No response</SelectItem>
                <SelectItem value="superseded">Superseded</SelectItem>
                <SelectItem value="spam">Spam{summary?.spam ? ` (${summary.spam})` : ""}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">From</label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">To</label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Location</label>
            <LocationSelector value={locationId} onValueChange={setLocationId} />
          </div>
        </div>
      </Card>

      {/* Rows: one line each; click a row for the conversation and every action */}
      <Card className="overflow-hidden">
        {loading && <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>}
        {!loading && rows.length === 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">No enquiries match these filters.</p>
        )}
        {!loading && rows.map((row) => <EnquiryLogRow key={row.enquiryId} row={row} readOnly={readOnly} onChanged={load} />)}
        {!loading && rows.length >= 200 && (
          <div className="border-t bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Showing first 200 results. Narrow the date range or filter by source to see older entries.
          </div>
        )}
      </Card>
    </div>
  );
}
