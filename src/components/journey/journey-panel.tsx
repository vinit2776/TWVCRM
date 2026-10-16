"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Check, ChevronDown, ChevronUp, Lock, PartyPopper } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import type { Journey, JourneyOwner, JourneyStep } from "@/lib/journey/types";

interface Props {
  leadId: string;
  proposalId?: string | null;
  contractId?: string | null;
}

const OWNER_LABEL: Record<JourneyOwner, string> = {
  sales: "Sales",
  accounts: "Accounts",
  admin: "Admin",
  manager: "Manager",
  ops: "Operations",
  it: "IT",
};

function StepDot({ state }: { state: JourneyStep["state"] }) {
  if (state === "done") {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-700">
        <Check className="h-3 w-3" />
      </span>
    );
  }
  if (state === "current") {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-blue-600 bg-blue-50 text-blue-700">
        <ArrowRight className="h-3 w-3" />
      </span>
    );
  }
  if (state === "blocked") {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
        <Lock className="h-3 w-3" />
      </span>
    );
  }
  return <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full border border-dashed border-muted-foreground/40" />;
}

export function JourneyPanel({ leadId, proposalId, contractId }: Props) {
  const [journey, setJourney] = useState<Journey | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (proposalId) qs.set("proposal_id", proposalId);
    if (contractId) qs.set("contract_id", contractId);
    try {
      const res = await fetch(`/api/leads/${leadId}/journey${qs.size ? `?${qs}` : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`journey ${res.status}`);
      const json = (await res.json()) as { data: Journey };
      setJourney(json.data);
      setFailed(false);
    } catch (err) {
      console.error("[journey] load failed", err);
      setFailed(true);
    }
  }, [leadId, proposalId, contractId]);

  useEffect(() => {
    load();
    // Refresh when the user comes back from doing the step in another screen.
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const [busy, setBusy] = useState(false);

  const markWelcomeDone = useCallback(
    async (cid: string) => {
      setBusy(true);
      try {
        const res = await fetch(`/api/contracts/${cid}/welcome-done`, { method: "POST" });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || "Couldn't mark welcome done");
        toast.success("Marked as welcomed");
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't mark welcome done");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  // A broken progress hint must never get in the way of the page it sits on.
  if (failed || !journey) return null;

  const next = journey.nextStep;

  return (
    <Card className="mb-4 p-4" data-testid="journey-panel">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium">
          Customer journey
          <span className="ml-2 font-normal text-muted-foreground">
            {journey.requiredDone} of {journey.requiredTotal} steps
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Hide steps" : "Show all steps"}
          {open ? <ChevronUp className="ml-1 h-4 w-4" /> : <ChevronDown className="ml-1 h-4 w-4" />}
        </Button>
      </div>

      <div className="mt-3 flex gap-1" aria-hidden="true">
        {journey.phases.map((p) => (
          <div
            key={p.key}
            title={`${p.title}: ${p.requiredDone} of ${p.requiredTotal}`}
            className={`h-1.5 flex-1 rounded-full ${
              p.complete ? "bg-green-500" : p.requiredDone > 0 || next?.phase === p.key ? "bg-blue-500" : "bg-muted"
            }`}
          />
        ))}
      </div>

      {journey.complete ? (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          <PartyPopper className="h-4 w-4" />
          All set. Every step is done and this customer is fully onboarded.
        </div>
      ) : (
        next && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-blue-200 bg-blue-50/50 px-3 py-2">
            <div className="min-w-0">
              <div className="text-xs text-blue-700">
                {next.state === "blocked" ? "Waiting on" : "Next step"} · for {OWNER_LABEL[next.owner]}
              </div>
              <div className="text-sm font-medium">{next.label}</div>
              {next.hint && <div className="text-xs text-muted-foreground">{next.hint}</div>}
            </div>
            {next.action === "mark_welcome_done" && journey.contractId && next.state !== "blocked" && (
              <Button size="sm" disabled={busy} onClick={() => markWelcomeDone(journey.contractId!)}>
                {busy ? "Saving…" : next.ctaLabel}
              </Button>
            )}
            {!next.action && next.href && next.state !== "blocked" && (
              <Button asChild size="sm">
                <Link href={next.href}>
                  {next.ctaLabel ?? "Open"}
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Link>
              </Button>
            )}
          </div>
        )
      )}

      {journey.warnings.map((w) => (
        <div key={w} className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {w}
        </div>
      ))}

      {open && (
        <div className="mt-4 space-y-3">
          {journey.phases.map((phase) => (
            <div key={phase.key} className="rounded-md border">
              <div className="flex items-center justify-between px-3 py-2 text-sm font-medium">
                {phase.title}
                <span className={`text-xs font-normal ${phase.complete ? "text-green-700" : "text-muted-foreground"}`}>
                  {phase.complete ? "Done" : `${phase.requiredDone} of ${phase.requiredTotal}`}
                </span>
              </div>
              {phase.steps.map((s) => (
                <div key={s.key} className="flex items-start gap-3 border-t px-3 py-2 text-sm">
                  <StepDot state={s.state} />
                  <div className="min-w-0 flex-1">
                    <div className={s.state === "done" || s.state === "current" ? "" : "text-muted-foreground"}>
                      {s.label}
                      {s.detail && <span className="ml-2 text-xs text-muted-foreground">{s.detail}</span>}
                      <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        {OWNER_LABEL[s.owner]}
                      </span>
                      {s.state === "optional" && (
                        <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">optional</span>
                      )}
                    </div>
                    {s.state !== "done" && s.hint && <div className="text-xs text-muted-foreground">{s.hint}</div>}
                  </div>
                  {s.action === "mark_welcome_done" && journey.contractId && s.state !== "done" && s.state !== "blocked" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => markWelcomeDone(journey.contractId!)}
                      className="shrink-0 text-xs text-blue-700 hover:underline disabled:opacity-50"
                    >
                      {s.ctaLabel}
                    </button>
                  )}
                  {!s.action && s.href && s.state !== "done" && s.state !== "blocked" && (
                    <Link href={s.href} className="shrink-0 text-xs text-blue-700 hover:underline">
                      {s.ctaLabel ?? "Open"}
                    </Link>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
