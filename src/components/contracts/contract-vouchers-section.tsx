"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Wifi,
  Loader2,
  Ticket,
  AlertTriangle,
  Mail,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  Send,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { formatDate, getValidityLabel } from "@/lib/utils";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { VOUCHER_STATUS_LABELS, VOUCHER_STATUS_COLORS } from "@/lib/constants";
import { VoucherReplaceDialog } from "./voucher-replace-dialog";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Member {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  is_active: boolean;
}

interface VoucherIssuance {
  id: string;
  contract_id: string;
  voucher_id: string | null;
  member_id: string | null;
  seat_number: number;
  issued_at: string;
  valid_from: string;
  valid_until: string;
  revoked_at?: string;
  revoke_reason?: string;
  seat_occupant_email?: string;
  emailed_at?: string;
  is_active: boolean;
  replaces_issuance_id?: string;
  voucher?: {
    id: string;
    voucher_code: string;
    status: string;
    metadata: Record<string, unknown>;
    validity_days?: number | null;
  };
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
  locationId?: string;
  printerDepartmentId?: string;
  onDepartmentIdUpdate?: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function maskCode(code: string) {
  if (!code || code.length <= 5) return code;
  return "•••••" + code.slice(-5);
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ContractVouchersSection({
  contractId,
  seats,
  contractStatus,
  startDate: _startDate,
  endDate: _endDate,
  tenureMonths,
  signedDocumentId,
  leadEmail: _leadEmail,
  locationId,
  printerDepartmentId,
  onDepartmentIdUpdate,
}: ContractVouchersSectionProps) {
  const [members, setMembers] = useState<Member[]>([]);
  const [issuances, setIssuances] = useState<VoucherIssuance[]>([]);
  const [loading, setLoading] = useState(true);
  const [issuingMember, setIssuingMember] = useState<string | null>(null);
  const [issuingAll, setIssuingAll] = useState(false);
  const [sendingIssuance, setSendingIssuance] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [inventoryCheck, setInventoryCheck] = useState<{
    loading: boolean;
    compatible: boolean;
    matchedGroup: string | null;
    availableCount: number;
    neededCount: number;
  }>({ loading: false, compatible: false, matchedGroup: null, availableCount: 0, neededCount: 0 });
  const [matchInfo, setMatchInfo] = useState<{
    matched_validity_days?: number | null;
    match_warning?: string | null;
  }>({});

  const [replaceDialog, setReplaceDialog] = useState<{
    open: boolean;
    issuanceId: string;
    seatNumber: number;
    voucherCode: string;
    seatEmail?: string;
  }>({ open: false, issuanceId: "", seatNumber: 0, voucherCode: "" });

  // ── Data loading ─────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    const params = showHistory ? "?show_history=true" : "";
    const [membersRes, issuancesRes] = await Promise.all([
      fetch(`/api/contracts/${contractId}/members`),
      fetch(`/api/contracts/${contractId}/vouchers${params}`),
    ]);

    if (membersRes.ok) {
      const json = await membersRes.json();
      setMembers((json.data ?? []).filter((m: Member) => m.is_active));
    }
    if (issuancesRes.ok) {
      const json = await issuancesRes.json();
      setIssuances(json.data ?? []);
    }
    setLoading(false);
  }, [contractId, showHistory]);

  useEffect(() => { load(); }, [load]);

  // ── Inventory check ──────────────────────────────────────────────────────────

  const activeIssuances = issuances.filter((i) => i.is_active);
  const issuedMemberIds = new Set(
    activeIssuances.map((i) => i.member_id).filter(Boolean) as string[]
  );
  const unissuedMembers = members.filter((m) => !issuedMemberIds.has(m.id));

