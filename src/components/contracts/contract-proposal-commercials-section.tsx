"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Receipt, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

const PAID_CLASS = "bg-green-50 text-green-700 border-green-200";
const PENDING_CLASS = "bg-amber-50 text-amber-700 border-amber-200";

interface ProrataStatement {
  id: string;
  statement_number: string;
  status: string;
  payment_status: string | null;
  total_amount: number;
  gst_invoice_number: string | null;
}

interface AttributedInvoice {
  id: string;
  invoice_number: string;
  status: string;
  total_amount: number;
  paid_at: string | null;
  attribution_purpose: string | null;
}

interface Props {
  contractId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- proposal join shape is untyped on the contract page
  proposal: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same contract snapshot shape ContractDepositSection takes
  contract: any;
  /** Bump to refetch after an attribution change in the ad-hoc card. */
  refreshKey?: number;
}

/**
 * What was collected through the proposal before activation: the security
 * deposit and the first (pro-rata) invoice. Answers "is it settled, and how"
 * without opening the proposal. Full detail stays in the deposit card and the
 * ad-hoc card — an ad-hoc invoice attributed to either is pointed at here, not
 * repeated.
 */
export function ContractProposalCommercialsSection({ contractId, proposal, contract, refreshKey = 0 }: Props) {
  const proposalId: string | undefined = proposal?.id ?? contract?.proposal_id;
  const [statement, setStatement] = useState<ProrataStatement | null>(null);
  const [attributed, setAttributed] = useState<AttributedInvoice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const requests: Promise<void>[] = [
      fetch(`/api/contracts/${contractId}/attributed-invoices`)
        .then((r) => r.json())
        .then((j) => { if (!cancelled) setAttributed(j.data?.attributed || []); })
        .catch(() => { if (!cancelled) setAttributed([]); }),
    ];
    if (proposalId) {
      // The first invoice is a billing_statements row keyed by proposal_id —
      // the contract didn't exist yet when it was sent.
      requests.push(
        fetch(`/api/billing-statements?proposal_id=${proposalId}&limit=1`)
          .then((r) => r.json())
          .then((j) => { if (!cancelled) setStatement(((j.data || []) as ProrataStatement[])[0] || null); })
          .catch(() => { if (!cancelled) setStatement(null); })
      );
    }
    Promise.all(requests).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contractId, proposalId, refreshKey]);

  if (!proposalId || loading) return null;

  const activated = !!contract?.status && (CONTRACT_QUOTA_LOCKED_STATUSES as readonly string[]).includes(contract.status);
  const depositSource = activated ? contract : proposal;
  const depositRequired = Number(proposal?.security_deposit_months ?? contract?.security_deposit_months ?? 0) > 0;
  const depositPaid = depositSource?.deposit_payment_status === "paid";

  const adhocFirst = attributed.find((i) => i.attribution_purpose === "prorata_first_invoice");
  const adhocDeposit = attributed.find((i) => i.attribution_purpose === "security_deposit");

  const proposalFirstPaid = statement ? statement.payment_status === "paid" : proposal?.payment_status === "paid";
  const firstSettled = proposalFirstPaid || adhocFirst?.status === "paid";
  const depositSettled = !depositRequired || depositPaid || adhocDeposit?.status === "paid";
  const allSettled = firstSettled && depositSettled;

  const paidBadge = (paid: boolean) => (
    <Badge variant="outline" className={`text-[10px] ${paid ? PAID_CLASS : PENDING_CLASS}`}>
      {paid ? "Paid" : "Pending"}
    </Badge>
  );

  return (
    <Card id="section-proposal-commercials" className="scroll-mt-4">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-4">
          <CardTitle className="text-base flex items-center gap-2">
            <Receipt className="h-4 w-4" />
            Proposal commercials
          </CardTitle>
          <Badge variant="outline" className={`text-[10px] ${allSettled ? PAID_CLASS : PENDING_CLASS}`}>
            {allSettled ? "Settled" : "Pending"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Deposit and first invoice collected before activation
          {proposal?.proposal_number && (
            <>
              , via{" "}
              <Link href={`/proposals/${proposalId}`} className="text-primary hover:underline">
                {proposal.proposal_number}
              </Link>
            </>
          )}
          .
        </p>
      </CardHeader>
      <CardContent className="divide-y text-sm">
        {depositRequired && (
          <div className="flex items-start justify-between gap-4 py-3 first:pt-0">
            <div>
              <p className="font-medium">Security deposit</p>
              {adhocDeposit ? (
                <p className="text-xs text-muted-foreground">
                  Settled by attributed invoice {adhocDeposit.invoice_number}. See Ad-hoc Invoices below.
                </p>
              ) : depositPaid ? (
                <p className="text-xs text-muted-foreground">
                  {depositSource?.deposit_payment_received_at ? formatDate(depositSource.deposit_payment_received_at) : "Received"}
                  {depositSource?.deposit_payment_medium &&
                    `, ${MEDIUM_LABELS[depositSource.deposit_payment_medium] ?? depositSource.deposit_payment_medium}`}
                  {depositSource?.deposit_payment_reference && `, ref ${depositSource.deposit_payment_reference}`}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Not received yet</p>
              )}
            </div>
            <div className="flex items-center gap-3">
              {depositPaid && depositSource?.deposit_payment_amount != null && (
                <span className="font-medium">{formatCurrency(Number(depositSource.deposit_payment_amount))}</span>
              )}
              {paidBadge(depositSettled)}
            </div>
          </div>
        )}

        <div className="flex items-start justify-between gap-4 py-3 last:pb-0">
          <div>
            <p className="font-medium">First invoice (pro-rata)</p>
            {adhocFirst ? (
              <p className="text-xs text-muted-foreground">
                Settled by attributed invoice {adhocFirst.invoice_number}
                {adhocFirst.paid_at && `, ${formatDate(adhocFirst.paid_at)}`}. See Ad-hoc Invoices below.
              </p>
            ) : statement ? (
              <p className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-2">
                <Link
                  href={`/api/billing-statements/${statement.id}/proforma-pdf`}
                  target="_blank"
                  className="font-mono text-primary hover:underline inline-flex items-center gap-1"
                >
                  {statement.statement_number}
                  <ExternalLink className="h-3 w-3" />
                </Link>
                {statement.gst_invoice_number && <span>GST invoice {statement.gst_invoice_number}</span>}
                {proposalFirstPaid && proposal?.payment_received_at && (
                  <span>Paid {formatDate(proposal.payment_received_at)}</span>
                )}
              </p>
            ) : proposalFirstPaid ? (
              <p className="text-xs text-muted-foreground">
                Paid via proposal
                {proposal?.payment_received_at && `, ${formatDate(proposal.payment_received_at)}`}. No invoice document on file.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">Not yet invoiced</p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {statement && !adhocFirst && (
              <span className="font-medium">{formatCurrency(Number(statement.total_amount))}</span>
            )}
            {adhocFirst && <span className="font-medium">{formatCurrency(Number(adhocFirst.total_amount))}</span>}
            {paidBadge(firstSettled)}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
