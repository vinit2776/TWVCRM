"use client";

/**
 * Voucher Issuance dialog — opens from the /vouchers list when admin clicks
 * an "Issued" row. Shows who the voucher was given to, which booking or
 * contract it belongs to, and tenure. Deep-link buttons jump straight to the
 * booking / contract / lead detail pages so admin can act on it.
 *
 * One voucher can have:
 *   - 1 active issuance (most common)
 *   - 0 active + 1+ revoked issuances (when re-uploaded into the pool)
 *   - 1 active + history of replaced ones (re-issued because of bad seat etc.)
 *
 * The dialog renders the active issuance prominently and any past issuances
 * collapsed below, oldest at the bottom.
 */

import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Loader2, ExternalLink, MapPin, Calendar, User, Building2, Mail, Phone,
  ScrollText, CalendarClock, ShieldOff, Hash,
} from "lucide-react";
import Link from "next/link";
import { formatDate, formatDateTime } from "@/lib/utils";

interface IssuanceRow {
  id: string;
  voucher_id: string;
  contract_id: string | null;
  booking_id: string | null;
  lead_id: string;
  seat_number: number;
  seat_occupant_email: string | null;
  emailed_at: string | null;
  issued_at: string;
  valid_from: string;
  valid_until: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  is_active: boolean;
  replaces_issuance_id: string | null;
  issuer: { id: string; full_name: string } | null;
  lead: { id: string; first_name: string; last_name: string; company: string | null; email: string | null; phone: string | null; mobile: string | null } | null;
  contract: { id: string; contract_number: string; status: string } | null;
  booking: {
    id: string; booking_number: string; booking_date: string;
    start_time: string; end_time: string; status: string;
    customer_type: string; guest_name: string | null;
  } | null;
}

interface VoucherSummary {
  id: string;
  voucher_code: string;
  status: string;
  validity_days: number | null;
  issued_at: string | null;
  location: { id: string; name: string; code: string } | null;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  voucherId: string | null;
}

export function VoucherIssuanceDialog({ open, onOpenChange, voucherId }: Props) {
  const [loading, setLoading] = useState(false);
  const [voucher, setVoucher] = useState<VoucherSummary | null>(null);
  const [issuances, setIssuances] = useState<IssuanceRow[]>([]);

  useEffect(() => {
    if (!open || !voucherId) {
      setVoucher(null); setIssuances([]); return;
    }
    setLoading(true);
    fetch(`/api/vouchers/${voucherId}/issuance`)
      .then((r) => r.json())
      .then((j) => {
        setVoucher(j.data?.voucher ?? null);
        setIssuances(j.data?.issuances ?? []);
      })
      .catch(() => { setVoucher(null); setIssuances([]); })
      .finally(() => setLoading(false));
  }, [open, voucherId]);

  const active = issuances.find((i) => i.is_active) ?? null;
  const past = issuances.filter((i) => !i.is_active);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 gap-0 max-h-[90vh] flex flex-col">
        <DialogHeader className="px-5 pt-5 pb-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <span>Voucher</span>
            {voucher?.voucher_code && (
              <code className="font-mono text-base bg-muted px-2 py-0.5 rounded">{voucher.voucher_code}</code>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Issuance details + linked booking / contract
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : !voucher ? (
            <p className="text-sm text-muted-foreground italic py-8 text-center">
              Voucher not found.
            </p>
          ) : (
            <>
              {/* Voucher meta */}
              <div className="rounded-lg border bg-muted/20 p-3 text-xs space-y-1.5">
                <Row icon={<MapPin className="h-3.5 w-3.5" />} label="Location"
                     value={voucher.location ? `${voucher.location.name} (${voucher.location.code})` : "—"} />
                <Row icon={<Calendar className="h-3.5 w-3.5" />} label="Validity"
                     value={voucher.validity_days != null ? `${voucher.validity_days} day${voucher.validity_days === 1 ? "" : "s"}` : "Unclassified"} />
                <Row icon={<Hash className="h-3.5 w-3.5" />} label="Status"
                     value={voucher.status} />
              </div>

              {/* Active issuance */}
              {active ? (
                <IssuanceCard row={active} variant="active" onClose={() => onOpenChange(false)} />
              ) : (
                <div className="rounded-lg border-2 border-dashed p-4 text-center text-sm text-muted-foreground italic">
                  No active issuance for this voucher.
                </div>
              )}

              {/* Past issuances — collapsible-style stack */}
              {past.length > 0 && (
                <section className="space-y-2">
                  <div className="text-[11px] uppercase text-muted-foreground font-medium">
                    Past issuances ({past.length})
                  </div>
                  {past.map((row) => (
                    <IssuanceCard key={row.id} row={row} variant="past" onClose={() => onOpenChange(false)} />
                  ))}
                </section>
              )}
            </>
          )}
        </div>

        <div className="border-t bg-background px-5 py-3 shrink-0 flex justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  icon, label, value,
}: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      {icon && <span className="text-muted-foreground">{icon}</span>}
      <span className="text-muted-foreground w-20 shrink-0">{label}</span>
      <span className="font-medium truncate">{value}</span>
    </div>
  );
}

