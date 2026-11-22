"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { ChannelRow, TrustLine } from "@/lib/channels-report";

type Row = ChannelRow & { label: string };
interface Report {
  days: number;
  from: string;
  to: string;
  truncated: boolean;
  totals: { enquiries: number; junk: number; won: number };
  rows: Row[];
  trust: TrustLine[];
}

const RANGES = [30, 90, 365] as const;
const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
const tone = {
  good: "border-emerald-200 bg-emerald-50 text-emerald-700",
  bad: "border-red-200 bg-red-50 text-red-700",
  mid: "border-amber-200 bg-amber-50 text-amber-700",
};

function Funnel({ r }: { r: Row }) {
  const steps = [
    { label: "Enquiries", n: r.enquiries },
    { label: "Real (not junk)", n: r.enquiries - r.junk },
    { label: "Reached", n: r.reached },
    { label: "Tour booked", n: r.tours },
    { label: "Proposal", n: r.proposals },
    { label: "Won", n: r.won },
  ];
  return (
    <div className="space-y-1.5 bg-muted/20 px-4 py-3">
      <div className="text-xs font-semibold text-muted-foreground">The journey of {r.label} enquiries</div>
      {steps.map((s) => (
        <div key={s.label} className="flex items-center gap-2 text-sm">
          <span className="w-32 shrink-0 text-muted-foreground">{s.label}</span>
          <div className="h-3 flex-1 rounded bg-muted"><div className="h-3 rounded bg-primary/70" style={{ width: `${r.enquiries ? Math.max(2, (s.n / r.enquiries) * 100) : 0}%` }} /></div>
          <span className="w-16 text-right tabular-nums"><b>{s.n}</b> <span className="text-xs text-muted-foreground">{r.enquiries ? Math.round((s.n / r.enquiries) * 100) : 0}%</span></span>
        </div>
      ))}
    </div>
  );
}

/**
 * Channels: which source sends enquiries that become customers, not just enquiries. One row per
 * source with how far its enquiries got, the first-contact time and the cost per win, a verdict
 * each ("too few to judge" under 10 enquiries), and a trust panel of what to keep in mind. Click a
 * channel to see its journey. Admin and manager only.
 */
export function ChannelsView() {
  const [days, setDays] = useState<number>(30);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/leads/channels?days=${days}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (r.ok) { setReport(j as Report); setError(null); } else setError(j.error ?? "Could not load the report");
      })
      .catch(() => !cancelled && setError("Could not load the report"));
    return () => { cancelled = true; };
  }, [days]);

  if (error) return <p className="py-8 text-sm text-muted-foreground">{error}</p>;
  if (!report) return <p className="py-8 text-sm text-muted-foreground">Loading…</p>;

  const maxEnq = Math.max(1, ...report.rows.map((r) => r.enquiries));
  const { totals } = report;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 basis-72 text-sm text-muted-foreground">Which source sends the best leads, and which sends junk. Volume is not quality: compare enquiry → won and junk together. Won means a contract was activated.</p>
        <div className="flex gap-1.5">
          {RANGES.map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)} className={`rounded-full border px-3 py-1 text-sm ${days === d ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:bg-muted"}`}>
              {d === 365 ? "12 months" : `${d} days`}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border p-3"><div className="text-2xl font-bold">{totals.enquiries}</div><div className="text-xs text-muted-foreground">enquiries</div></div>
        <div className="rounded-lg border p-3"><div className="text-2xl font-bold">{totals.enquiries ? pct(totals.junk / totals.enquiries) : "0%"}</div><div className="text-xs text-muted-foreground">junk ({totals.junk})</div></div>
        <div className="rounded-lg border p-3"><div className="text-2xl font-bold">{totals.won}</div><div className="text-xs text-muted-foreground">won</div></div>
      </div>
      {report.truncated && <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">More enquiries came in than the report reads at once, so the newest are shown. Pick a shorter period for exact numbers.</p>}

      {report.rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No enquiries in this period.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Channel</th><th className="px-2 py-2 font-medium">Enquiries</th><th className="px-2 py-2 font-medium">Junk</th><th className="px-2 py-2 font-medium">Reached</th><th className="px-2 py-2 font-medium">Tours</th><th className="px-2 py-2 font-medium">Won</th><th className="px-2 py-2 font-medium">Win rate</th><th className="px-2 py-2 font-medium">1st contact</th><th className="px-4 py-2 font-medium">Cost / win</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <>
                  <tr key={r.source} onClick={() => setOpen(open === r.source ? null : r.source)} className="cursor-pointer border-b last:border-b-0 hover:bg-muted/30">
                    <td className="px-4 py-2.5">
                      <div className="font-semibold">{r.label}</div>
                      <span className={`mt-0.5 inline-block rounded-full border px-2 py-0.5 text-xs font-semibold ${tone[r.verdict.tone]}`}>{r.verdict.label}</span>
                    </td>
                    <td className="px-2 py-2.5"><div className="h-2 w-24 rounded bg-muted"><div className="h-2 rounded bg-primary" style={{ width: `${Math.max(4, (r.enquiries / maxEnq) * 100)}%` }} /></div><b>{r.enquiries}</b></td>
                    <td className="px-2 py-2.5"><b className={r.junkRate >= 0.3 ? "text-red-700" : ""}>{pct(r.junkRate)}</b><div className="text-xs text-muted-foreground">{r.junk} junk</div></td>
                    <td className="px-2 py-2.5"><b>{r.reached}</b></td>
                    <td className="px-2 py-2.5"><b>{r.tours}</b></td>
                    <td className="px-2 py-2.5"><b>{r.won}</b></td>
                    <td className="px-2 py-2.5"><b>{pct(r.winRate)}</b><div className="text-xs text-muted-foreground">enquiry → won</div></td>
                    <td className="px-2 py-2.5">{r.firstContactMinutes === null ? "—" : `${r.firstContactMinutes} min`}</td>
                    <td className="px-4 py-2.5">{r.costPerWin ? `₹${r.costPerWin.toLocaleString("en-IN")}` : "—"}</td>
                  </tr>
                  {open === r.source && <tr key={`${r.source}-j`}><td colSpan={9} className="border-b p-0"><Funnel r={r} /></td></tr>}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="rounded-lg border">
        <div className="border-b bg-muted/30 px-4 py-2.5"><h2 className="text-sm font-semibold">Before you trust this</h2></div>
        <ul>
          {report.trust.map((t) => (
            <li key={t.label} className="flex items-start gap-2.5 border-b px-4 py-2.5 last:border-b-0">
              {t.tone === "good" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />}
              <div className="text-sm"><b>{t.label}.</b> <span className="text-muted-foreground">{t.detail}</span></div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
