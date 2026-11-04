"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, ChevronRight, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency, formatDate } from "@/lib/utils";

interface PendingBookingPayment {
  id: string;
  booking_id: string;
  booking_number: string | null;
  booking_date: string | null;
  customer: string;
  amount: number;
  payment_reference: string | null;
  screenshot_path: string | null;
  created_at: string;
  reported_by: string | null;
}

interface Props {
  /** Fires after a payment is verified or rejected so the tab count can refresh. */
  onChanged?: () => void;
}

/**
 * Tally Inbox → "To verify": UPI payments reported against a booking.
 *
 * Booking payments are not payment reports (those are contract / invoice /
 * deposit only), so they get their own list. A row opens a review panel with
 * the uploaded proof and the payment details; Verify and Reject live there, so
 * accounts always have the proof in front of them when they decide. Both reuse
 * PATCH /api/booking-payments/[id] — the same call the booking page makes — so
 * a verified payment still flips the booking to paid and raises its GST task.
 */
export function BookingPaymentsToVerify({ onChanged }: Props) {
  const [items, setItems] = useState<PendingBookingPayment[]>([]);
  // A snapshot, so the panel keeps showing the payment while the list reloads.
  const [opened, setOpened] = useState<PendingBookingPayment | null>(null);
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [proofState, setProofState] = useState<"idle" | "loading" | "failed">("idle");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/accounting/booking-payments-pending", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { items: PendingBookingPayment[] };
      setItems(json.items);
    } catch {
      // The section simply stays empty.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setProofUrl(null);
    if (!opened?.screenshot_path) {
      setProofState("idle");
      return;
    }
    let cancelled = false;
    setProofState("loading");
    createClient()
      .storage.from("crm-documents")
      .createSignedUrl(opened.screenshot_path, 3600)
      .then(({ data }) => {
        if (cancelled) return;
        if (data?.signedUrl) {
          setProofUrl(data.signedUrl);
          setProofState("idle");
        } else {
          setProofState("failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [opened]);

  const decide = useCallback(
    async (status: "verified" | "rejected") => {
      if (!opened) return;
      setBusy(true);
      try {
        const res = await fetch(`/api/booking-payments/${opened.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as { error?: string };
          toast.error(json.error ?? "Could not update the payment");
          return;
        }
        toast.success(status === "verified" ? "Payment verified" : "Payment rejected");
        setOpened(null);
        await load();
        onChanged?.();
      } finally {
        setBusy(false);
      }
    },
    [opened, load, onChanged],
  );

  if (items.length === 0) return null;

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Booking payments to verify</h3>
      <div className="rounded-lg border divide-y">
        {items.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setOpened(p)}
            className="w-full text-left grid grid-cols-1 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_24px] gap-1 md:gap-3 items-center px-3 py-2.5 text-sm hover:bg-muted/50 transition-colors"
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{p.customer}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {[p.booking_number, p.booking_date && formatDate(p.booking_date)].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className="min-w-0">
              <span className="block tabular-nums">{formatCurrency(p.amount)} · UPI</span>
              <span className="block truncate text-xs text-muted-foreground">
                {p.payment_reference ? `Ref ${p.payment_reference}` : "No reference given"}
              </span>
            </span>
            <span className="min-w-0">
              <span className="block truncate">{p.reported_by ?? "—"}</span>
              <span
                className={`inline-block mt-0.5 text-[11px] px-2 py-0.5 rounded-full border ${
                  p.screenshot_path
                    ? "bg-green-50 border-green-200 text-green-800"
                    : "bg-amber-50 border-amber-200 text-amber-800"
                }`}
              >
                {p.screenshot_path ? "Proof attached" : "No proof"}
              </span>
            </span>
            <ChevronRight className="hidden md:block h-4 w-4 text-muted-foreground" aria-hidden />
          </button>
        ))}
      </div>

      <Sheet open={!!opened} onOpenChange={(o) => { if (!o) setOpened(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto p-4">
          <SheetHeader className="mb-3">
            <SheetTitle className="text-base">{opened?.customer ?? "Booking payment"}</SheetTitle>
            <p className="text-xs text-muted-foreground">
              Check the proof and the bank statement, then verify or reject.
            </p>
          </SheetHeader>
          {opened && (
            <div className="space-y-4 text-sm">
              <dl className="space-y-1.5">
                {[
                  ["Amount", `${formatCurrency(opened.amount)} · UPI`],
                  ["Reference", opened.payment_reference ?? "None given"],
                  ["Reported", formatDate(opened.created_at)],
                  ["Reported by", opened.reported_by ?? "—"],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="text-right">{value}</dd>
                  </div>
                ))}
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Booking</dt>
                  <dd className="text-right">
                    <Link href={`/bookings/${opened.booking_id}`} className="text-teal-700 hover:underline">
                      {opened.booking_number ?? "Open booking"}
                    </Link>
                  </dd>
                </div>
              </dl>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Payment proof</p>
                {proofState === "loading" && (
                  <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin inline mr-1.5" />
                    Loading proof…
                  </div>
                )}
                {proofUrl && (
                  <a href={proofUrl} target="_blank" rel="noopener noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not optimisable */}
                    <img src={proofUrl} alt="UPI payment proof" className="w-full rounded-md border" />
                  </a>
                )}
                {proofState === "failed" && (
                  <p className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900">
                    Could not load the uploaded proof.
                  </p>
                )}
                {!opened.screenshot_path && (
                  <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    No proof was uploaded for this payment. Check the bank statement before verifying.
                  </p>
                )}
              </div>

              <div className="flex gap-2 pt-1">
                <Button
                  type="button"
                  className="flex-1 bg-teal-600 hover:bg-teal-700 text-white"
                  disabled={busy}
                  onClick={() => void decide("verified")}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Check className="h-4 w-4 mr-1" />}
                  Verify payment
                </Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => void decide("rejected")}>
                  <X className="h-4 w-4 mr-1" />
                  Reject
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
