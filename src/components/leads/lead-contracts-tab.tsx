"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Plus, ScrollText, MoreHorizontal, Eye, CheckCircle2, XCircle, Send, Mail, Clock, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { CreateContractDialog } from "@/components/contracts/create-contract-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  CONTRACT_STATUS_LABELS,
  CONTRACT_STATUS_COLORS,
  BILLING_CYCLE_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { Contract } from "@/types";
import { ContractLifecycle } from "@/components/contracts/contract-lifecycle";

interface LeadContractsTabProps {
  leadId: string;
}

type KycSummary = Record<string, { deferred: number; pending: number; uploaded: number; approved: number; rejected: number; total: number }>;

export function LeadContractsTab({ leadId }: LeadContractsTabProps) {
  const router = useRouter();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [contractFormOpen, setContractFormOpen] = useState(false);
  const [terminateOpen, setTerminateOpen] = useState(false);
  const [terminatingContract, setTerminatingContract] = useState<Contract | null>(null);
  const [terminationReason, setTerminationReason] = useState("");
  const [terminating, setTerminating] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [kycSummary, setKycSummary] = useState<KycSummary>({});

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/contracts?lead_id=${leadId}`);
    if (res.ok) {
      const json = await res.json();
      const loaded: Contract[] = json.data || [];
      setContracts(loaded);

      // Fetch KYC summary for all contracts in a single request
      if (loaded.length > 0) {
        const ids = loaded.map(c => c.id).join(",");
        fetch(`/api/contracts/kyc-summary?ids=${ids}`)
          .then(r => r.json())
          .then(j => setKycSummary(j.data || {}))
          .catch(() => {});
      }
    }
    setLoading(false);
  }, [leadId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSuccess = () => {
    fetchData();
  };

  const handleStatusUpdate = async (contract: Contract, newStatus: string) => {
    setUpdatingId(contract.id);
    const res = await fetch(`/api/contracts/${contract.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    if (res.ok) {
      const label = CONTRACT_STATUS_LABELS[newStatus] || newStatus;
      toast.success(`Contract marked as ${label}`);
      fetchData();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to update contract");
    }
    setUpdatingId(null);
  };

  const openTerminateDialog = (contract: Contract) => {
    setTerminatingContract(contract);
    setTerminationReason("");
    setTerminateOpen(true);
  };

  const handleTerminate = async () => {
    if (!terminatingContract) return;
    if (!terminationReason.trim()) {
      toast.error("Please provide a termination reason");
      return;
    }
    setTerminating(true);
    const res = await fetch(`/api/contracts/${terminatingContract.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "terminated",
        termination_reason: terminationReason.trim(),
      }),
    });
    if (res.ok) {
      toast.success("Contract terminated");
      setTerminateOpen(false);
      setTerminatingContract(null);
      setTerminationReason("");
      fetchData();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to terminate contract");
    }
    setTerminating(false);
  };

  if (loading) {
    return <TableSkeleton rows={4} />;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Contracts</CardTitle>
          <Button size="sm" onClick={() => setContractFormOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Contract
          </Button>
        </CardHeader>
        <CardContent>
          {contracts.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title="No contracts yet"
              description="Create a contract for this lead."
              actionLabel="Create Contract"
              onAction={() => setContractFormOpen(true)}
            />
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">Contract #</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">KYC</th>
                    <th className="px-4 py-3 text-right font-medium">Amount</th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Billing</th>
                    <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Start - End</th>
                    <th className="px-4 py-3 text-left font-medium w-16">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map((c) => {
                    const kyc = kycSummary[c.id];
                    const kycDeferred = kyc?.deferred ?? 0;
                    const kycPending = kyc ? (kyc.pending + kyc.uploaded + kyc.rejected) : 0;
                    const kycApproved = kyc?.approved ?? 0;
                    const kycTotal = kyc?.total ?? 0;
                    const kycFullyApproved = kycTotal > 0 && kycApproved >= kycTotal;
                    // Renewal chain linkage — without this, a renewal draft looks like
                    // an unrelated new contract, and a "Renewal in Progress" parent gives
                    // no clue that a draft is already waiting to be activated. That gap is
                    // exactly what let someone create a brand-new contract instead of
                    // opening the pending draft (see TWV-C-0045 → TWV-C-0096 incident).
                    const parent = c.parent_contract_id
                      ? contracts.find((p) => p.id === c.parent_contract_id)
                      : undefined;
                    const renewalDraft = c.status === "renewal_in_progress"
                      ? contracts
                          .filter((child) => child.parent_contract_id === c.id && child.status !== "rejected")
                          .sort((a, b) => (b.renewal_sequence ?? 0) - (a.renewal_sequence ?? 0))[0]
                      : undefined;
                    return (
                    <tr key={c.id} className="border-b hover:bg-muted/30 transition-colors cursor-pointer" onClick={() => router.push(`/contracts/${c.id}`)}>
                      <td className="px-4 py-3 font-mono text-xs">
                        {c.contract_number}
                        {c.is_renewal && (
                          <div className="mt-0.5 font-sans text-[11px] font-normal text-muted-foreground whitespace-nowrap">
                            ↳ renewal of {parent?.contract_number ?? "…"}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="secondary" className={CONTRACT_STATUS_COLORS[c.status]}>
                          {CONTRACT_STATUS_LABELS[c.status]}
                        </Badge>
                        {c.status === "renewal_in_progress" && (
                          renewalDraft ? (
                            <div className="mt-1 text-[11px] text-muted-foreground whitespace-nowrap">
                              → draft {renewalDraft.contract_number} pending activation
                            </div>
                          ) : (
                            <div className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-destructive whitespace-nowrap">
                              <AlertTriangle className="h-3 w-3" />
                              no renewal draft found — don&apos;t create a new contract, check Cancel Renewal
                            </div>
                          )
                        )}
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        {kycTotal === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : kycFullyApproved ? (
                          <span className="inline-flex items-center gap-1 text-xs text-green-700 font-medium">
                            <CheckCircle2 className="h-3 w-3" /> Complete
                          </span>
                        ) : kycDeferred > 0 && kycPending === 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs text-amber-700 font-medium">
                            <Clock className="h-3 w-3" /> {kycDeferred} deferred
                          </span>
                        ) : kycDeferred > 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs text-amber-700 font-medium">
                            <AlertTriangle className="h-3 w-3" /> {kycDeferred} deferred · {kycPending} missing
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-amber-600 font-medium">
                            <AlertTriangle className="h-3 w-3" /> {kycApproved}/{kycTotal}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-medium">
                        {formatCurrency(c.total_amount)}
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        {BILLING_CYCLE_LABELS[c.billing_cycle]}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">
                        {formatDate(c.start_date)} - {formatDate(c.end_date)}
                      </td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => router.push(`/contracts/${c.id}`)}>
                              <Eye className="mr-2 h-4 w-4" />
                              View
                            </DropdownMenuItem>
                            {c.status === "draft" && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() => router.push(`/contracts/${c.id}`)}
                                >
                                  <Send className="mr-2 h-4 w-4" />
                                  Send Agreement
                                </DropdownMenuItem>
                              </>
                            )}
                            {c.status === "sent" && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => handleStatusUpdate(c, "viewed")} disabled={updatingId === c.id}>
                                  <Eye className="mr-2 h-4 w-4" />
                                  Mark Viewed
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleStatusUpdate(c, "accepted")} disabled={updatingId === c.id}>
                                  <CheckCircle2 className="mr-2 h-4 w-4" />
                                  Accept
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleStatusUpdate(c, "rejected")} disabled={updatingId === c.id} className="text-destructive focus:text-destructive">
                                  <XCircle className="mr-2 h-4 w-4" />
                                  Reject
                                </DropdownMenuItem>
                              </>
                            )}
                            {c.status === "viewed" && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => handleStatusUpdate(c, "accepted")} disabled={updatingId === c.id}>
                                  <CheckCircle2 className="mr-2 h-4 w-4" />
                                  Accept
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleStatusUpdate(c, "rejected")} disabled={updatingId === c.id} className="text-destructive focus:text-destructive">
                                  <XCircle className="mr-2 h-4 w-4" />
                                  Reject
                                </DropdownMenuItem>
                              </>
                            )}
                            {c.status === "accepted" && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => handleStatusUpdate(c, "active")} disabled={updatingId === c.id}>
                                  <CheckCircle2 className="mr-2 h-4 w-4" />
                                  Activate
                                </DropdownMenuItem>
                              </>
                            )}
                            {c.status === "active" && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() => openTerminateDialog(c)}
                                  className="text-destructive focus:text-destructive"
                                >
                                  <XCircle className="mr-2 h-4 w-4" />
                                  Terminate
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Contract Lifecycle cards — one per contract */}
      {contracts.length > 0 && (
        <div className="space-y-4">
          {contracts.map((c) => (
            <Card key={`lifecycle-${c.id}`}>
              <CardHeader
                className="flex flex-row items-center justify-between pb-2 cursor-pointer"
                onClick={() => router.push(`/contracts/${c.id}`)}
              >
                <div>
                  <CardTitle className="text-sm font-mono">{c.contract_number}</CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">{c.title}</p>
                </div>
                <Badge variant="secondary" className={CONTRACT_STATUS_COLORS[c.status]}>
                  {CONTRACT_STATUS_LABELS[c.status]}
                </Badge>
              </CardHeader>
              <CardContent>
                <ContractLifecycle contract={c} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create Contract Dialog */}
      <CreateContractDialog
        leadId={leadId}
        open={contractFormOpen}
        onOpenChange={setContractFormOpen}
        onSuccess={handleSuccess}
      />

      {/* Terminate Dialog */}
      <Dialog open={terminateOpen} onOpenChange={setTerminateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Terminate Contract</DialogTitle>
            <DialogDescription>
              Are you sure you want to terminate contract{" "}
              {terminatingContract?.contract_number}? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="tab-termination-reason">
              Termination Reason <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="tab-termination-reason"
              value={terminationReason}
              onChange={(e) => setTerminationReason(e.target.value)}
              placeholder="Please provide a reason for termination..."
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTerminateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleTerminate}
              disabled={terminating}
            >
              {terminating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Terminating...
                </>
              ) : (
                "Terminate"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
