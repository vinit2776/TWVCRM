"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Receipt, ExternalLink, FileText, FileCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  period_start: string | null;
  period_end: string | null;
  due_date: string | null;
  subtotal: number | null;
  tax_percentage: number | null;
  tax_amount: number | null;
  total_amount: number;
  gst_invoice_number: string | null;
  proforma_sent_at: string | null;
  emailed_at: string | null;
  finalized_at: string | null;
}

interface StatementPayment {
  id: string;
  amount: number;
  payment_date: string;
  payment_mode: string;
  payment_reference: string | null;
  razorpay_payment_id: string | null;
}

// The proforma-pdf route 400s on draft/voided statements. Keep in sync with
// src/app/api/billing-statements/[id]/proforma-pdf/route.ts.
const canPreviewPdf = (status: string) => status !== "draft" && status !== "voided";

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
  const [payments, setPayments] = useState<StatementPayment[]>([]);
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
          .then(async (j) => {
            const stmt = ((j.data || []) as ProrataStatement[])[0] || null;
            if (cancelled) return;
            setStatement(stmt);
            if (!stmt) { setPayments([]); return; }
            const pj = await fetch(`/api/billing-statements/${stmt.id}/payment`).then((r) => r.json()).catch(() => ({}));
            if (!cancelled) setPayments(pj.data || []);
          })
          .catch(() => { if (!cancelled) { setStatement(null); setPayments([]); } })
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

        <div className="py-3 last:pb-0 space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium">First invoice (pro-rata)</p>
              {adhocFirst ? (
                <p className="text-xs text-muted-foreground">
                  Settled by attributed invoice {adhocFirst.invoice_number}
                  {adhocFirst.paid_at && `, ${formatDate(adhocFirst.paid_at)}`}. See Ad-hoc Invoices below.
                </p>
              ) : statement ? (
                <p className="text-xs text-muted-foreground font-mono">{statement.statement_number}</p>
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
              {adhocFirst && <span className="font-medium">{formatCurrency(Number(adhocFirst.total_amount))}</span>}
              {paidBadge(firstSettled)}
            </div>
          </div>

          {statement && !adhocFirst && (
            <div className="rounded-md border bg-muted/20 p-3 space-y-3">
              <div className="flex flex-wrap gap-2">
                {canPreviewPdf(statement.status) ? (
                  <Button variant="outline" size="sm" asChild>
                    <a href={`/api/billing-statements/${statement.id}/proforma-pdf`} target="_blank" rel="noopener noreferrer">
                      <FileText className="mr-1.5 h-3.5 w-3.5" />
                      View invoice
                    </a>
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">Invoice PDF available once finalized</span>
                )}
                {statement.gst_invoice_number && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={`/api/billing-statements/${statement.id}/gst-invoice-pdf`} target="_blank" rel="noopener noreferrer">
                      <FileCheck className="mr-1.5 h-3.5 w-3.5" />
                      View GST invoice
                    </a>
                  </Button>
                )}
              </div>

              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-xs">
                <Detail label="Proforma no." value={statement.statement_number} mono />
                <Detail label="GST invoice no." value={statement.gst_invoice_number || "Issued on payment"} mono={!!statement.gst_invoice_number} />
                <Detail
                  label="Period"
                  value={statement.period_start && statement.period_end ? `${formatDate(statement.period_start)} to ${formatDate(statement.period_end)}` : "—"}
                />
                <Detail
                  label="Sent"
                  value={(() => {
                    const sent = statement.proforma_sent_at || statement.emailed_at || statement.finalized_at;
                    return sent ? formatDate(sent) : "Not sent";
                  })()}
                />
                <Detail label="Due" value={statement.due_date ? formatDate(statement.due_date) : "—"} />
                <Detail label="Taxable value" value={statement.subtotal != null ? formatCurrency(Number(statement.subtotal)) : "—"} />
                <Detail
                  label={`GST${statement.tax_percentage != null ? ` (${Number(statement.tax_percentage)}%)` : ""}`}
                  value={statement.tax_amount != null ? formatCurrency(Number(statement.tax_amount)) : "—"}
                />
                <Detail label="Invoice total" value={formatCurrency(Number(statement.total_amount))} strong />
              </dl>

              <div className="border-t pt-2 text-xs">
                <p className="text-muted-foreground mb-1">Payment</p>
                {payments.length > 0 ? (
                  <ul className="space-y-1">
                    {payments.map((pay) => (
                      <li key={pay.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {formatDate(pay.payment_date)}, {MEDIUM_LABELS[pay.payment_mode] ?? pay.payment_mode}
                          {(pay.payment_reference || pay.razorpay_payment_id) && (
                            <span className="text-muted-foreground font-mono"> · {pay.payment_reference || pay.razorpay_payment_id}</span>
                          )}
                        </span>
                        <span className="font-medium">{formatCurrency(Number(pay.amount))}</span>
                      </li>
                    ))}
                  </ul>
                ) : proposalFirstPaid ? (
                  <p>
                    Paid{proposal?.payment_received_at ? ` ${formatDate(proposal.payment_received_at)}` : ""}. No payment record on the statement.
                  </p>
                ) : (
                  <p className="text-muted-foreground">No payment received yet.</p>
                )}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Detail({ label, value, mono, strong }: { label: string; value: string; mono?: boolean; strong?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`${mono ? "font-mono" : ""} ${strong ? "font-semibold" : "font-medium"}`}>{value}</dd>
    </div>
  );
}
