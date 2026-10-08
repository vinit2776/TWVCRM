"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import Link from "next/link";
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
import { formatDate } from "@/lib/utils";
import { latestReference } from "@/hooks/use-enquiry-notifications";

type EnquiryLogRow = {
  id: string;
  first_name: string;
  last_name: string;
  mobile: string | null;
  email: string | null;
  source: string;
  tags: string[] | null;
  created_at: string;
  attention_reset_at: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  resolved_at: string | null;
  resolution_outcome: "converted" | "not_interested" | "no_response" | null;
  claimer: { id: string; full_name: string } | null;
  resolver: { id: string; full_name: string } | null;
  location: { id: string; name: string; code: string } | null;
  enquiries: { reference: string; received_at: string }[] | null;
};

type Summary = {
  total: number;
  unresolved: number;
  converted: number;
  notInterested: number;
  noResponse: number;
};

const SOURCE_LABELS: Record<string, string> = {
  google_ads: "Google Ads",
  meta_ads: "Meta Ads",
  direct_walkin: "Walk-in",
};

const OUTCOME_LABELS: Record<string, string> = {
  converted: "Converted",
  not_interested: "Not interested",
  no_response: "No response",
};

const OUTCOME_CLASS: Record<string, string> = {
  converted: "bg-emerald-100 text-emerald-800",
  not_interested: "bg-slate-100 text-slate-700",
  no_response: "bg-amber-100 text-amber-800",
};

function defaultFromDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

export default function EnquiryLogPage() {
  const [rows, setRows] = useState<EnquiryLogRow[]>([]);
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
      // Newest enquiry activity first — a re-enquiry on an old lead sorts by when it came back in.
      const when = (r: EnquiryLogRow) => new Date(r.attention_reset_at ?? r.created_at).getTime();
      setRows(((json.data ?? []) as EnquiryLogRow[]).sort((a, b) => when(b) - when(a)));
      setSummary(json.summary ?? null);
    }
    setLoading(false);
  }, [source, outcome, from, to, locationId]);

  useEffect(() => {
    load();
  }, [load]);

  const conversionRate = useMemo(() => {
    if (!summary || summary.total === 0) return 0;
    return Math.round((summary.converted / summary.total) * 100);
  }, [summary]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Enquiry Log</h1>
        <p className="text-sm text-muted-foreground">
          Campaign attribution and historical record of every enquiry from the public forms.
        </p>
      </div>

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

      {/* Table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">When</th>
                <th className="px-3 py-2 text-left">Reference</th>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Mobile</th>
                <th className="px-3 py-2 text-left">Source</th>
                <th className="px-3 py-2 text-left">Outcome</th>
                <th className="px-3 py-2 text-left">Resolved by</th>
                <th className="px-3 py-2 text-left">Resolved at</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">No enquiries match these filters.</td></tr>
              )}
              {!loading &&
                rows.map((row) => {
                  const isReEnquiry =
                    row.attention_reset_at &&
                    new Date(row.attention_reset_at).getTime() - new Date(row.created_at).getTime() > 1000;
                  return (
                    <tr key={row.id} className="border-t hover:bg-muted/30">
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                        {formatDate(isReEnquiry && row.attention_reset_at ? row.attention_reset_at : row.created_at)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                        {latestReference(row.enquiries) ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        <Link href={`/leads/${row.id}`} className="font-medium hover:underline">
                          {row.first_name} {row.last_name}
                        </Link>
                        {isReEnquiry && (
                          <span className="ml-1.5 inline-block rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                            Re-enquiry
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">{row.mobile ? `+91 ${row.mobile}` : "—"}</td>
                      <td className="px-3 py-2 text-xs">{SOURCE_LABELS[row.source] ?? row.source}</td>
                      <td className="px-3 py-2">
                        {row.resolution_outcome ? (
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${OUTCOME_CLASS[row.resolution_outcome]}`}>
                            {OUTCOME_LABELS[row.resolution_outcome]}
                          </span>
                        ) : (
                          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-800">
                            Unresolved
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">{row.resolver?.full_name ?? "—"}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {row.resolved_at ? formatDate(row.resolved_at) : "—"}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        {!loading && rows.length >= 200 && (
          <div className="border-t bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Showing first 200 results. Narrow the date range or filter by source to see older entries.
          </div>
        )}
      </Card>
    </div>
  );
}
