"use client";

import { useState, useEffect, useCallback, Fragment } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Wifi, ChevronDown, ChevronRight, Loader2, Ticket, AlertTriangle, Mail } from "lucide-react";
import { toast } from "sonner";
import { formatDate, getValidityLabel } from "@/lib/utils";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { VOUCHER_STATUS_LABELS, VOUCHER_STATUS_COLORS } from "@/lib/constants";

interface VoucherIssuance {
  id: string;
  contract_id: string;
  voucher_id: string;
  voucher?: {
    id: string;
    voucher_code: string;
    status: string;
    metadata: Record<string, unknown>;
    validity_days?: number | null;
  };
  lead_id: string;
  seat_number: number;
  issued_at: string;
  valid_from: string;
  valid_until: string;
  revoked_at?: string;
  revoke_reason?: string;
}

interface ContractVouchersSectionProps {
  contractId: string;
  seats: number;
  contractStatus: string;
  startDate: string;
  endDate: string;
  tenureMonths?: number;
  signedDocumentId?: string;
  leadEmail?: string;
}

export function ContractVouchersSection({
  contractId,
  seats,
  contractStatus,
  startDate,
  endDate,
  tenureMonths,
  signedDocumentId,
  leadEmail,
}: ContractVouchersSectionProps) {
  const [issuances, setIssuances] = useState<VoucherIssuance[]>([]);
  const [loading, setLoading] = useState(true);
  const [issuing, setIssuing] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [matchInfo, setMatchInfo] = useState<{
    matched_validity_days?: number | null;
    match_warning?: string | null;
  }>({});

  const fetchIssuances = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/contracts/${contractId}/vouchers`);
    if (res.ok) {
      const json = await res.json();
      setIssuances(json.data || []);
    }
    setLoading(false);
  }, [contractId]);

  useEffect(() => {
    fetchIssuances();
  }, [fetchIssuances]);

  const handleIssueVouchers = async () => {
    setIssuing(true);
    const res = await fetch(`/api/contracts/${contractId}/vouchers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    setIssuing(false);

    if (res.ok) {
      const json = await res.json();
      const count = json.data?.length || 0;
      setMatchInfo({
        matched_validity_days: json.matched_validity_days,
        match_warning: json.match_warning,
      });
      toast.success(`Issued ${count} voucher${count !== 1 ? "s" : ""} successfully`);
      fetchIssuances();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to issue vouchers");
    }
  };

  const handleEmailVouchers = async () => {
    if (!leadEmail) {
      toast.error("No email address found for this lead");
      return;
    }

    setEmailing(true);
    const res = await fetch(`/api/contracts/${contractId}/vouchers/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipients: [leadEmail] }),
    });

    setEmailing(false);

    if (res.ok) {
      toast.success(`Voucher details emailed to ${leadEmail}`);
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to send email");
    }
  };

  const toggleRow = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const isContractActive = contractStatus === "active";
  const hasSignedDoc = !!signedDocumentId;
  const allSeatsFilled = issuances.length >= seats;
  const canIssue = isContractActive && !allSeatsFilled && hasSignedDoc;
  const canEmail = issuances.length > 0 && !!leadEmail;

  // Compute expected validity from tenure
  const expectedValidity = tenureMonths ? tenureMonths * 30 : null;

  // Determine tooltip for issue button
  const issueTooltip = !isContractActive
    ? "Contract must be active to issue vouchers"
    : !hasSignedDoc
    ? "Upload signed contract before issuing vouchers"
    : allSeatsFilled
    ? "All seats have been filled"
    : "Issue vouchers for remaining seats";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <Wifi className="h-4 w-4" />
          Vouchers
          {issuances.length > 0 && (
            <Badge variant="secondary" className="ml-1">
              {issuances.length} / {seats}
            </Badge>
          )}
        </CardTitle>
        <div className="flex items-center gap-2">
          {canEmail && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleEmailVouchers}
              disabled={emailing}
              title={
                !leadEmail
                  ? "Lead has no email address"
                  : `Email vouchers to ${leadEmail}`
              }
            >
              {emailing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Mail className="mr-2 h-4 w-4" />
                  Email Vouchers
                </>
              )}
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleIssueVouchers}
            disabled={!canIssue || issuing}
            title={issueTooltip}
          >
            {issuing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Issuing...
              </>
            ) : (
              <>
                <Wifi className="mr-2 h-4 w-4" />
                Issue Vouchers
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* Signed document warning */}
        {isContractActive && !hasSignedDoc && !loading && (
          <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <p>Upload a signed contract document before issuing vouchers.</p>
          </div>
        )}

        {/* Match info banner */}
        {matchInfo.match_warning && (
          <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div>
              <p>{matchInfo.match_warning}</p>
              {matchInfo.matched_validity_days && (
                <p className="text-xs mt-1">
                  Matched validity:{" "}
                  <Badge variant="outline" className="text-xs">
                    {getValidityLabel(matchInfo.matched_validity_days)}
                  </Badge>
                </p>
              )}
            </div>
          </div>
        )}

        {/* Expected validity info */}
        {expectedValidity && isContractActive && !allSeatsFilled && !loading && (
          <div className="mb-4 text-xs text-muted-foreground">
            Expected voucher type: <Badge variant="outline" className="text-xs ml-1">{getValidityLabel(expectedValidity)}</Badge>
            <span className="ml-1">(based on {tenureMonths}-month tenure)</span>
          </div>
        )}

        {loading ? (
          <TableSkeleton rows={3} />
        ) : issuances.length === 0 ? (
          <EmptyState
            icon={Ticket}
            title="No vouchers issued"
            description={
              !isContractActive
                ? "Activate the contract to issue vouchers."
                : !hasSignedDoc
                ? "Upload a signed contract document to enable voucher issuance."
                : "Issue vouchers to assign them to this contract's seats."
            }
            actionLabel={canIssue ? "Issue Vouchers" : undefined}
            onAction={canIssue ? handleIssueVouchers : undefined}
          />
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium w-10"></th>
                  <th className="px-4 py-3 text-left font-medium">Seat #</th>
                  <th className="px-4 py-3 text-left font-medium">Voucher Code</th>
                  <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">Validity</th>
                  <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Valid From</th>
                  <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Valid Until</th>
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {issuances.map((issuance) => {
                  const isExpanded = expandedRows.has(issuance.id);
                  const voucherStatus = issuance.voucher?.status || "issued";
                  const metadata = issuance.voucher?.metadata || {};
                  const hasMetadata = Object.keys(metadata).length > 0;

                  return (
                    <Fragment key={issuance.id}>
                      <tr
                        className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                        onClick={() => hasMetadata && toggleRow(issuance.id)}
                      >
                        <td className="px-4 py-3">
                          {hasMetadata ? (
                            isExpanded ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )
                          ) : null}
                        </td>
                        <td className="px-4 py-3 font-medium">{issuance.seat_number}</td>
                        <td className="px-4 py-3 font-mono text-xs">
                          {issuance.voucher?.voucher_code || "-"}
                        </td>
                        <td className="px-4 py-3 hidden sm:table-cell">
                          <Badge variant="outline" className="text-xs">
                            {getValidityLabel(issuance.voucher?.validity_days)}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                          {issuance.valid_from ? formatDate(issuance.valid_from) : formatDate(startDate)}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                          {issuance.valid_until ? formatDate(issuance.valid_until) : formatDate(endDate)}
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant="secondary"
                            className={VOUCHER_STATUS_COLORS[voucherStatus] || "bg-gray-100 text-gray-800"}
                          >
                            {VOUCHER_STATUS_LABELS[voucherStatus] || voucherStatus}
                          </Badge>
                          {issuance.revoked_at && (
                            <span className="ml-2 text-xs text-red-600">
                              (Revoked)
                            </span>
                          )}
                        </td>
                      </tr>
                      {/* Expanded metadata row */}
                      {isExpanded && hasMetadata && (
                        <tr className="border-b bg-muted/10">
                          <td colSpan={7} className="px-4 py-3">
                            <div className="pl-10 space-y-1">
                              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                                Metadata
                              </p>
                              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                                {Object.entries(metadata).map(([key, value]) => (
                                  <div key={key} className="text-xs">
                                    <span className="text-muted-foreground">{key}:</span>{" "}
                                    <span className="font-medium">
                                      {typeof value === "object"
                                        ? JSON.stringify(value)
                                        : String(value)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                              {issuance.revoke_reason && (
                                <div className="mt-2 text-xs">
                                  <span className="text-red-600 font-medium">Revoke Reason:</span>{" "}
                                  {issuance.revoke_reason}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Summary info */}
        {!loading && issuances.length > 0 && (
          <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
            <span>{issuances.length} of {seats} seat{seats !== 1 ? "s" : ""} filled</span>
            {!allSeatsFilled && isContractActive && (
              <span className="text-orange-600">
                {seats - issuances.length} seat{seats - issuances.length !== 1 ? "s" : ""} remaining
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
