"use client";

import { Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AMC_STEPS } from "@/lib/procurement/amc-wizard-steps";
import { formatCurrency, formatDate } from "@/lib/utils";

/** Where the user is in the new-AMC request, what is being asked, and why. */
export function AmcStepHeader({ step }: { step: number }) {
  const s = AMC_STEPS[step];
  return (
    <div className="space-y-3" aria-live="polite">
      <ol className="flex flex-wrap items-center gap-1.5 text-xs">
        {AMC_STEPS.map((st, i) => (
          <li
            key={st.key}
            aria-current={i === step ? "step" : undefined}
            className={`flex items-center gap-1 rounded-full px-2.5 py-1 ${
              i < step ? "bg-green-100 text-green-800" : i === step ? "bg-primary text-primary-foreground font-semibold" : "bg-muted text-muted-foreground"
            }`}
          >
            {i < step ? <Check className="h-3 w-3" /> : <span>{i + 1}</span>}
            <span className="hidden sm:inline">{st.key === "who" ? "Company" : st.key === "contract" ? "Contract" : st.key === "billing" ? "Cost" : st.key === "contacts" ? "Contacts" : st.key === "proposal" ? "Proposal" : "Review"}</span>
          </li>
        ))}
      </ol>
      <div>
        <p className="text-xs text-muted-foreground">Step {step + 1} of {AMC_STEPS.length}</p>
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
            <span className="col-span-2">Asset</span><span className="text-right">Each bill</span><span className="text-right">Total</span>
          </div>
          {p.lines.map((l, i) => (
            <div key={i} className="grid grid-cols-4 gap-2 border-t px-3 py-2 text-sm">
              <span className="col-span-2">{l.asset}<span className="block text-xs text-muted-foreground">{l.count} × {l.frequency}</span></span>
              <span className="text-right">{formatCurrency(l.perCycle)}</span>
              <span className="text-right font-medium">{formatCurrency(l.total)}</span>
            </div>
          ))}
          <div className="flex justify-between border-t px-3 py-2 text-sm font-semibold">
            <span>Total before GST</span><span>{formatCurrency(p.total)}</span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          What happens next: your approver reviews this. Once approved, a purchase order is made for each asset and the vendor&apos;s bills are matched to the schedule above.
        </p>
      </CardContent>
    </Card>
  );
}
