"use client";

import { Check, Minus, Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AMC_STEPS, type AmcStep } from "@/lib/procurement/amc-wizard-steps";
import type { CyclePeriod } from "@/lib/procurement/amc-running";
import { formatCurrency, formatDate } from "@/lib/utils";

/** Where the user is in the new-AMC request, what is being asked, and why. */
export function AmcStepHeader({ step, steps = AMC_STEPS }: { step: number; steps?: readonly AmcStep[] }) {
  const s = steps[step];
  return (
    <div className="space-y-3" aria-live="polite">
      <ol className="flex flex-wrap items-center gap-1.5 text-xs">
        {steps.map((st, i) => (
          <li
            key={st.key}
            aria-current={i === step ? "step" : undefined}
            className={`flex items-center gap-1 rounded-full px-2.5 py-1 ${
              i < step ? "bg-green-100 text-green-800" : i === step ? "bg-primary text-primary-foreground font-semibold" : "bg-muted text-muted-foreground"
            }`}
          >
            {i < step ? <Check className="h-3 w-3" /> : <span>{i + 1}</span>}
            <span className="hidden sm:inline">{st.key === "who" ? "Company" : st.key === "contract" ? "Contract" : st.key === "billing" ? "Cost" : st.key === "running" ? "Progress" : st.key === "contacts" ? "Contacts" : st.key === "proposal" ? "Proposal" : "Review"}</span>
          </li>
        ))}
      </ol>
      <div>
        <p className="text-xs text-muted-foreground">Step {step + 1} of {steps.length}</p>
        <h2 className="text-lg font-semibold">{s.title}</h2>
        <p className="text-sm text-muted-foreground">{s.why}</p>
      </div>
    </div>
  );
}

export interface AmcReviewLine {
  asset: string;
  frequency: string;
  count: number;
  perCycle: number;
  total: number;
}

export interface AmcReviewProps {
  company: string;
  contractName: string;
  coverage: string;
  start: string;
  end: string;
  length: string | null;
  visits: string;
  lines: AmcReviewLine[];
  total: number;
  /** Set when the contract was already running: the whole contract and what is already settled. */
  running?: { fullTotal: number; paidTotal: number; cyclesDone: number; cyclesTotal: number; visitsDone: number };
  contact: string;
  advance: string | null;
  proposals: number;
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="flex justify-between gap-4 px-3 py-2 text-sm">
    <dt className="text-muted-foreground shrink-0">{k}</dt>
    <dd className="font-medium text-right">{v}</dd>
  </div>
);

/** One plain read-through of everything before it is sent. Nothing here is editable. */
export function AmcReviewCard(p: AmcReviewProps) {
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-base">Your AMC request</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <dl className="rounded-lg border divide-y">
          <Row k="Company" v={p.company} />
          <Row k="Contract" v={p.contractName} />
          <Row k="Covers" v={p.coverage} />
          <Row k="Period" v={`${formatDate(p.start)} – ${formatDate(p.end)}${p.length ? ` · ${p.length}` : ""}`} />
          <Row k="Visits" v={p.visits} />
          <Row k="Vendor contact" v={p.contact} />
          {p.advance && <Row k="Advance asked for" v={p.advance} />}
          <Row k="Proposal attached" v={p.proposals > 0 ? `${p.proposals} file${p.proposals > 1 ? "s" : ""}` : "None. You can add it later."} />
        </dl>
        <div className="rounded-lg border">
          <div className="grid grid-cols-4 gap-2 bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="col-span-2">Asset</span><span className="text-right">Each bill</span><span className="text-right">{p.running ? "To approve" : "Total"}</span>
          </div>
          {p.lines.map((l, i) => (
            <div key={i} className="grid grid-cols-4 gap-2 border-t px-3 py-2 text-sm">
              <span className="col-span-2">{l.asset}<span className="block text-xs text-muted-foreground">{l.count} × {l.frequency}</span></span>
              <span className="text-right">{formatCurrency(l.perCycle)}</span>
              <span className="text-right font-medium">{formatCurrency(l.total)}</span>
            </div>
          ))}
          {p.running && (
            <>
              <div className="flex justify-between border-t px-3 py-2 text-sm">
                <span className="text-muted-foreground">Full contract value</span><span>{formatCurrency(p.running.fullTotal)}</span>
              </div>
              <div className="flex justify-between border-t px-3 py-2 text-sm">
                <span className="text-muted-foreground">
                  Already paid ({p.running.cyclesDone} of {p.running.cyclesTotal} cycles, before this system)
                </span>
                <span>− {formatCurrency(p.running.paidTotal)}</span>
              </div>
            </>
          )}
          <div className="flex justify-between border-t px-3 py-2 text-sm font-semibold">
            <span>{p.running ? "Total to approve, before GST" : "Total before GST"}</span><span>{formatCurrency(p.total)}</span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          What happens next: your approver reviews this. Once approved, a purchase order is made for each asset and the vendor&apos;s bills are matched to the schedule above.
        </p>
      </CardContent>
    </Card>
  );
}

