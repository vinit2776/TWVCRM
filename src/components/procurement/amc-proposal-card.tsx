"use client";

import { useMemo, useRef, useState } from "react";
import { FileUp, Loader2, ScanSearch } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EXTRACTION_MEDIA_TYPES } from "@/lib/procurement/proposal-extraction";
import type { ExtractedAmcProposal } from "@/lib/procurement/proposal-extraction";
import { requestProposalExtraction } from "@/lib/procurement/proposal-extract-client";
import { planAmcPrefill, type PrefillCurrent, type PrefillPlan } from "@/lib/procurement/amc-prefill";

const MAX_BYTES = 10 * 1024 * 1024;

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ok"; extracted: ExtractedAmcProposal }
  | { status: "applied"; count: number };

interface Props {
  current: PrefillCurrent;
  /** Called when the user confirms. The wizard fills its fields and keeps the file as the proposal. */
  onApply: (plan: PrefillPlan, file: File, extracted: ExtractedAmcProposal, chosenValue: number | undefined) => number;
}

/**
 * Optional first step: read the vendor's proposal and fill in what it says. Nothing changes
 * until the user presses the button, and the next steps still show every value for checking.
 */
export function AmcProposalCard({ current, onApply }: Props) {
  const [state, setState] = useState<State>({ status: "idle" });
  const [file, setFile] = useState<File | null>(null);
  const [chosen, setChosen] = useState<number | undefined>(undefined);
  const seq = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  const extracted = state.status === "ok" ? state.extracted : null;
  const plan = useMemo(() => (extracted ? planAmcPrefill(extracted, current, chosen) : null), [extracted, current, chosen]);

  const pick = (f: File | null) => {
    if (!f) return;
    if (f.size > MAX_BYTES) { toast.error("That file is over 10 MB. Try a smaller copy."); return; }
    if (!(EXTRACTION_MEDIA_TYPES as readonly string[]).includes(f.type)) { toast.error("Upload a PDF, JPG, PNG or WebP of the proposal."); return; }
    const mine = ++seq.current;
    setFile(f);
    setChosen(undefined);
    setState({ status: "loading" });
    requestProposalExtraction(f).then((x) => {
      if (mine !== seq.current) return;
      setState(x ? { status: "ok", extracted: x } : { status: "unavailable" });
    });
  };

  const reset = () => {
    seq.current++;
    setFile(null);
    setChosen(undefined);
    setState({ status: "idle" });
    if (input.current) input.current.value = "";
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2"><ScanSearch className="h-4 w-4" /> Have the vendor&apos;s proposal?</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {state.status === "applied" ? (
          <div className="space-y-2">
            <p className="text-sm text-green-800 bg-green-50 border border-green-200 rounded px-3 py-2">
              Filled in {state.count} detail{state.count === 1 ? "" : "s"} from the proposal, and attached it. Check each step as you go.
            </p>
            <Button variant="ghost" size="sm" onClick={reset}>Use a different proposal</Button>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Upload it and we&apos;ll read the dates, billing, visits and cost for you. You check everything before it is used. No proposal? Skip this and type it in on the next steps.
            </p>
            <input
              ref={input}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*"
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
            />
          </>
        )}

        {state.status === "loading" && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Reading the proposal… this takes about 15 seconds.</p>
        )}

        {state.status === "unavailable" && (
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            We couldn&apos;t read that file. You can still type everything in on the next steps, and attach the proposal in step 5.
          </p>
        )}

        {plan && file && extracted && (
          <div className="space-y-3">
            {extracted.confidence === "low" && (
              <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">It was hard to read. Double-check every figure.</p>
            )}
            <dl className="rounded-lg border divide-y text-sm">
              {plan.found.length === 0 && <div className="px-3 py-2 text-muted-foreground">Nothing we could use was found.</div>}
              {plan.found.map((f) => (
                <div key={f.label} className="flex justify-between gap-4 px-3 py-2">
                  <dt className="text-muted-foreground shrink-0">{f.label}</dt>
                  <dd className="font-medium text-right">{f.value}</dd>
                </div>
              ))}
            </dl>
            {plan.questions.map((q) => (
              <div key={q.id} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 space-y-2">
                <p className="text-sm font-medium text-amber-900">{q.prompt}</p>
                <div className="flex flex-wrap gap-2">
                  {q.options.map((o) => (
                    <Button key={o.value} size="sm" variant={chosen === o.value ? "default" : "outline"} onClick={() => setChosen(o.value)}>{o.label}</Button>
                  ))}
                </div>
              </div>
            ))}
            {plan.notes.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
                {plan.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={plan.questions.length > 0 || plan.found.length === 0}
                onClick={() => {
                  const count = onApply(plan, file, extracted, chosen);
                  setState({ status: "applied", count });
                }}
              >
                <FileUp className="h-4 w-4 mr-1" /> Fill in the steps for me
              </Button>
              <Button variant="outline" onClick={reset}>Don&apos;t use it</Button>
            </div>
            {plan.questions.length > 0 && <p className="text-xs text-muted-foreground">Answer the question above to continue.</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