function IssuanceCard({
  row, variant, onClose,
}: { row: IssuanceRow; variant: "active" | "past"; onClose: () => void }) {
  const isActive = variant === "active";
  const customerName = row.lead
    ? [row.lead.first_name, row.lead.last_name].filter(Boolean).join(" ")
    : row.booking?.guest_name || "—";
  const company = row.lead?.company;

  return (
    <div className={`rounded-lg border p-3 space-y-2.5 ${
      isActive ? "border-emerald-300 bg-emerald-50/30" : "border-muted bg-muted/20 opacity-80"
    }`}>
      {/* Header strip */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isActive ? (
            <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">Active</Badge>
          ) : row.revoked_at ? (
            <Badge variant="outline" className="border-red-300 text-red-700">
              <ShieldOff className="h-3 w-3 mr-1" /> Revoked
            </Badge>
          ) : (
            <Badge variant="outline">Replaced</Badge>
          )}
          <span className="text-xs text-muted-foreground">
            Seat #{row.seat_number}
          </span>
        </div>
        <span className="text-[11px] text-muted-foreground">{formatDate(row.issued_at)}</span>
      </div>

      {/* Customer */}
      <div className="space-y-1 text-sm">
        <div className="flex items-center gap-2">
          <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="font-medium">{customerName}</span>
        </div>
        {company && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Building2 className="h-3 w-3 shrink-0" />
            <span>{company}</span>
          </div>
        )}
        {row.seat_occupant_email && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Mail className="h-3 w-3 shrink-0" />
            <span className="truncate">{row.seat_occupant_email}</span>
            {row.emailed_at && (
              <span className="text-[10px] text-emerald-700 ml-auto whitespace-nowrap">
                ✓ emailed {formatDate(row.emailed_at)}
              </span>
            )}
          </div>
        )}
        {row.lead?.phone || row.lead?.mobile ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Phone className="h-3 w-3 shrink-0" />
            <span>{row.lead.mobile || row.lead.phone}</span>
          </div>
        ) : null}
      </div>

      {/* Tenure */}
      <div className="text-xs text-muted-foreground border-t pt-2 flex items-center gap-2">
        <CalendarClock className="h-3 w-3 shrink-0" />
        <span>
          {formatDate(row.valid_from)} → {formatDate(row.valid_until)}
        </span>
        {row.issuer?.full_name && (
          <span className="ml-auto truncate">by {row.issuer.full_name}</span>
        )}
      </div>

      {/* Linked booking / contract — deep links */}
      <div className="flex flex-wrap gap-1.5 pt-1">
        {row.booking && (
          <Link href={`/bookings/${row.booking.id}`} onClick={onClose}>
            <Button size="sm" variant="outline" className="h-7 text-xs">
              <CalendarClock className="h-3 w-3 mr-1" />
              {row.booking.booking_number}
              <ExternalLink className="h-3 w-3 ml-1.5 opacity-60" />
            </Button>
          </Link>
        )}
        {row.contract && (
          <Link href={`/contracts/${row.contract.id}`} onClick={onClose}>
            <Button size="sm" variant="outline" className="h-7 text-xs">
              <ScrollText className="h-3 w-3 mr-1" />
              {row.contract.contract_number}
              <ExternalLink className="h-3 w-3 ml-1.5 opacity-60" />
            </Button>
          </Link>
        )}
        {row.lead && (
          <Link href={`/leads/${row.lead.id}`} onClick={onClose}>
            <Button size="sm" variant="outline" className="h-7 text-xs">
              <User className="h-3 w-3 mr-1" />
              View lead
              <ExternalLink className="h-3 w-3 ml-1.5 opacity-60" />
            </Button>
          </Link>
        )}
      </div>

      {/* Revocation note */}
      {row.revoked_at && (
        <div className="text-xs text-red-700 bg-red-50 rounded-md p-2 border border-red-200">
          <span className="font-medium">Revoked {formatDateTime(row.revoked_at)}</span>
          {row.revoke_reason && <div className="text-muted-foreground mt-0.5">{row.revoke_reason}</div>}
        </div>
      )}
    </div>
  );
}
