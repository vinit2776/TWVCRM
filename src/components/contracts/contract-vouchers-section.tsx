"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Wifi, ChevronDown, ChevronRight, Loader2, Ticket } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";
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
}

export function ContractVouchersSection({
  contractId,
  seats,
  contractStatus,
  startDate,
  endDate,
}: ContractVouchersSectionProps) {
  const [issuances, setIssuances] = useState<VoucherIssuance[]>([]);
  const [loading, setLoading] = useState(true);
  const [issuing, setIssuing] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

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
      const count = json.count || 0;
      toast.success(`Issued ${count} voucher${count !== 1 ? "s" : ""} successfully`);
      fetchIssuances();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to issue vouchers");
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
  const allSeatsFilled = issuances.length >= seats;
  const canIssue = isContractActive && !allSeatsFilled;

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
        <Button
          size="sm"
          onClick={handleIssueVouchers}
          disabled={!canIssue || issuing}
          title={
            !isContractActive
              ? "Contract must be active to issue vouchers"
              : allSeatsFilled
              ? "All seats have been filled"
              : "Issue vouchers for remaining seats"
          }
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
      </CardHeader>
      <CardContent>
        {loading ? (
          <TableSkeleton rows={3} />
        ) : issuances.length === 0 ? (
          <EmptyState
            icon={Ticket}
            title="No vouchers issued"
            description={
              isContractActive
                ? "Issue vouchers to assign them to this contract's seats."
                : "Activate the contract to issue vouchers."
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
                    <>
                      <tr
                        key={issuance.id}
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
                        <tr key={`${issuance.id}-meta`} className="border-b bg-muted/10">
                          <td colSpan={6} className="px-4 py-3">
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
                    </>
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