/** Shown once the start date is in the past, so nobody is surprised by the extra step. */
export function AmcRunningNotice({ startDate }: { startDate: string }) {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
      <p className="font-medium">This contract started on {formatDate(startDate)}, so it is already running.</p>
      <p className="text-xs mt-0.5">
        After the cost step we will ask which cycles are already paid, so you are not asked to approve or pay them again.
      </p>
    </div>
  );
}

export interface AmcRunningStepProps {
  schedule: CyclePeriod[];
  unit: string;
  /** Sum of every asset's bill for one cycle, before GST. */
  perCycleTotal: number;
  opening: number;
  maxSettled: number;
  onOpening: (n: number) => void;
  visits: number;
  /** Visits the contract covers, or null for unlimited. */
  visitsCovered: number | null;
  onVisits: (n: number) => void;
  today: string;
}

/** Cycles are ticked in order, so a gap can never be left in the schedule. */
export function AmcRunningStep(p: AmcRunningStepProps) {
  const Unit = p.unit.charAt(0).toUpperCase() + p.unit.slice(1);
  const total = p.schedule.length;
  const startsAt = p.opening + 1;
  const toggle = (n: number) => {
    if (n > p.maxSettled) return;
    // Ticking cycle n settles 1..n; un-ticking the last ticked one steps back.
    const next = n === p.opening ? n - 1 : n;
    p.onOpening(next);
    // A cycle that is billed and paid has been serviced, so its share of the visits is done too.
    // The count below stays adjustable for a contract whose visits did not fall evenly.
    if (p.visitsCovered != null && total > 0) p.onVisits(Math.round((p.visitsCovered * next) / total));
  };
  return (
    <Card>
      <CardContent className="space-y-5 pt-5">
        <div>
          <p className="text-sm font-medium">Which cycles are already billed and paid?</p>
          <p className="text-xs text-muted-foreground">
            Tick a cycle if it has already been serviced, invoiced by the vendor and paid by you, outside this system. Its share of the visits is counted as done. Leave all unticked if none has been paid yet.
          </p>
        </div>
        <div className="rounded-lg border divide-y">
          {p.schedule.map((c) => {
            const done = c.n <= p.opening;
            const locked = c.n > p.maxSettled;
            return (
              <label
                key={c.n}
                className={`flex items-center gap-3 px-3 py-2.5 text-sm ${locked ? "opacity-60" : "cursor-pointer"} ${done ? "bg-muted/40" : ""}`}
              >
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={done}
                  disabled={locked}
                  onChange={() => toggle(c.n)}
                />
                <span className="flex-1">
                  <span className="font-medium">{Unit} {c.n} of {total}</span>
                  {c.n === startsAt && <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[11px] font-medium text-blue-800">we start here</span>}
                  <span className="block text-xs text-muted-foreground">{formatDate(c.from)} – {formatDate(c.to)}</span>
                  {done && <span className="block text-[11px] font-medium text-green-700">Serviced · Invoiced · Paid</span>}
                </span>
                <span className="text-right">
                  {formatCurrency(p.perCycleTotal)}
                  {locked && <span className="block text-[11px] text-muted-foreground">{c.to >= p.today ? "not finished yet" : "must be billed here"}</span>}
                </span>
              </label>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Cycles are ticked in order. The cycle that is running now, and later ones, cannot be marked as paid.
        </p>

        <div>
          <p className="text-sm font-medium">
            How many{p.visitsCovered ? ` of the ${p.visitsCovered}` : ""} visits are already done?
          </p>
          {p.opening > 0 && p.visitsCovered != null && (
            <p className="text-xs text-muted-foreground">Filled in from the cycles you ticked. Change it if the vendor made a different number of visits.</p>
          )}
          <div className="mt-2 flex items-center gap-3">
            <button type="button" aria-label="One fewer visit" className="h-8 w-8 rounded-md border flex items-center justify-center disabled:opacity-40"
              disabled={p.visits <= 0} onClick={() => p.onVisits(p.visits - 1)}><Minus className="h-4 w-4" /></button>
            <span className="w-8 text-center text-lg font-semibold">{p.visits}</span>
            <button type="button" aria-label="One more visit" className="h-8 w-8 rounded-md border flex items-center justify-center disabled:opacity-40"
              disabled={p.visitsCovered != null && p.visits >= p.visitsCovered} onClick={() => p.onVisits(p.visits + 1)}><Plus className="h-4 w-4" /></button>
            {p.visitsCovered != null && <span className="text-sm text-muted-foreground">of {p.visitsCovered} this year</span>}
          </div>
        </div>

        <div className="rounded-lg bg-blue-50 px-3 py-2.5 text-sm text-blue-900">
          We will start this contract at <strong>{p.unit} {startsAt} of {total}</strong>
          {p.visitsCovered != null ? <>, with <strong>{p.visits} of {p.visitsCovered} visits</strong> used.</> : <>, with <strong>{p.visits}</strong> visits already done.</>}
        </div>
      </CardContent>
    </Card>
  );
}
