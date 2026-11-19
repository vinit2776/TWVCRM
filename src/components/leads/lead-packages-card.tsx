"use client";

/**
 * LeadPackagesCard — every prepaid package this lead can use (their own, and
 * ones bought for their company), with balance and validity, and a statement
 * of how each was used that can be downloaded or emailed to the customer.
 */

import { PackageTip } from "@/components/packages/package-tips";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FileDown, Loader2, Mail, Ticket } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";

interface LeadPackage {
  id: string;
  name: string;
  credit_type: "hours" | "days" | "bookings";
  total_credits: number;
  credits_remaining: number;
  expires_at: string;
  status: "active" | "pending_payment" | "exhausted" | "expired";
  for_company: boolean;
  company_name: string | null;
  cancellation_window_hours: number | null;
  locations: string[];
}

const UNIT = { hours: "hrs", days: "days", bookings: "bookings" } as const;
const STATUS_LABEL: Record<LeadPackage["status"], string> = {
  active: "Active",
  pending_payment: "Awaiting payment",
  exhausted: "Used up",
  expired: "Expired",
};
const STATUS_CLASS: Record<LeadPackage["status"], string> = {
  active: "bg-green-100 text-green-800",
  pending_payment: "bg-amber-100 text-amber-800",
  exhausted: "bg-gray-100 text-gray-700",
  expired: "bg-gray-100 text-gray-700",
};

interface Props {
  leadId: string;
  /** Pre-fills the email confirmation. Staff can change it before sending. */
  leadEmail?: string | null;
}

export function LeadPackagesCard({ leadId, leadEmail }: Props) {
  const [packages, setPackages] = useState<LeadPackage[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [emailFor, setEmailFor] = useState<LeadPackage | null>(null);
  const [emailTo, setEmailTo] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let ignore = false;
    fetch(`/api/leads/${leadId}/packages`)
      .then((r) => r.json())
      .then((j) => { if (!ignore) setPackages(j.data ?? []); })
      .catch(() => { if (!ignore) setPackages([]); });
    return () => { ignore = true; };
  }, [leadId]);

  async function download(p: LeadPackage) {
    setBusyId(p.id);
    try {
      const res = await fetch(`/api/prepaid-purchases/${p.id}/statement`);
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error || "Could not build the statement");
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || "Package-Statement.pdf";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not build the statement");
    } finally {
      setBusyId(null);
    }
  }

  async function sendEmail() {
    if (!emailFor) return;
    if (!emailTo.trim()) { toast.error("Enter the email address to send the statement to"); return; }
    setSending(true);
    try {
      const res = await fetch(`/api/prepaid-purchases/${emailFor.id}/statement/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: emailTo.trim() }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error || "Could not send the email");
      toast.success(`Statement emailed to ${j.data.sent_to}`);
      setEmailFor(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the email");
    } finally {
      setSending(false);
    }
  }

  if (packages === null || packages.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Ticket className="h-4 w-4 text-teal-600" />
          Packages
          <span className="ml-auto text-xs font-normal text-muted-foreground">{packages.length} total</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <PackageTip>The statement lists each booking used, each cancellation with hours before start, and whether hours came back.</PackageTip>
        {packages.map((p) => {
          const inactive = p.status === "expired" || p.status === "exhausted";
          const pct = p.total_credits > 0 ? Math.round((p.credits_remaining / p.total_credits) * 100) : 0;
          return (
            <div key={p.id} className={`rounded-md border p-3 space-y-2 ${inactive ? "opacity-75" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium truncate">{p.name}</p>
                  {p.for_company && (
                    <p className="text-xs text-muted-foreground">Bought for {p.company_name}, usable by all contacts</p>
                  )}
                </div>
                <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${STATUS_CLASS[p.status]}`}>{STATUS_LABEL[p.status]}</span>
              </div>
              <div className="h-1.5 rounded bg-muted overflow-hidden" aria-hidden="true">
                <div className="h-full bg-teal-600" style={{ width: `${pct}%` }} />
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{p.credits_remaining} of {p.total_credits} {UNIT[p.credit_type]} left</span>
                <span>{p.status === "expired" ? "Expired" : "Expires"} {formatDate(p.expires_at)}</span>
              </div>
              {p.locations.length > 0 && <p className="text-xs text-muted-foreground">Valid at {p.locations.join(", ")}</p>}
              <div className="flex gap-2 pt-1">
                <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busyId === p.id} onClick={() => download(p)}>
                  {busyId === p.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <FileDown className="mr-1 h-3 w-3" />}
                  Statement
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setEmailFor(p); setEmailTo(leadEmail ?? ""); }}>
                  <Mail className="mr-1 h-3 w-3" />
                  Email
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>

      <Dialog open={!!emailFor} onOpenChange={(o) => { if (!o) setEmailFor(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Email package statement</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              The statement for {emailFor?.name} will be sent as a PDF to the address below. Check it before sending.
            </p>
            <div className="space-y-2">
              <Label>Send to</Label>
              <Input type="email" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="name@company.com" />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEmailFor(null)} disabled={sending}>Cancel</Button>
              <Button onClick={sendEmail} disabled={sending}>
                {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Send statement
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
