"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Loader2, Send, ExternalLink, CheckCircle2, AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Contract } from "@/types";

interface Props {
  contract: Contract;
  userRole: string | null;
  onSuccess: () => void;
}

export function ContractProrataSection({ contract, userRole, onSuccess }: Props) {
  const [sending, setSending] = useState(false);
  const [waiveOpen, setWaiveOpen] = useState(false);
  const [waiveReason, setWaiveReason] = useState("");
  const [waiving, setWaiving] = useState(false);

  if (!contract.is_renewal || contract.prorata_payment_status === "not_applicable") {
    return null;
  }

  // Calculate display values
  const startDate = new Date(contract.start_date + "T00:00:00Z");
  const startDay = startDate.getUTCDate();
  const startMonth = startDate.getUTCMonth();
  const startYear = startDate.getUTCFullYear();
  const daysInMonth = new Date(Date.UTC(startYear, startMonth + 1, 0)).getUTCDate();
  const prorataDays = daysInMonth - startDay + 1;
  const periodEndDate = new Date(Date.UTC(startYear, startMonth + 1, 0)).toISOString().slice(0, 10);

  const monthlySubtotal = Number(contract.subtotal || 0);
  const taxPercentage = Number(contract.tax_percentage || 18);
  const prorataSubtotal = Math.round((monthlySubtotal / daysInMonth) * prorataDays * 100) / 100;
  const prorataTotal = Math.round(prorataSubtotal * (1 + taxPercentage / 100) * 100) / 100;

  const status = contract.prorata_payment_status as string;

  const handleSendPI = async () => {
    setSending(true);
    try {
      const res = await fetch(`/api/contracts/${contract.id}/prorata-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.noContact) {
          toast.warning("PI created but no email/phone on file — client will need to be contacted manually.");
        } else if (data.emailSkipped) {
          toast.success("PI created. Email skipped (no contact).");
        } else {
          toast.success(`PI sent to ${data.emailedTo}`);
        }
        onSuccess();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to send PI");
      }
    } finally {
      setSending(false);
    }
  };

  const handleWaive = async () => {
    if (!waiveReason.trim()) {
      toast.error("Waiver reason is required");
      return;
    }
    setWaiving(true);
    try {
      const res = await fetch(`/api/contracts/${contract.id}/prorata-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waive: true, waive_reason: waiveReason.trim() }),
      });
      if (res.ok) {
        toast.success("Pro-rata collection waived");
        setWaiveOpen(false);
        setWaiveReason("");
        onSuccess();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to waive");
      }
    } finally {
      setWaiving(false);
    }
  };

  return (
    <>
      <Card className={status === "pending" ? "border-amber-300" : status === "paid" ? "border-green-300" : "border-gray-200"}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between">
            <span>Pro-Rata Collection</span>
            {status === "pending" && (
              <Badge className="bg-amber-100 text-amber-800 border-amber-300">Pending</Badge>
            )}
            {status === "paid" && (
              <Badge className="bg-green-100 text-green-800 border-green-300">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Paid
              </Badge>
            )}
            {status === "waived" && (
              <Badge className="bg-gray-100 text-gray-700 border-gray-300">Waived</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Period</span>
            <span>{formatDate(contract.start_date)} – {formatDate(periodEndDate)}</span>
          </div>
          <Separator />
          <div className="flex justify-between">
            <span className="text-muted-foreground">Days</span>
            <span>{prorataDays} of {daysInMonth} days</span>
          </div>
          <Separator />
          <div className="flex justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span>{formatCurrency(prorataSubtotal)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">GST ({taxPercentage}%)</span>
            <span>{formatCurrency(prorataTotal - prorataSubtotal)}</span>
          </div>
          <Separator />
          <div className="flex justify-between font-semibold">
            <span>Total</span>
            <span>{formatCurrency(prorataTotal)}</span>
          </div>

          {status === "pending" && (
            <>
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex items-start gap-2">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <p>Contract cannot be activated until this pro-rata is paid or waived by admin.</p>
              </div>
              <div className="flex gap-2 pt-1">
                <Button size="sm" className="flex-1" onClick={handleSendPI} disabled={sending}>
                  {sending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
                  Send PI
                </Button>
                {userRole === "admin" && (
                  <Button size="sm" variant="outline" onClick={() => setWaiveOpen(true)}>
                    Waive
                  </Button>
                )}
              </div>
            </>
          )}

          {status === "paid" && (
            <p className="text-xs text-green-700 font-medium">
              ✓ Payment received — contract can be activated
            </p>
          )}

          {status === "waived" && (
            <p className="text-xs text-muted-foreground">
              Admin waived pro-rata collection for this renewal.
            </p>
          )}

          {/* If PI was already sent, show re-send option */}
          {status === "pending" && contract.prorata_billing_statement_id && (
            <div className="pt-1">
              <Button
                size="sm"
                variant="ghost"
                className="w-full text-xs text-muted-foreground"
                onClick={() => window.open(`/billing/${contract.prorata_billing_statement_id}`, "_blank")}
              >
                <ExternalLink className="mr-1.5 h-3 w-3" />
                View Statement
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={waiveOpen} onOpenChange={setWaiveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Waive Pro-Rata Collection</DialogTitle>
            <DialogDescription>
              This will allow the renewal contract to be activated without collecting the{" "}
              {formatCurrency(prorataTotal)} pro-rata for {formatDate(contract.start_date)} – {formatDate(periodEndDate)}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium">Reason <span className="text-destructive">*</span></label>
            <input
              type="text"
              value={waiveReason}
              onChange={(e) => setWaiveReason(e.target.value)}
              placeholder="e.g. Collected offline / already included in deposit"
              className="w-full text-sm border rounded px-3 py-1.5"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWaiveOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={!waiveReason.trim() || waiving}
              onClick={handleWaive}
            >
              {waiving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Waive Collection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
