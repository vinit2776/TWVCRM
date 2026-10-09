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
import {
  ENQUIRY_SOURCE_LABEL,
  enquiryOutcomeLabel,
  enquiryStateLabel,
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
};

const OUTCOME_CLASS: Record<string, string> = {
  converted: "bg-emerald-100 text-emerald-800",
  not_interested: "bg-slate-100 text-slate-700",
  no_response: "bg-amber-100 text-amber-800",
  superseded: "bg-slate-50 text-slate-500 border border-dashed border-slate-300",
};

function defaultFromDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

export default function EnquiryLogPage() {
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
                <th className="px-3 py-2 text-left">Status</th>
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
                rows.map((row) => (
                  <tr key={row.enquiryId} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                      {formatDate(row.attentionResetAt)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{row.reference}</td>
                    <td className="px-3 py-2">
                      <Link href={`/leads/${row.leadId}`} className="font-medium hover:underline">
                        {row.name}
                      </Link>
                      {row.isReEnquiry && (
                        <span className="ml-1.5 inline-block rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                          Re-enquiry
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{row.mobile ? `+91 ${row.mobile}` : "—"}</td>
                    <td className="px-3 py-2 text-xs">{ENQUIRY_SOURCE_LABEL[row.sourceTag] ?? row.source}</td>
                    <td className="px-3 py-2">
                      {row.resolutionOutcome ? (
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${OUTCOME_CLASS[row.resolutionOutcome]}`}>
                          {enquiryOutcomeLabel(row.resolutionOutcome)}
                        </span>
                      ) : (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            row.claimedAt ? "bg-blue-100 text-blue-800" : "bg-red-100 text-red-800"
                          }`}
                        >
                          {row.resolvedAt ? "Resolved" : enquiryStateLabel(row)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {row.resolutionOutcome === "superseded" ? "—" : (row.resolverName ?? "—")}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {row.resolvedAt ? formatDate(row.resolvedAt) : "—"}
                    </td>
                  </tr>
                ))}
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
