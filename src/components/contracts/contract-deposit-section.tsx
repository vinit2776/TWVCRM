"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink, ShieldCheck, ShieldAlert, ShieldOff, Users } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { CONTRACT_QUOTA_LOCKED_STATUSES } from "@/lib/constants";

const MEDIUM_LABELS: Record<string, string> = {
  neft: "NEFT",
  rtgs: "RTGS",
  upi: "UPI",
  cheque: "Cheque",
  cash: "Cash",
  razorpay: "Razorpay",
};

interface DepositProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proposal: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contract?: any;
  depositCarriedFrom?: string | null;
  leadId?: string;
}

// Once a contract activates, its own deposit columns (snapshotted from the
// proposal at that moment — see contracts/[id]/route.ts) become the source
// of truth and the contract never needs the proposal join again. Before
// that, the proposal is still the one collecting the deposit.
//
// The balance shown here is this contract's OWN collection — accurate on
// its own, since a contract's own history doesn't change. But since
// 00502_pooled_customer_deposits.sql, the ACTUAL available balance is
// pooled across every contract the customer holds. When they have more
// than one, a small pointer (not a number) links to the consolidated view.
export function ContractDepositSection({ proposal, contract, depositCarriedFrom, leadId }: DepositProps) {
  const isActivated = !!contract?.status && (CONTRACT_QUOTA_LOCKED_STATUSES as readonly string[]).includes(contract.status);
  const source = isActivated ? contract : proposal;

  const [siblingCount, setSiblingCount] = useState<number | null>(null);
  useEffect(() => {
    if (!leadId) return;
    fetch(`/api/leads/${leadId}/deposit-summary`)
      .then((r) => r.json())
      .then((j) => setSiblingCount(j.data?.contracts?.length ?? null))
      .catch(() => setSiblingCount(null));
  }, [leadId]);

  const siblingPointer = leadId && siblingCount && siblingCount > 1 ? (
    <a
      href={`/leads/${leadId}#security-deposit`}
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 mt-2"
    >
      <Users className="h-3 w-3" />
      This customer has {siblingCount} contracts — see the consolidated deposit on their profile
    </a>
  ) : null;

  if (!source) return null;

  const status: string = source.deposit_payment_status || "not_required";
  const required = Number(source.security_deposit_months || 0) > 0;

  // Renewal: deposit carried from parent contract
  if (depositCarriedFrom) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-green-600" />
            Security Deposit
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-green-700">
            <Badge className="bg-green-100 text-green-800 border-green-200">Carried Forward</Badge>
            <span>Deposit from parent contract — no new collection required.</span>
          </div>
          {siblingPointer}
        </CardContent>
      </Card>
    );
  }

  if (!required || status === "not_required") {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldOff className="h-4 w-4 text-muted-foreground" />
            Security Deposit
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">Not Required</Badge>
            {proposal?.deposit_waiver_verified_at && (
              <span className="text-xs text-muted-foreground">
                Admin waiver approved {formatDate(proposal.deposit_waiver_verified_at)}
              </span>
            )}
          </div>
          {siblingPointer}
        </CardContent>
      </Card>
    );
  }

  const isPaid = status === "paid";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          {isPaid
            ? <ShieldCheck className="h-4 w-4 text-green-600" />
            : <ShieldAlert className="h-4 w-4 text-amber-500" />
          }
          Security Deposit
          <Badge
            variant="outline"
            className={isPaid
              ? "ml-auto bg-green-50 text-green-700 border-green-200"
              : "ml-auto bg-amber-50 text-amber-700 border-amber-200"
            }
          >
            {isPaid ? "Paid" : "Pending"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isPaid ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Amount</p>
              <p className="font-semibold">{formatCurrency(Number(source.deposit_payment_amount || 0))}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Date</p>
              <p className="font-medium">
                {source.deposit_payment_received_at
                  ? formatDate(source.deposit_payment_received_at)
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Mode</p>
              <p className="font-medium">
                {source.deposit_payment_medium
                  ? (MEDIUM_LABELS[source.deposit_payment_medium] ?? source.deposit_payment_medium)
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Reference / UTR</p>
              <p className="font-mono text-xs break-all">
                {source.deposit_payment_reference || "—"}
              </p>
            </div>
            {/* Shortfall-approval and proof-screenshot never moved off the proposal —
                still shown (pre- or post-activation) when a proposal is available. */}
            {proposal?.deposit_shortfall_approved_by && (
              <div className="col-span-full">
                <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-200 bg-amber-50">
                  Shortfall approved
                </Badge>
              </div>
            )}
            {proposal?.deposit_payment_screenshot_url && (
              <div className="col-span-full">
                <Button variant="outline" size="sm" asChild>
                  <a href={proposal.deposit_payment_screenshot_url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                    View Payment Proof
                  </a>
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            Expected:{" "}
            <span className="font-semibold text-foreground">
              {formatCurrency(Number(source.security_deposit_amount || 0))}
            </span>
            {" "}({source.security_deposit_months}× monthly fee) — not yet collected.
          </div>
        )}
        {siblingPointer}
      </CardContent>
    </Card>
  );
}