  const checkInventory = useCallback(async (needed: number) => {
    if (!tenureMonths || needed <= 0) return;
    const targetDays = tenureMonths * 30;
    const tolerance = 0.20;
    const min = Math.floor(targetDays * (1 - tolerance));
    const max = Math.ceil(targetDays * (1 + tolerance));

    setInventoryCheck((p) => ({ ...p, loading: true }));
    try {
      const params = new URLSearchParams();
      if (locationId) params.set("location_id", locationId);
      const res = await fetch(`/api/vouchers/inventory?${params}`);
      if (res.ok) {
        const json = await res.json();
        const groups: { validity_days: number | null; available: number }[] = json.data || [];
        const compatible = groups
          .filter((g) => g.validity_days != null && g.validity_days >= min && g.validity_days <= max)
          .sort((a, b) => Math.abs((a.validity_days || 0) - targetDays) - Math.abs((b.validity_days || 0) - targetDays));
        if (compatible.length > 0) {
          const best = compatible[0];
          setInventoryCheck({
            loading: false,
            compatible: best.available >= needed,
            matchedGroup: getValidityLabel(best.validity_days),
            availableCount: best.available,
            neededCount: needed,
          });
        } else {
          setInventoryCheck({ loading: false, compatible: false, matchedGroup: null, availableCount: 0, neededCount: needed });
        }
      }
    } catch {
      setInventoryCheck((p) => ({ ...p, loading: false }));
    }
  }, [tenureMonths, locationId]);

