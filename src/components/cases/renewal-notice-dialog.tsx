"use client";

/**
 * Manual "Send renewal intimation".
 *
 * The deliberate counterpart to the renewal cron. Every existing case is
 * renewal_notices_enabled = false, because its expiry came from a backfill
 * rather than an agreement with anyone — so the cron can never notify them.
 * A person can, having looked at the case, which is what this is for.
 *
 * Shows exactly who will be written to before anything is sent: an
 * aggregator-billed case reaches the partner, with the end client copied
 * separately. Getting that wrong means soliciting a partner's customer, so it
 * is stated rather than implied.
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Send, X, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { formatCurrency, formatDate } from "@/lib/utils";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Party {
  kind: "aggregator" | "client";
  name: string;
  email: string | null;
  phone: string | null;
}

interface Preview {
  caseNumber: string;
  endDate: string;
  clientName: string;
  subtotal: number;
  total: number;
  escalationPercentage: number;
  billing: Party;
  headsUp: Party | null;
  blocked: string | null;
}

export function RenewalNoticeDialog({
  caseId, open, onClose, onSent,
}: {
  caseId: string;
  open: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [cc, setCc] = useState<string[]>([]);
  const [ccInput, setCcInput] = useState("");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setPreview(null);
    fetch(`/api/cases/${caseId}/renewal-notice`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) { toast.error(j.error); onClose(); return; }
        setPreview(j.data as Preview);
      })
      .catch(() => { toast.error("Could not prepare the renewal notice"); onClose(); })
      .finally(() => setLoading(false));
  }, [open, caseId, onClose]);

  const addCc = () => {
    const email = ccInput.trim().toLowerCase();
    if (!email) return;
    if (!EMAIL_RE.test(email)) { toast.error("Invalid email address"); return; }
    if (cc.includes(email)) { toast.error("Already added"); return; }
    setCc((prev) => [...prev, email]);
    setCcInput("");
  };

  const handleSend = async () => {
    setSending(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/renewal-notice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cc }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to send"); return; }
      toast.success(
        json.data?.headsUpTo
          ? `Renewal notice sent to ${json.data.sentTo}, client copied at ${json.data.headsUpTo}`
          : `Renewal notice sent to ${json.data?.sentTo}`,
      );
      setCc([]);
      onSent();
      onClose();
    } catch {
      toast.error("Failed to send the renewal notice");
    } finally {
      setSending(false);
    }
  };

  const cannotSend = !!preview?.blocked || !preview?.billing.email;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send renewal intimation</DialogTitle>
          <DialogDescription>
            Raises a renewal proforma with a payment link and emails it. Nothing is sent until
            you confirm.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Preparing…
          </div>
        )}

        {preview && (
          <div className="space-y-3 text-sm">
            {preview.blocked && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                {preview.blocked}
              </div>
            )}

            <div className="rounded-md border p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Notice and payment link go to
              </p>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{preview.billing.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {preview.billing.email || "No email on file"}
                  </p>
                </div>
                <Badge variant="outline" className="shrink-0 text-xs">
                  {preview.billing.kind === "aggregator" ? "Aggregator" : "Client"}
                </Badge>
              </div>
              {preview.billing.kind === "aggregator" && (
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">On behalf of</span>
                  <span>{preview.clientName} · {preview.caseNumber}</span>
                </div>
              )}
            </div>

            {preview.headsUp && (
              <div className="rounded-md border p-3 space-y-1">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Client also copied
                </p>
                <p className="font-medium">{preview.headsUp.name}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {preview.headsUp.email || "No email on file — cannot be copied"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Receives the same amount and payment link, so they can renew directly if the
                  partner does not.
                </p>
              </div>
            )}

            <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Current term ends</span>
                <span>{formatDate(preview.endDate)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">License fee</span>
                <span className="tabular-nums">{formatCurrency(preview.subtotal)}</span>
              </div>
              {preview.escalationPercentage > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Includes agreed escalation</span>
                  <span>{preview.escalationPercentage}%</span>
                </div>
              )}
              <Separator />
              <div className="flex justify-between font-semibold">
                <span>Total incl. GST</span>
                <span className="tabular-nums">{formatCurrency(preview.total)}</span>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                CC (optional)
              </p>
              {cc.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {cc.map((email) => (
                    <span key={email} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                      {email}
                      <button onClick={() => setCc((p) => p.filter((e) => e !== email))} className="text-muted-foreground hover:text-foreground">
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <input
                  type="email"
                  value={ccInput}
                  onChange={(e) => setCcInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addCc(); } }}
                  placeholder="Add an email and press Enter"
                  className="flex-1 text-sm border rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <Button size="sm" variant="outline" onClick={addCc} type="button">
                  <Mail className="mr-1.5 h-3.5 w-3.5" /> Add
                </Button>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSend} disabled={sending || loading || cannotSend}>
            {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            Send intimation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
