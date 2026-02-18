"use client";

import { useState, useEffect, useCallback, Fragment } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Wifi,
  ChevronDown,
  ChevronRight,
  Loader2,
  Ticket,
  AlertTriangle,
  Mail,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Eye,
  EyeOff,
  Send,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import { formatDate, getValidityLabel } from "@/lib/utils";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { VOUCHER_STATUS_LABELS, VOUCHER_STATUS_COLORS } from "@/lib/constants";
import { VoucherReplaceDialog } from "./voucher-replace-dialog";

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
  seat_occupant_email?: string;
  emailed_at?: string;
  is_active: boolean;
  replaces_issuance_id?: string;
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
  locationId,
}: ContractVouchersSectionProps) {
  const [issuances, setIssuances] = useState<VoucherIssuance[]>([]);
  const [loading, setLoading] = useState(true);
  const [issuingSeat, setIssuingSeat] = useState<number | null>(null);
  const [issuingAll, setIssuingAll] = useState(false);
  const [sendingSeat, setSendingSeat] = useState<string | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [showHistory, setShowHistory] = useState(false);
  const [editingEmail, setEditingEmail] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);
  const [matchInfo, setMatchInfo] = useState<{
    matched_validity_days?: number | null;
    match_warning?: string | null;
  }>({});
  const [inventoryCheck, setInventoryCheck] = useState<{
    loading: boolean;
    compatible: boolean;
    matchedGroup: string | null;
    availableCount: number;
    neededCount: number;
  }>({ loading: false, compatible: false, matchedGroup: null, availableCount: 0, neededCount: 0 });

  // Replace dialog state
  const [replaceDialog, setReplaceDialog] = useState<{
    open: boolean;
    issuanceId: string;
    seatNumber: number;
    voucherCode: string;
    seatEmail?: string;
  }>({ open: false, issuanceId: "", seatNumber: 0, voucherCode: "" });

  // Per-seat email drafts for unissued seats
  const [unissuedEmails, setUnissuedEmails] = useState<Record<number, string>>({});

  const fetchIssuances = useCallback(async () => {
    setLoading(true);
    const params = showHistory ? "?show_history=true" : "";
    const res = await fetch(`/api/contracts/${contractId}/vouchers${params}`);
    if (res.ok) {
      const json = await res.json();
      setIssuances(json.data || []);
    }
    setLoading(false);
  }, [contractId, showHistory]);

  // Check voucher inventory compatibility
  const checkInventoryCompatibility = useCallback(async (activeCount: number) => {
    if (!tenureMonths) return;
    const targetDays = tenureMonths * 30;
    const tolerance = 0.20;
    const minAcceptable = Math.floor(targetDays * (1 - tolerance));
    const maxAcceptable = Math.ceil(targetDays * (1 + tolerance));
    const needed = seats - activeCount;
    if (needed <= 0) return;

    setInventoryCheck((prev) => ({ ...prev, loading: true }));
    try {
      const params = new URLSearchParams();
      if (locationId) params.set("location_id", locationId);
      const res = await fetch(`/api/vouchers/inventory?${params}`);
      if (res.ok) {
        const json = await res.json();
        const groups: { validity_days: number | null; available: number }[] = json.data || [];
        const compatible = groups.filter(
          (g) => g.validity_days != null && g.validity_days >= minAcceptable && g.validity_days <= maxAcceptable
        );
        if (compatible.length > 0) {
          const sorted = compatible.sort((a, b) => Math.abs((a.validity_days || 0) - targetDays) - Math.abs((b.validity_days || 0) - targetDays));
          const best = sorted[0];
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
      setInventoryCheck((prev) => ({ ...prev, loading: false }));
    }
  }, [tenureMonths, seats, locationId]);

  useEffect(() => {
    fetchIssuances();
  }, [fetchIssuances]);

  // Check inventory for remaining seats
  const activeIssuances = issuances.filter((i) => i.is_active);

  useEffect(() => {
    if (!loading && activeIssuances.length < seats && contractStatus === "active") {
      checkInventoryCompatibility(activeIssuances.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, activeIssuances.length, seats, contractStatus, checkInventoryCompatibility]);

  // Issue voucher for a specific seat
  const handleIssueSeat = async (seatNumber: number) => {
    const email = unissuedEmails[seatNumber]?.trim();
    if (!email) {
      toast.error("Enter an email address before issuing");
      return;
    }
    setIssuingSeat(seatNumber);
    const res = await fetch(`/api/contracts/${contractId}/vouchers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seat_number: seatNumber, seat_occupant_email: email }),
    });
    setIssuingSeat(null);

    if (res.ok) {
      const json = await res.json();
      setMatchInfo({ matched_validity_days: json.matched_validity_days, match_warning: json.match_warning });
      // Clear the draft email for this seat
      setUnissuedEmails((prev) => { const next = { ...prev }; delete next[seatNumber]; return next; });
      toast.success(`Voucher issued for seat ${seatNumber}`);
      fetchIssuances();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to issue voucher");
    }
  };

  // Issue all remaining seats
  const handleIssueAllRemaining = async () => {
    setIssuingAll(true);
    const res = await fetch(`/api/contracts/${contractId}/vouchers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    setIssuingAll(false);

    if (res.ok) {
      const json = await res.json();
      const count = json.data?.length || 0;
      setMatchInfo({ matched_validity_days: json.matched_validity_days, match_warning: json.match_warning });
      toast.success(`Issued ${count} voucher${count !== 1 ? "s" : ""} successfully`);
      fetchIssuances();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to issue vouchers");
    }
  };

  // Send email for a specific seat
  const handleSendEmail = async (issuanceId: string, email?: string) => {
    if (!email) {
      toast.error("Enter an email address first");
      return;
    }
    setSendingSeat(issuanceId);
    const res = await fetch(`/api/contracts/${contractId}/vouchers/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issuance_id: issuanceId, email }),
    });
    setSendingSeat(null);

    if (res.ok) {
      toast.success(`Voucher emailed to ${email}`);
      fetchIssuances();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to send email");
    }
  };

  // Save inline email edit
  const handleSaveEmail = async (issuanceId: string) => {
    setSavingEmail(true);
    const res = await fetch(`/api/contracts/${contractId}/vouchers/${issuanceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seat_occupant_email: emailDraft }),
    });
    setSavingEmail(false);

    if (res.ok) {
      setEditingEmail(null);
      setEmailDraft("");
      fetchIssuances();
    } else {
      toast.error("Failed to save email");
    }
  };

  const toggleRow = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Mask voucher code: show only last 5 chars
  const maskCode = (code: string) => {
    if (!code || code.length <= 5) return code;
    return "•••••" + code.slice(-5);
  };

  const isContractActive = contractStatus === "active";
  const hasSignedDoc = !!signedDocumentId;
  const activeSeatNumbers = new Set(activeIssuances.map((i) => i.seat_number));
  const allSeatsFilled = activeIssuances.length >= seats;
  const canIssue = isContractActive && !allSeatsFilled && hasSignedDoc;

  // Build seat rows: combine issued + unissued
  const buildSeatRows = () => {
    const rows: { seatNumber: number; issuance?: VoucherIssuance; isUnissued: boolean }[] = [];

    for (const iss of activeIssuances) {
      rows.push({ seatNumber: iss.seat_number, issuance: iss, isUnissued: false });
    }

    if (isContractActive && hasSignedDoc) {
      for (let s = 1; s <= seats; s++) {
        if (!activeSeatNumbers.has(s)) {
          rows.push({ seatNumber: s, isUnissued: true });
        }
      }
    }

    rows.sort((a, b) => a.seatNumber - b.seatNumber);
    return rows;
  };

  const historyIssuances = issuances.filter((i) => !i.is_active);
  const expectedValidity = tenureMonths ? tenureMonths * 30 : null;

  const issueTooltip = !isContractActive
    ? "Contract must be active to issue vouchers"
    : !hasSignedDoc
    ? "Upload signed contract before issuing vouchers"
    : allSeatsFilled
    ? "All seats have been filled"
    : "Issue vouchers for remaining seats";

  // Suppress unused var warnings
  void startDate;
  void endDate;
  void leadEmail;

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
          {issuances.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setShowHistory(!showHistory)} className="text-xs">
              {showHistory ? <EyeOff className="mr-1 h-3.5 w-3.5" /> : <Eye className="mr-1 h-3.5 w-3.5" />}
              {showHistory ? "Hide History" : "Show History"}
            </Button>
          )}
          {canIssue && (
            <Button size="sm" onClick={handleIssueAllRemaining} disabled={issuingAll} title={issueTooltip}>
              {issuingAll ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Issuing...</>
              ) : (
                <><Wifi className="mr-2 h-4 w-4" />Issue All Remaining</>
              )}
            </Button>
          )}
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
                  Matched validity: <Badge variant="outline" className="text-xs">{getValidityLabel(matchInfo.matched_validity_days)}</Badge>
                </p>
              )}
            </div>
          </div>
        )}

        {/* Expected validity + inventory check */}
        {expectedValidity && isContractActive && !allSeatsFilled && !loading && (
          <div className="mb-4 rounded-md border p-3 space-y-2">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              Required voucher type: <Badge variant="outline" className="text-xs ml-1 font-medium">{getValidityLabel(expectedValidity)}</Badge>
              <span className="ml-1">(based on {tenureMonths}-month tenure)</span>
            </div>
            {inventoryCheck.loading ? (
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> Checking voucher inventory...
              </div>
            ) : inventoryCheck.matchedGroup ? (
              inventoryCheck.compatible ? (
                <div className="text-xs text-green-700 flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {inventoryCheck.availableCount} compatible vouchers available ({inventoryCheck.matchedGroup}) — need {inventoryCheck.neededCount}
                </div>
              ) : (
                <div className="text-xs text-amber-700 flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Only {inventoryCheck.availableCount} compatible vouchers ({inventoryCheck.matchedGroup}) — need {inventoryCheck.neededCount}. Upload more before issuing.
                </div>
              )
            ) : inventoryCheck.neededCount > 0 ? (
              <div className="text-xs text-red-600 flex items-center gap-1">
                <XCircle className="h-3.5 w-3.5" />
                No compatible vouchers found. Upload {getValidityLabel(expectedValidity)} vouchers before issuing.
              </div>
            ) : null}
          </div>
        )}

        {loading ? (
          <TableSkeleton rows={3} />
        ) : activeIssuances.length === 0 && (!isContractActive || !hasSignedDoc) ? (
          <EmptyState
            icon={Ticket}
            title="No vouchers issued"
            description={
              !isContractActive
                ? "Activate the contract to issue vouchers."
                : "Upload a signed contract document to enable voucher issuance."
            }
          />
        ) : (activeIssuances.length > 0 || (isContractActive && hasSignedDoc)) ? (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-3 text-left font-medium w-8"></th>
                  <th className="px-3 py-3 text-center font-medium w-16">Seat</th>
                  <th className="px-3 py-3 text-left font-medium">Occupant Email</th>
                  <th className="px-3 py-3 text-left font-medium">Voucher Code</th>
                  <th className="px-3 py-3 text-left font-medium hidden sm:table-cell">Validity</th>
                  <th className="px-3 py-3 text-left font-medium hidden lg:table-cell">Email Status</th>
                  <th className="px-3 py-3 text-left font-medium">Status</th>
                  <th className="px-3 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {buildSeatRows().map((row) => {
                  const { seatNumber, issuance, isUnissued } = row;

                  if (isUnissued) {
                    const draftEmail = unissuedEmails[seatNumber] || "";
                    const hasEmail = draftEmail.trim().length > 0;
                    return (
                      <tr key={`empty-${seatNumber}`} className="border-b bg-muted/10">
                        <td className="px-3 py-3"></td>
                        <td className="px-3 py-3 text-center font-medium text-muted-foreground">{seatNumber}</td>
                        <td className="px-3 py-3">
                          <Input
                            type="email"
                            value={draftEmail}
                            onChange={(e) => setUnissuedEmails((prev) => ({ ...prev, [seatNumber]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter" && hasEmail) handleIssueSeat(seatNumber); }}
                            placeholder="email@example.com"
                            className="h-7 text-xs w-48"
                          />
                        </td>
                        <td className="px-3 py-3 text-muted-foreground text-xs italic" colSpan={3}>—</td>
                        <td className="px-3 py-3">
                          <Badge variant="outline" className="text-xs text-muted-foreground">Unissued</Badge>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleIssueSeat(seatNumber)}
                            disabled={!hasEmail || issuingSeat === seatNumber || issuingAll}
                            className="text-xs h-7"
                            title={hasEmail ? `Issue voucher for ${draftEmail.trim()}` : "Enter email first"}
                          >
                            {issuingSeat === seatNumber ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <><Ticket className="mr-1 h-3 w-3" />Issue</>
                            )}
                          </Button>
                        </td>
                      </tr>
                    );
                  }

                  if (!issuance) return null;

                  const isExpanded = expandedRows.has(issuance.id);
                  const voucherStatus = issuance.voucher?.status || "issued";
                  const metadata = issuance.voucher?.metadata || {};
                  const hasMetadata = Object.keys(metadata).length > 0;
                  const isEditingThis = editingEmail === issuance.id;

                  return (
                    <Fragment key={issuance.id}>
                      <tr className={`border-b hover:bg-muted/30 transition-colors ${!issuance.is_active ? "opacity-50" : ""}`}>
                        <td className="px-3 py-3">
                          {hasMetadata ? (
                            <button onClick={() => toggleRow(issuance.id)} className="text-muted-foreground hover:text-foreground">
                              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </button>
                          ) : null}
                        </td>
                        <td className="px-3 py-3 text-center font-medium">{issuance.seat_number}</td>
                        <td className="px-3 py-3">
                          {isEditingThis ? (
                            <div className="flex items-center gap-1">
                              <Input
                                type="email"
                                value={emailDraft}
                                onChange={(e) => setEmailDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleSaveEmail(issuance.id);
                                  if (e.key === "Escape") { setEditingEmail(null); setEmailDraft(""); }
                                }}
                                placeholder="email@example.com"
                                className="h-7 text-xs w-44"
                                autoFocus
                                disabled={savingEmail}
                              />
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => handleSaveEmail(issuance.id)} disabled={savingEmail}>
                                {savingEmail ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3 text-green-600" />}
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => { setEditingEmail(null); setEmailDraft(""); }}>
                                <XCircle className="h-3 w-3 text-red-500" />
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1">
                              {issuance.seat_occupant_email ? (
                                <span className="text-xs">{issuance.seat_occupant_email}</span>
                              ) : (
                                <span className="text-xs text-muted-foreground italic">No email</span>
                              )}
                              {issuance.is_active && (
                                <button
                                  onClick={() => { setEditingEmail(issuance.id); setEmailDraft(issuance.seat_occupant_email || ""); }}
                                  className="text-muted-foreground hover:text-foreground ml-1"
                                  title="Edit email"
                                >
                                  <Pencil className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{maskCode(issuance.voucher?.voucher_code || "-")}</td>
                        <td className="px-3 py-3 hidden sm:table-cell">
                          <Badge variant="outline" className="text-xs">{getValidityLabel(issuance.voucher?.validity_days)}</Badge>
                        </td>
                        <td className="px-3 py-3 hidden lg:table-cell">
                          {issuance.emailed_at ? (
                            <span className="text-xs text-green-700 flex items-center gap-1">
                              <Mail className="h-3 w-3" />Sent {formatDate(issuance.emailed_at)}
                            </span>
                          ) : issuance.is_active ? (
                            <span className="text-xs text-muted-foreground">Not sent</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <Badge variant="secondary" className={VOUCHER_STATUS_COLORS[voucherStatus] || "bg-gray-100 text-gray-800"}>
                            {VOUCHER_STATUS_LABELS[voucherStatus] || voucherStatus}
                          </Badge>
                          {!issuance.is_active && <span className="ml-1 text-xs text-red-600">(Replaced)</span>}
                        </td>
                        <td className="px-3 py-3 text-right">
                          {issuance.is_active && (
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0"
                                onClick={() => handleSendEmail(issuance.id, issuance.seat_occupant_email)}
                                disabled={sendingSeat === issuance.id || !issuance.seat_occupant_email}
                                title={issuance.seat_occupant_email ? `Send to ${issuance.seat_occupant_email}` : "Enter email first"}
                              >
                                {sendingSeat === issuance.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
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
                                  seatEmail: issuance.seat_occupant_email,
                                })}
                                title="Replace voucher"
                              >
                                <RefreshCw className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>

                      {isExpanded && (hasMetadata || issuance.revoke_reason) && (
                        <tr className="border-b bg-muted/10">
                          <td colSpan={8} className="px-3 py-3">
                            <div className="pl-8 space-y-1">
                              {hasMetadata && (
                                <>
                                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Metadata</p>
                                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                                    {Object.entries(metadata).map(([key, value]) => (
                                      <div key={key} className="text-xs">
                                        <span className="text-muted-foreground">{key}:</span>{" "}
                                        <span className="font-medium">{typeof value === "object" ? JSON.stringify(value) : String(value)}</span>
                                      </div>
                                    ))}
                                  </div>
                                </>
                              )}
                              {issuance.revoke_reason && (
                                <div className="mt-2 text-xs"><span className="text-red-600 font-medium">Revoke Reason:</span> {issuance.revoke_reason}</div>
                              )}
                              {issuance.replaces_issuance_id && (
                                <div className="mt-1 text-xs text-muted-foreground">Replaces issuance: {issuance.replaces_issuance_id.slice(0, 8)}...</div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}

                {/* History rows */}
                {showHistory && historyIssuances.length > 0 && (
                  <>
                    <tr className="border-b bg-muted/30">
                      <td colSpan={8} className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Replacement History
                      </td>
                    </tr>
                    {historyIssuances.map((issuance) => (
                      <tr key={issuance.id} className="border-b opacity-50">
                        <td className="px-3 py-2"></td>
                        <td className="px-3 py-2 text-center font-medium text-muted-foreground">{issuance.seat_number}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{issuance.seat_occupant_email || "—"}</td>
                        <td className="px-3 py-2 font-mono text-xs line-through text-muted-foreground">{maskCode(issuance.voucher?.voucher_code || "-")}</td>
                        <td className="px-3 py-2 hidden sm:table-cell">
                          <Badge variant="outline" className="text-xs opacity-60">{getValidityLabel(issuance.voucher?.validity_days)}</Badge>
                        </td>
                        <td className="px-3 py-2 hidden lg:table-cell text-xs text-muted-foreground">
                          {issuance.emailed_at ? `Sent ${formatDate(issuance.emailed_at)}` : "—"}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="secondary" className="bg-red-100 text-red-800 text-xs">Revoked</Badge>
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                          {issuance.revoked_at ? formatDate(issuance.revoked_at) : ""}
                          {issuance.revoke_reason && (
                            <div className="text-xs text-red-500 truncate max-w-[120px]" title={issuance.revoke_reason}>{issuance.revoke_reason}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={Ticket}
            title="No vouchers issued"
            description="Issue vouchers for each seat to assign WiFi codes."
            actionLabel={canIssue ? "Issue All Vouchers" : undefined}
            onAction={canIssue ? handleIssueAllRemaining : undefined}
          />
        )}

        {/* Summary info */}
        {!loading && activeIssuances.length > 0 && (
          <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
            <span>{activeIssuances.length} of {seats} seat{seats !== 1 ? "s" : ""} filled</span>
            {!allSeatsFilled && isContractActive && (
              <span className="text-orange-600">{seats - activeIssuances.length} seat{seats - activeIssuances.length !== 1 ? "s" : ""} remaining</span>
            )}
            {historyIssuances.length > 0 && !showHistory && (
              <span className="text-muted-foreground">{historyIssuances.length} replaced voucher{historyIssuances.length !== 1 ? "s" : ""}</span>
            )}
          </div>
        )}
      </CardContent>

      {/* Replace Dialog */}
      <VoucherReplaceDialog
        open={replaceDialog.open}
        onOpenChange={(open) => setReplaceDialog((prev) => ({ ...prev, open }))}
        contractId={contractId}
        issuanceId={replaceDialog.issuanceId}
        seatNumber={replaceDialog.seatNumber}
        currentVoucherCode={replaceDialog.voucherCode}
        seatEmail={replaceDialog.seatEmail}
        onSuccess={fetchIssuances}
      />
    </Card>
  );
}
