"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, PauseCircle, PlayCircle, Repeat, SlidersHorizontal, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency, formatDate } from "@/lib/utils";
import { AUTO_RENEW_MANAGE_ROLES } from "@/lib/auto-renewal";
import { PLAN_STAGE_LABELS, type PlanStage } from "@/lib/auto-renewal-plan";

interface CardData {
  autoRenew: boolean;
  mode: string;
  live: boolean;
  stoppedAt: string | null;
  stopReason: string | null;
  paused: boolean;
  programmedPct: number;
  revised: { percentage: number; reason: string | null; at: string | null } | null;
  plan: {
    stage: PlanStage;
    holds: { code: string; label: string }[];
    schedule: {
      draftOn: string;
      noticeOn: string;
      noticeDeadline: string;
      confirmationOn: string | null;
    };
    rollOn: string;
    next: { label: string; on: string } | null;
    nextRent: number;
    nextRentPct: number;
    nextRentIsDraft: boolean;
  } | null;
}

interface Props {
  contractId: string;
  contractNumber: string;
  endDate: string;
  userRole: string | null;
  /** Opens the page's existing "Start exit" dialog: a customer's notice is the exit process, not a second one. */
  onStartExit: () => void;
  exitInProgress: boolean;
}

async function post(contractId: string, body: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await fetch(`/api/contracts/${contractId}/auto-renewal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const err = await res.json().catch(() => null);
    return err?.error || "Something went wrong";
  } catch {
    return "Network error. Please try again.";
  }
}

export function ContractAutoRenewalCard({ contractId, contractNumber, endDate, userRole, onStartExit, exitInProgress }: Props) {
  const [data, setData] = useState<CardData | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [pct, setPct] = useState("");
  const [reason, setReason] = useState("");

  const canManage = (AUTO_RENEW_MANAGE_ROLES as readonly string[]).includes(userRole ?? "");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/contracts/${contractId}/auto-renewal`);
      if (!res.ok) {
        setHidden(true);
        return;
      }
      const json = await res.json();
      if (!json.data) setHidden(true);
      else setData(json.data as CardData);
    } catch {
      setHidden(true);
    }
  }, [contractId]);

  useEffect(() => {
    load();
  }, [load]);

  if (hidden || !data) return null;

  const run = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    const error = await post(contractId, body);
    setBusy(false);
    if (error) {
      toast.error(error);
      return false;
    }
    toast.success(ok);
    await load();
    return true;
  };

  const openRevise = () => {
    setPct(String(data.revised?.percentage ?? data.programmedPct));
    setReason("");
    setReviseOpen(true);
  };

  const pctNumber = Number(pct);
  const pctValid = pct.trim() !== "" && Number.isFinite(pctNumber) && pctNumber >= 0 && pctNumber <= 100;
  const below = pctValid && pctNumber < data.programmedPct;
  const plan = data.plan;
  const held = plan?.stage === "held";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Repeat className="h-4 w-4" />
          Auto-renewal
          {data.autoRenew && !held && <Badge className="ml-auto text-[10px]">On</Badge>}
          {data.autoRenew && held && (
            <Badge variant="outline" className="ml-auto text-[10px] border-amber-300 text-amber-800">Held</Badge>
          )}
          {!data.autoRenew && (
            <Badge variant="secondary" className="ml-auto text-[10px]">{data.paused ? "Paused" : "Off"}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          Report only for now. Switching this on adds the contract to the daily internal report. Nothing is prepared,
          sent to the customer or rolled automatically yet, so this contract still needs the usual Renew.
        </p>

        {data.autoRenew && plan && (
          <>
            <div className="space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Term ends</span>
                <span>{formatDate(endDate)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Would roll on</span>
                <span>{formatDate(plan.rollOn)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <span className="font-medium">{PLAN_STAGE_LABELS[plan.stage]}</span>
              </div>
              {plan.next && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Next step</span>
                  <span>{plan.next.label} · {formatDate(plan.next.on)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Customer notice</span>
                <span>{formatDate(plan.schedule.noticeOn)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Next term rent</span>
                <span className="font-medium">
                  {formatCurrency(plan.nextRent)} <span className="text-muted-foreground font-normal">(+{plan.nextRentPct}%)</span>
                </span>
              </div>
            </div>

            {held && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-1">
                <p className="font-semibold">Needs a person before it can roll</p>
                <ul className="list-disc pl-4">
                  {plan.holds.map((h) => <li key={h.code}>{h.label}</li>)}
                </ul>
              </div>
            )}
          </>
        )}

        {data.revised && (
          <div className="rounded-md border px-3 py-2 text-xs space-y-0.5">
            <p className="font-medium">
              Revised rate for the next term only: +{data.revised.percentage}%{" "}
              <span className="text-muted-foreground font-normal">(agreement says +{data.programmedPct}%)</span>
            </p>
            {data.revised.reason && <p className="text-muted-foreground">{data.revised.reason}</p>}
          </div>
        )}

        {!data.autoRenew && data.stopReason && (
          <p className="text-xs text-muted-foreground">
            {data.stopReason}
            {data.stoppedAt ? ` · ${formatDate(data.stoppedAt)}` : ""}
          </p>
        )}

        {canManage && (
          <div className="space-y-1.5 pt-1">
            {!data.autoRenew ? (
              <Button size="sm" className="w-full" disabled={busy || exitInProgress} onClick={() => run({ action: "enable" }, data.paused ? "Auto-renewal resumed" : "Auto-renewal switched on")}>
                {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="mr-1.5 h-3.5 w-3.5" />}
                {data.paused ? "Resume auto-renewal" : "Turn on auto-renewal"}
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="flex-1" disabled={busy} onClick={openRevise}>
                  <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" />
                  Revise rate
                </Button>
                <Button size="sm" variant="outline" className="flex-1" disabled={busy} onClick={() => { setReason(""); setPauseOpen(true); }}>
                  <PauseCircle className="mr-1.5 h-3.5 w-3.5" />
                  Pause
                </Button>
              </div>
            )}
            {data.autoRenew && (
              <Button size="sm" variant="outline" className="w-full text-destructive hover:text-destructive" disabled={busy || exitInProgress} onClick={onStartExit}>
                <XCircle className="mr-1.5 h-3.5 w-3.5" />
                Customer served notice
              </Button>
            )}
            {data.revised && data.autoRenew && (
              <Button size="sm" variant="ghost" className="w-full text-xs" disabled={busy} onClick={() => run({ action: "clear_revision" }, "Back to the agreement's rate")}>
                Clear revised rate
              </Button>
            )}
          </div>
        )}
      </CardContent>

      <Dialog open={reviseOpen} onOpenChange={setReviseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revise next term&apos;s rate · {contractNumber}</DialogTitle>
            <DialogDescription>
              Applies to the next term only. The agreement stays at +{data.programmedPct}% and the term after goes back to it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="ar-pct">Escalation for the next term (%)</Label>
              <Input id="ar-pct" type="number" min={0} max={100} step="0.5" value={pct} onChange={(e) => setPct(e.target.value)} className="h-9" />
              {!pctValid && <p className="text-xs text-destructive">Enter a percentage between 0 and 100.</p>}
              {below && userRole !== "admin" && (
                <p className="text-xs text-destructive">A rate below the agreement&apos;s +{data.programmedPct}% needs an admin.</p>
              )}
              {pctValid && plan && (
                <p className="text-xs text-muted-foreground">
                  Current rent {formatCurrency(plan.nextRent)} is shown at +{plan.nextRentPct}%. Saving updates it.
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="ar-reason">Reason <span className="text-destructive">*</span></Label>
              <Textarea id="ar-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Agreed on a call with the customer on 3 Nov" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviseOpen(false)}>Cancel</Button>
            <Button
              disabled={busy || !pctValid || !reason.trim() || (below && userRole !== "admin")}
              onClick={async () => {
                if (await run({ action: "revise", escalation_percentage: pctNumber, reason: reason.trim() }, "Rate for the next term saved")) setReviseOpen(false);
              }}
            >
              Save rate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pauseOpen} onOpenChange={setPauseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pause auto-renewal · {contractNumber}</DialogTitle>
            <DialogDescription>
              Stops the roll only. No exit starts and no notice is recorded. The contract keeps billing at its current rent and ends on {formatDate(endDate)} unless you resume or renew it by hand. If the customer is leaving, use &quot;Customer served notice&quot; instead.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="ar-pause-reason">Reason <span className="text-destructive">*</span></Label>
            <Textarea id="ar-pause-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer wants to renegotiate the rate" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPauseOpen(false)}>Back</Button>
            <Button
              disabled={busy || !reason.trim()}
              onClick={async () => {
                if (await run({ action: "pause", reason: reason.trim() }, "Auto-renewal paused")) setPauseOpen(false);
              }}
            >
              Pause auto-renewal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
