"use client";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatCurrency } from "@/lib/utils";
import { ROOM_TYPE_LABELS, type CenterDetail } from "./types";

const AGING_BUCKETS: Array<{ key: keyof CenterDetail["aging"]; label: string; color: string }> = [
  { key: "not_due", label: "Not due", color: "bg-blue-500" },
  { key: "d1_15", label: "1–15 days", color: "bg-emerald-500" },
  { key: "d16_30", label: "16–30 days", color: "bg-amber-500" },
  { key: "d31_45", label: "31–45 days", color: "bg-orange-500" },
  { key: "d45_plus", label: "45+ days", color: "bg-red-600" },
];

export function DetailSheet({
  detail,
  loading,
  open,
  onOpenChange,
}: {
  detail: CenterDetail | null;
  loading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{detail?.location.name ?? "Loading…"}</SheetTitle>
        </SheetHeader>

        {loading && <p className="mt-6 text-sm text-muted-foreground">Loading center detail…</p>}

        {detail && !loading && (
          <div className="mt-6 space-y-8">
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Sales pipeline (selected period)
              </h3>
              <div className="grid grid-cols-3 gap-2">
                <MiniStat value={detail.pipeline.active_leads} label="Active leads" />
                <MiniStat value={detail.pipeline.proposals_sent} label="Proposals sent" />
                <MiniStat value={detail.pipeline.contracts_signed} label="Contracts signed" />
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Receivables aging (as of today)
              </h3>
              <AgingBar aging={detail.aging} />
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Occupancy by room type (as of today)
              </h3>
              <div className="space-y-2.5">
                {detail.rooms.map((r) => {
                  const pct = r.capacity > 0 ? Math.round((r.occupied / r.capacity) * 100) : 0;
                  return (
                    <div key={r.type} className="flex items-center gap-3 text-sm">
                      <span className="w-32 shrink-0 text-muted-foreground">{ROOM_TYPE_LABELS[r.type] ?? r.type}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-blue-100">
                        <div className="h-full rounded-full bg-blue-600" style={{ width: `${Math.min(100, pct)}%` }} />
                      </div>
                      <span className="w-14 shrink-0 text-right text-muted-foreground">{r.occupied}/{r.capacity}</span>
                    </div>
                  );
                })}
                {detail.rooms.length === 0 && (
                  <p className="text-sm text-muted-foreground">No active spaces at this center.</p>
                )}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Top clients by billing (selected period)
              </h3>
              {detail.top_clients.length === 0 ? (
                <p className="text-sm text-muted-foreground">No billing in the selected period.</p>
              ) : (
                <ul className="divide-y">
                  {detail.top_clients.map((c) => (
                    <li key={c.lead_id} className="flex items-center justify-between py-2 text-sm">
                      <span>{c.name}</span>
                      <span className="font-semibold">{formatCurrency(c.billed)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function MiniStat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg bg-muted/50 p-3">
      <div className="text-lg font-bold">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function AgingBar({ aging }: { aging: CenterDetail["aging"] }) {
  const total = AGING_BUCKETS.reduce((s, b) => s + aging[b.key], 0);
  if (total === 0) {
    return <p className="text-sm text-muted-foreground">No outstanding balances.</p>;
  }
  return (
    <div className="space-y-2">
      <div className="flex h-5 overflow-hidden rounded-md">
        {AGING_BUCKETS.map((b) => {
          const amount = aging[b.key];
          if (amount <= 0) return null;
          return <div key={b.key} className={b.color} style={{ width: `${(amount / total) * 100}%` }} title={b.label} />;
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {AGING_BUCKETS.map((b) => (
          <span key={b.key} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-sm ${b.color}`} />
            {b.label}: {formatCurrency(aging[b.key])}
          </span>
        ))}
      </div>
    </div>
  );
}