  useEffect(() => {
    if (!loading && unissuedMembers.length > 0 && contractStatus === "active") {
      checkInventory(unissuedMembers.length);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, unissuedMembers.length, contractStatus]);

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function handleIssueMember(member: Member) {
    if (!member.email) {
      toast.error(`${member.name} has no email address — add an email to issue a voucher`);
      return;
    }
    setIssuingMember(member.id);
    try {
      // Find the next available seat number
      const activeSeatNumbers = new Set(activeIssuances.map((i) => i.seat_number));
      let nextSeat = 1;
      while (activeSeatNumbers.has(nextSeat) && nextSeat <= seats) nextSeat++;

      const res = await fetch(`/api/contracts/${contractId}/vouchers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seat_number: nextSeat,
          seat_occupant_email: member.email,
          member_id: member.id,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "Failed to issue voucher");
        return;
      }
      setMatchInfo({ matched_validity_days: json.matched_validity_days, match_warning: json.match_warning });
      toast.success(`Voucher issued for ${member.name}`);
      await load();
    } finally {
      setIssuingMember(null);
    }
  }

  async function handleIssueAll() {
    const membersNeedingVouchers = unissuedMembers.filter((m) => !!m.email);
    if (membersNeedingVouchers.length === 0) {
      toast.error("No members with email addresses need vouchers");
      return;
    }
    setIssuingAll(true);
    try {
      let issued = 0;
      const activeSeatNumbers = new Set(activeIssuances.map((i) => i.seat_number));

      for (const member of membersNeedingVouchers) {
        let nextSeat = 1;
        while (activeSeatNumbers.has(nextSeat) && nextSeat <= seats) nextSeat++;
        activeSeatNumbers.add(nextSeat);

        const res = await fetch(`/api/contracts/${contractId}/vouchers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            seat_number: nextSeat,
            seat_occupant_email: member.email,
            member_id: member.id,
          }),
        });
        if (res.ok) issued++;
        else {
          const json = await res.json();
          toast.error(`Failed for ${member.name}: ${json.error ?? "Unknown error"}`);
          break;
        }
      }

      if (issued > 0) {
        toast.success(`${issued} voucher${issued !== 1 ? "s" : ""} issued`);
        await load();
      }
    } finally {
      setIssuingAll(false);
    }
  }

  async function handleSendEmail(issuanceId: string, email: string) {
    setSendingIssuance(issuanceId);
    try {
      const res = await fetch(`/api/contracts/${contractId}/vouchers/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issuance_id: issuanceId, email }),
      });
      if (res.ok) {
        toast.success(`Voucher emailed to ${email}`);
        await load();
      } else {
        const json = await res.json();
        toast.error(json.error ?? "Failed to send email");
      }
    } finally {
      setSendingIssuance(null);
    }
  }

  // ── Derived state ─────────────────────────────────────────────────────────────

  const isContractActive = contractStatus === "active";
  const hasSignedDoc = !!signedDocumentId;
  const canIssue = isContractActive && hasSignedDoc;
  const expectedValidity = tenureMonths ? tenureMonths * 30 : null;
  const historyIssuances = issuances.filter((i) => !i.is_active);

  // Build a map: member_id → active issuance
  const issuanceByMember = new Map<string, VoucherIssuance>();
  for (const iss of activeIssuances) {
    if (iss.member_id) issuanceByMember.set(iss.member_id, iss);
  }

  // Legacy issuances not linked to any member (issued before this change)
  const legacyIssuances = activeIssuances.filter((i) => !i.member_id);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <Wifi className="h-4 w-4" />
          Vouchers
          {activeIssuances.length > 0 && (
            <Badge variant="secondary" className="ml-1">
              {activeIssuances.length} / {seats}
            </Badge>
          )}
        </CardTitle>
        <div className="flex items-center gap-2">
          {(issuances.length > 0 || historyIssuances.length > 0) && (
            <Button size="sm" variant="ghost" onClick={() => setShowHistory(!showHistory)} className="text-xs">
              {showHistory ? <EyeOff className="mr-1 h-3.5 w-3.5" /> : <Eye className="mr-1 h-3.5 w-3.5" />}
              {showHistory ? "Hide History" : "Show History"}
            </Button>
          )}
          {canIssue && unissuedMembers.filter((m) => !!m.email).length > 1 && (
            <Button size="sm" onClick={handleIssueAll} disabled={issuingAll}>
              {issuingAll
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Issuing...</>
                : <><Wifi className="mr-2 h-4 w-4" />Issue All</>
              }
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Printer Department ID */}
        {isContractActive && locationId && (
          <DepartmentIdCard
            contractId={contractId}
            departmentId={printerDepartmentId}
            onUpdate={onDepartmentIdUpdate}
          />
        )}

        {/* Signed document warning */}
        {isContractActive && !hasSignedDoc && !loading && (
          <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <p>Upload a signed contract document before issuing vouchers.</p>
          </div>
        )}

        {/* Match warning */}
        {matchInfo.match_warning && (
          <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div>
              <p>{matchInfo.match_warning}</p>
              {matchInfo.matched_validity_days && (
                <p className="text-xs mt-1">
                  Matched: <Badge variant="outline" className="text-xs">{getValidityLabel(matchInfo.matched_validity_days)}</Badge>
                </p>
              )}
            </div>
          </div>
        )}

        {/* Inventory check */}
        {expectedValidity && isContractActive && unissuedMembers.length > 0 && !loading && (
          <div className="mb-2 rounded-md border p-3 space-y-1.5">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              Required type: <Badge variant="outline" className="text-xs ml-1 font-medium">{getValidityLabel(expectedValidity)}</Badge>
              <span className="ml-1">({tenureMonths}-month tenure)</span>
            </div>
            {inventoryCheck.loading ? (
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> Checking inventory…
              </div>
            ) : inventoryCheck.matchedGroup ? (
              inventoryCheck.compatible ? (
                <div className="text-xs text-green-700 flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {inventoryCheck.availableCount} compatible vouchers available ({inventoryCheck.matchedGroup})
                </div>
              ) : (
                <div className="text-xs text-amber-700 flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Only {inventoryCheck.availableCount} ({inventoryCheck.matchedGroup}) — need {inventoryCheck.neededCount}. Upload more.
                </div>
              )
            ) : inventoryCheck.neededCount > 0 ? (
              <div className="text-xs text-red-600 flex items-center gap-1">
                <XCircle className="h-3.5 w-3.5" />
                No compatible vouchers. Upload {getValidityLabel(expectedValidity)} vouchers.
              </div>
            ) : null}
          </div>
        )}

        {/* Member list */}
        {loading ? (
          <TableSkeleton rows={3} />
        ) : members.length === 0 ? (
          <EmptyState
            icon={Ticket}
            title="No members added"
            description="Add members in the Members & Access section above — they will appear here for voucher issuance."
          />
        ) : (
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2.5 text-left font-medium">Member</th>
                  <th className="px-3 py-2.5 text-left font-medium hidden sm:table-cell">Email</th>
                  <th className="px-3 py-2.5 text-left font-medium">Voucher Code</th>
                  <th className="px-3 py-2.5 text-left font-medium hidden sm:table-cell">Validity</th>
                  <th className="px-3 py-2.5 text-left font-medium hidden lg:table-cell">Sent</th>
                  <th className="px-3 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const issuance = issuanceByMember.get(member.id);
                  const hasVoucher = !!issuance;
                  const voucherStatus = issuance?.voucher?.status || "issued";
                  const isIssuing = issuingMember === member.id;
                  const isSending = sendingIssuance === issuance?.id;
                  const hasEmail = !!member.email;

                  return (
                    <tr key={member.id} className="border-b hover:bg-muted/20 transition-colors">
                      <td className="px-3 py-3">
                        <div className="font-medium text-sm">{member.name}</div>
                        <div className="text-xs text-muted-foreground">{member.phone}</div>
                      </td>
                      <td className="px-3 py-3 hidden sm:table-cell text-xs text-muted-foreground">
                        {member.email ?? <span className="italic">No email</span>}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-muted-foreground">
                        {hasVoucher
                          ? maskCode(issuance.voucher?.voucher_code || "—")
                          : <span className="italic text-muted-foreground/60">Not issued</span>
                        }
                      </td>
                      <td className="px-3 py-3 hidden sm:table-cell">
                        {hasVoucher
                          ? <Badge variant="outline" className="text-xs">{getValidityLabel(issuance.voucher?.validity_days)}</Badge>
                          : "—"
                        }
                      </td>
                      <td className="px-3 py-3 hidden lg:table-cell">
                        {hasVoucher && issuance.emailed_at ? (
                          <span className="text-xs text-green-700 flex items-center gap-1">
                            <Mail className="h-3 w-3" />Sent {formatDate(issuance.emailed_at)}
                          </span>
                        ) : hasVoucher ? (
                          <span className="text-xs text-muted-foreground">Not sent</span>
                        ) : "—"}
                      </td>
                      <td className="px-3 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {!hasVoucher && canIssue && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-xs h-7"
                              onClick={() => handleIssueMember(member)}
                              disabled={isIssuing || issuingAll}
                              title={hasEmail ? `Issue voucher to ${member.email}` : "Add email to this member first"}
                            >
                              {isIssuing
                                ? <Loader2 className="h-3 w-3 animate-spin" />
                                : <><Ticket className="mr-1 h-3 w-3" />Issue</>
                              }
                            </Button>
                          )}
                          {hasVoucher && (
                            <>
                              <Badge
                                variant="secondary"
                                className={`text-xs ${VOUCHER_STATUS_COLORS[voucherStatus] || "bg-gray-100 text-gray-800"}`}
                              >
                                {VOUCHER_STATUS_LABELS[voucherStatus] || voucherStatus}
                              </Badge>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0"
                                onClick={() => {
                                  if (!member.email) {
                                    toast.error(`${member.name} has no email address — update their profile to send`);
                                    return;
                                  }
                                  handleSendEmail(issuance.id, member.email);
                                }}
                                disabled={isSending}
                                title={member.email ? `Send to ${member.email}` : "No email on member profile"}
                              >
                                {isSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0 text-orange-600 hover:text-orange-700"
                                onClick={() => setReplaceDialog({
                                  open: true,
                                  issuanceId: issuance.id,
                                  seatNumber: issuance.seat_number,
                                  voucherCode: issuance.voucher?.voucher_code || "",
                                  seatEmail: member.email ?? undefined,
                                })}
                                title="Replace voucher"
                              >
                                <RefreshCw className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Legacy issuances — issued before member linkage was introduced */}
        {legacyIssuances.length > 0 && (
          <div className="mt-4">
            <p className="text-xs text-muted-foreground font-medium mb-2 uppercase tracking-wide">Previously issued (no member link)</p>
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-center font-medium w-16">Seat</th>
                    <th className="px-3 py-2 text-left font-medium">Email</th>
                    <th className="px-3 py-2 text-left font-medium">Code</th>
                    <th className="px-3 py-2 text-left font-medium hidden sm:table-cell">Validity</th>
                    <th className="px-3 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {legacyIssuances.map((iss) => {
                    const voucherStatus = iss.voucher?.status || "issued";
                    const isSending = sendingIssuance === iss.id;
                    return (
                      <tr key={iss.id} className="border-b hover:bg-muted/20 transition-colors">
                        <td className="px-3 py-2.5 text-center text-muted-foreground">{iss.seat_number}</td>
                        <td className="px-3 py-2.5 text-xs text-muted-foreground">{iss.seat_occupant_email ?? <span className="italic">—</span>}</td>
                        <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">{maskCode(iss.voucher?.voucher_code || "—")}</td>
                        <td className="px-3 py-2.5 hidden sm:table-cell">
                          <Badge variant="outline" className="text-xs">{getValidityLabel(iss.voucher?.validity_days)}</Badge>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Badge variant="secondary" className={`text-xs ${VOUCHER_STATUS_COLORS[voucherStatus] || ""}`}>
                              {VOUCHER_STATUS_LABELS[voucherStatus] || voucherStatus}
                            </Badge>
                            {iss.seat_occupant_email && (
                              <Button
                                size="sm" variant="ghost" className="h-7 w-7 p-0"
                                onClick={() => handleSendEmail(iss.id, iss.seat_occupant_email!)}
                                disabled={isSending}
                                title={`Send to ${iss.seat_occupant_email}`}
                              >
                                {isSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                              </Button>
                            )}
                            <Button
                              size="sm" variant="ghost" className="h-7 w-7 p-0 text-orange-600 hover:text-orange-700"
                              onClick={() => setReplaceDialog({
                                open: true,
                                issuanceId: iss.id,
                                seatNumber: iss.seat_number,
                                voucherCode: iss.voucher?.voucher_code || "",
                                seatEmail: iss.seat_occupant_email,
                              })}
                              title="Replace voucher"
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Replacement history */}
        {showHistory && historyIssuances.length > 0 && (
          <div className="mt-4">
            <p className="text-xs text-muted-foreground font-medium mb-2 uppercase tracking-wide">Replacement History</p>
            <div className="rounded-md border overflow-hidden opacity-60">
              <table className="w-full text-sm">
                <tbody>
                  {historyIssuances.map((iss) => (
                    <tr key={iss.id} className="border-b">
                      <td className="px-3 py-2 text-center text-xs text-muted-foreground w-12">{iss.seat_number}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{iss.seat_occupant_email || "—"}</td>
                      <td className="px-3 py-2 font-mono text-xs line-through text-muted-foreground">{maskCode(iss.voucher?.voucher_code || "—")}</td>
                      <td className="px-3 py-2">
                        <Badge variant="secondary" className="bg-red-100 text-red-800 text-xs">Revoked</Badge>
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                        {iss.revoked_at ? formatDate(iss.revoked_at) : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Summary */}
        {!loading && activeIssuances.length > 0 && (
          <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1">
            <span>{activeIssuances.length} of {seats} seat{seats !== 1 ? "s" : ""} issued</span>
            {unissuedMembers.length > 0 && (
              <span className="text-orange-600">{unissuedMembers.length} member{unissuedMembers.length !== 1 ? "s" : ""} without voucher</span>
            )}
          </div>
        )}
      </CardContent>

      <VoucherReplaceDialog
        open={replaceDialog.open}
        onOpenChange={(open) => setReplaceDialog((prev) => ({ ...prev, open }))}
        contractId={contractId}
        issuanceId={replaceDialog.issuanceId}
        seatNumber={replaceDialog.seatNumber}
        currentVoucherCode={replaceDialog.voucherCode}
        seatEmail={replaceDialog.seatEmail}
        onSuccess={load}
      />
    </Card>
  );
}

// ── Inline Department ID Card (unchanged) ──────────────────────────────────────

import { Input } from "@/components/ui/input";
import { Pencil } from "lucide-react";

function DepartmentIdCard({ contractId, departmentId, onUpdate }: { contractId: string; departmentId?: string; onUpdate?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(departmentId || "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const res = await fetch(`/api/contracts/${contractId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ department_id: value.trim() || null }),
    });
    setSaving(false);
    if (res.ok) {
      toast.success(value.trim() ? "Department ID saved" : "Department ID cleared");
      setEditing(false);
      onUpdate?.();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to save");
    }
  };

  return (
    <div className="mb-4 rounded-md border bg-muted/30 p-3 flex items-center gap-3">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground shrink-0">
        <Ticket className="h-4 w-4" />
        Printer Dept ID:
      </div>
      {editing ? (
        <div className="flex items-center gap-2 flex-1">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. DEPT-001"
            className="h-7 text-sm w-40"
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
          />
          <Button size="sm" className="h-7 text-xs" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setEditing(false); setValue(departmentId || ""); }}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-1">
          {departmentId
            ? <Badge variant="secondary" className="font-mono">{departmentId}</Badge>
            : <span className="text-xs text-muted-foreground">Not assigned</span>
          }
          <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => setEditing(true)}>
            <Pencil className="h-3 w-3 mr-1" />{departmentId ? "Edit" : "Assign"}
          </Button>
        </div>
      )}
    </div>
  );
}
