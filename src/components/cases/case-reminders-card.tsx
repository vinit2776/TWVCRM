"use client";

/**
 * The Renewal tab's two controls that depend on how a case is billed:
 *
 * - Automatic reminders: whether the daily renewal job may chase this case.
 *   Off for every case that predates the end-date backfill, because those end
 *   dates were derived rather than agreed. Switching one on says a person has
 *   confirmed the end date with the client, so the date is typed back.
 * - Postpaid partner continuation: the recorded confirmation, with the actions
 *   to roll over, change or withdraw it.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/utils";
import { PartnerRenewalDialog } from "@/components/cases/partner-renewal-dialog";
import type { PartnerRenewalRecord } from "@/lib/vo-renewal-reminders";

interface CaseInfo {
  status: string;
  end_date: string | null;
  renewal_notices_enabled: boolean | null;
  aggregator_id: string | null;
  aggregator?: { billing_method?: string | null } | null;
}

const LIVE = ["active", "renewal_due", "grace_period"];

export function CaseRemindersCard({
  caseId, onChanged,
}: {
  caseId: string;
  onChanged?: () => void;
}) {
  const [info, setInfo] = useState<CaseInfo | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<PartnerRenewalRecord | null>(null);
  const [today, setToday] = useState("");
  const [loading, setLoading] = useState(true);
  const [endConfirmed, setEndConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, me, p] = await Promise.all([
        fetch(`/api/cases/${caseId}`).then((r) => r.json()),
        fetch("/api/me").then((r) => r.json()),
        fetch(`/api/cases/${caseId}/partner-renewal`).then((r) => r.json()),
      ]);
      setInfo((c.data ?? null) as CaseInfo | null);
      setRole(me?.role ?? me?.data?.role ?? null);
      setConfirmation(p?.data?.confirmation ?? null);
      setToday(p?.data?.today ?? "");
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (!info || !info.end_date || !LIVE.includes(info.status)) return null;

  const postpaid = !!info.aggregator_id && info.aggregator?.billing_method === "postpaid";
  const canToggle = role === "admin" || role === "manager";
  const canRenewPartner = role === "admin" || role === "manager" || role === "sales_rep";
  const enabled = !!info.renewal_notices_enabled;
  const due = !!confirmation && !!today && today >= confirmation.term_start;

  const setEnabled = async (next: boolean) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/renewal-reminders`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next ? { enabled: true, confirm_end_date: info.end_date } : { enabled: false }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Could not change reminders"); return; }
      toast.success(next ? "Automatic reminders switched on" : "Automatic reminders switched off");
      setEndConfirmed(false);
      await load();
      onChanged?.();
    } catch {
      toast.error("Could not change reminders");
    } finally {
      setBusy(false);
    }
  };

  const partnerAction = async (method: "POST" | "DELETE") => {
    setBusy(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/partner-renewal`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify({ action: "roll" }) : undefined,
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "That didn't work"); return; }
      toast.success(method === "POST" ? "Rolled into the new term" : "Confirmation withdrawn");
      await load();
      onChanged?.();
    } catch {
      toast.error("That didn't work");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            Automatic reminders
            <Badge variant={enabled ? "default" : "outline"}>{enabled ? "On" : "Off"}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            {postpaid
              ? "A daily job flags this partner case for confirmation as its end date nears. It never contacts the partner or changes the case's status."
              : "A daily job follows up a renewal you have started with Start renewal — reminders at 21, 14 and 7 days on the same payment link, a final notice at the end date, then grace and lapse. It never starts a renewal and never contacts anyone who was not sent the first notice."}
          </p>
          {canToggle ? (
            enabled ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setEnabled(false)}>Switch off</Button>
            ) : (
              <div className="space-y-2">
                <label className="flex items-start gap-2 text-xs">
                  <Checkbox checked={endConfirmed} onCheckedChange={(v) => setEndConfirmed(v === true)} className="mt-0.5" />
                  <span>I have confirmed with the client that this agreement ends on <strong>{formatDate(info.end_date)}</strong>.</span>
                </label>
                <Button size="sm" disabled={busy || !endConfirmed} onClick={() => setEnabled(true)}>Switch on</Button>
              </div>
            )
          ) : (
            <p className="text-xs text-muted-foreground">An admin or manager can change this.</p>
          )}
        </CardContent>
      </Card>

      {postpaid && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              Partner continuation
              <Badge variant={confirmation ? "default" : "outline"}>{confirmation ? "Confirmed" : "Not confirmed"}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {confirmation ? (
              <>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-muted-foreground">New term</span><span>{formatDate(confirmation.term_start)} to {formatDate(confirmation.term_end)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Monthly fee from then</span><span className="tabular-nums">{formatCurrency(confirmation.new_rate)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Confirmed by</span><span>{confirmation.by_name ?? "—"} · {formatDate(confirmation.at)}</span></div>
                  <p className="pt-1 text-muted-foreground">{confirmation.note}</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {due
                    ? "The new term has started. The daily job rolls it over when switched on; you can do it now."
                    : `The case rolls into its new term on ${formatDate(confirmation.term_start)}.`}
                </p>
                {canRenewPartner && (
                  <div className="flex flex-wrap gap-2">
                    {due && <Button size="sm" disabled={busy} onClick={() => partnerAction("POST")}>Roll over now</Button>}
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialogOpen(true)}>Change</Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => partnerAction("DELETE")}>Withdraw</Button>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="text-muted-foreground">
                  This partner is invoiced monthly, so there is no renewal bill. Once the partner confirms they are continuing, record it here.
                </p>
                {canRenewPartner && <Button size="sm" onClick={() => setDialogOpen(true)}>Confirm partner renewal</Button>}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <PartnerRenewalDialog
        caseId={caseId}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onDone={async () => { await load(); onChanged?.(); }}
      />
    </div>
  );
}
