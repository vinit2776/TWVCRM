"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clearanceBlockers, computeClearance, SETTLEMENT_CLEAR_ROLES, SETTLEMENT_STATUS_LABELS } from "@/lib/exit-settlement";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { ExitView } from "@/lib/contract-exit-server";
import type { SettlementRow } from "@/lib/exit-settlement-server";

type View = ExitView & { settlementRecord?: SettlementRow | null };

const STATUS_STYLE: Record<string, string> = {
  pending_approval: "bg-amber-100 text-amber-800",
  returned: "bg-red-100 text-red-700",
  approved: "bg-blue-100 text-blue-800",
  paid: "bg-green-100 text-green-800",
  closed: "bg-gray-100 text-gray-700",
};

export function SettlementCard({ contractId, view, role, onChanged }: { contractId: string; view: View; role: string; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [account, setAccount] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [sending, setSending] = useState(false);

  const rec = view.settlementRecord ?? null;
  const live = !!rec && rec.status !== "returned";
  const { settlement } = view;
  const clr = computeClearance(view.depositAvailable, settlement.charges);
  const blockers = clearanceBlockers({
    exitStatus: view.exit.status,
    inspectionDone: !!view.exit.inspection_done_at,
    unpaidInvoices: settlement.unpaidInvoices,
    unbilledUsage: settlement.unbilledUsage,
    hasLiveSettlement: live,
  });
  const canSend = (SETTLEMENT_CLEAR_ROLES as readonly string[]).includes(role);

  const send = async () => {
    setSending(true);
    const res = await fetch(`/api/contracts/${contractId}/exit/settlement`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bank_account_name: name, bank_account_number: account, bank_ifsc: ifsc }),
    });
    setSending(false);
    if (res.ok) { toast.success("Sent for admin approval"); onChanged(); }
    else { const err = await res.json().catch(() => null); toast.error(err?.error || "Couldn't send for approval"); }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          Settlement
          {rec ? (
            <Badge variant="secondary" className={STATUS_STYLE[rec.status]}>{SETTLEMENT_STATUS_LABELS[rec.status]}</Badge>
          ) : (
            <Badge variant="secondary" className="bg-gray-100 text-gray-700">Not sent yet</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        <div className="flex justify-between"><span className="text-muted-foreground">Security deposit held</span><span>{formatCurrency(live && rec ? rec.deposit_amount : settlement.depositAvailable)}</span></div>
        {view.reservedForOthers > 0 && !live && (
          <p className="text-xs text-amber-700">
            The customer&apos;s pooled deposit is {formatCurrency(view.depositPool)}. {formatCurrency(view.reservedForOthers)} is kept back because the customer&apos;s other live contracts rely on it.
          </p>
        )}
        <div className="flex justify-between"><span className="text-muted-foreground">Inspection charges ({view.charges.length})</span><span>− {formatCurrency(live && rec ? rec.charges_total : settlement.charges)}</span></div>
        <div className="mt-2 flex justify-between border-t pt-2 font-medium">
          {(live && rec ? rec.outcome : clr.outcome) === "owed" ? (
            <><span>Customer owes after the deposit</span><span>{formatCurrency(live && rec ? rec.owed_amount : clr.owed)}</span></>
          ) : (
            <><span>Refund due to customer</span><span>{formatCurrency(live && rec ? rec.refund_amount : clr.refund)}</span></>
          )}
        </div>

        {!live && (settlement.unpaidInvoices > 0 || settlement.unbilledUsage > 0) && (
          <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <p className="font-medium">Settle these first. They are not netted here.</p>
            {view.unpaidInvoices.map((i) => (
              <div key={i.id} className="flex justify-between"><span>Unpaid invoice {i.reference ?? ""}</span><span>{formatCurrency(i.balance_due)}</span></div>
            ))}
            {settlement.unbilledUsage > 0 && (
              <div className="flex justify-between"><span>Unbilled usage (before GST), invoice it in Billing</span><span>{formatCurrency(settlement.unbilledUsage)}</span></div>
            )}
          </div>
        )}

        {rec?.status === "returned" && (
          <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
            Returned by the admin on {formatDate(rec.returned_at as string)}: {rec.return_reason}. The charges are unlocked; make the changes and send it again.
          </div>
        )}

        {live && rec && (
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            <div>Sent for approval {formatDate(rec.cleared_at)}</div>
            {rec.approved_at && <div>Approved {formatDate(rec.approved_at)}</div>}
            {rec.paid_at && <div>Paid {rec.payment_date ? formatDate(rec.payment_date) : formatDate(rec.paid_at)} · UTR {rec.payment_reference}</div>}
            <Button asChild size="sm" variant="outline" className="mt-1">
              <Link href={`/accounting/exit-settlements/${rec.id}`}>Open approval and payment</Link>
            </Button>
          </div>
        )}

        {!live && canSend && (
          <div className="mt-3 space-y-3 border-t pt-3">
            {clr.refund > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium">Refund bank details</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="space-y-1"><Label htmlFor="bk-name" className="text-xs">Account name</Label><Input id="bk-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
                  <div className="space-y-1"><Label htmlFor="bk-acc" className="text-xs">Account number</Label><Input id="bk-acc" inputMode="numeric" value={account} onChange={(e) => setAccount(e.target.value)} /></div>
                  <div className="space-y-1"><Label htmlFor="bk-ifsc" className="text-xs">IFSC</Label><Input id="bk-ifsc" value={ifsc} onChange={(e) => setIfsc(e.target.value.toUpperCase())} /></div>
                </div>
              </div>
            )}
            {blockers.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                {blockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            )}
            <Button size="sm" onClick={send} disabled={sending || blockers.length > 0}>
              {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send for approval
            </Button>
            <p className="text-xs text-muted-foreground">An admin reviews every step of this exit. Charges lock once it is sent. The customer is not contacted.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
