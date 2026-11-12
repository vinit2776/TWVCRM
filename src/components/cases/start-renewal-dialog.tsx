"use client";

/**
 * Start renewal — the one action that offers a Virtual Office case its next
 * term. A person picks the length and the escalation, sees exactly what will
 * be billed and to whom, and confirms the end date. It raises the renewal bill
 * and payment link; the case only moves to its new term once that is paid.
 *
 * Nothing goes to the customer unless Email or WhatsApp is ticked, and both
 * start unticked. Razorpay's own notifications are off for these links, so an
 * unticked offer reaches nobody until someone shares the link.
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Copy, Loader2, Mail, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { VO_PURPOSE_LABELS } from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  RENEWAL_DURATIONS,
  RENEWAL_ESCALATION_MODES,
  RENEWAL_ESCALATION_MODE_LABELS,
  RENEWAL_GST_PERCENT,
  renewalOffer,
  type RenewalEscalationMode,
} from "@/lib/vo-renewal-offer";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Party {
  kind: "aggregator" | "client";
  name: string;
  email: string | null;
  phone: string | null;
}

interface Setup {
  caseNumber: string;
  clientName: string;
  purpose: string;
  status: string;
  endDate: string;
  currentFee: number;
  tenureMonths: number;
  agreedEscalationPercentage: number;
  billing: Party;
  headsUp: Party | null;
  blocked: string | null;
  postpaid: boolean;
  startable: boolean;
  /** staging_none: no Razorpay on staging, so the bill is raised without a link. */
  paymentLinks: "available" | "missing" | "staging_none";
  openBills: { id: string; statement_number: string | null; total_amount: number; locked: string | null }[];
}

interface Result {
  piNumber: string;
  paymentLink: string | null;
  total: number;
  termStart: string;
  termEnd: string;
  emailSent: boolean;
  headsUpSent: boolean;
  whatsAppSent: boolean;
  sentTo: string | null;
}

function Line({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? "font-semibold" : "text-xs"}`}>
      <span className={strong ? "" : "text-muted-foreground"}>{label}</span>
      <span className="tabular-nums text-right">{value}</span>
    </div>
  );
}

export function StartRenewalDialog({
  caseId, open, onClose, onStarted,
}: {
  caseId: string;
  open: boolean;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const [duration, setDuration] = useState<number>(12);
  const [mode, setMode] = useState<RenewalEscalationMode>("agreed");
  const [customPct, setCustomPct] = useState("");
  const [reason, setReason] = useState("");
  const [sendEmail, setSendEmail] = useState(false);
  const [sendWhatsApp, setSendWhatsApp] = useState(false);
  const [cc, setCc] = useState<string[]>([]);
  const [ccInput, setCcInput] = useState("");
  const [endConfirmed, setEndConfirmed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setSetup(null);
    setResult(null);
    setSendEmail(false);
    setSendWhatsApp(false);
    setCc([]);
    setCcInput("");
    setCustomPct("");
    setReason("");
    setEndConfirmed(false);
    fetch(`/api/cases/${caseId}/start-renewal`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) { toast.error(j.error); onClose(); return; }
        const s = j.data as Setup;
        setSetup(s);
        setDuration((RENEWAL_DURATIONS as readonly number[]).includes(s.tenureMonths) ? s.tenureMonths : 12);
        setMode(s.agreedEscalationPercentage > 0 ? "agreed" : "none");
      })
      .catch(() => { toast.error("Could not load the renewal details"); onClose(); })
      .finally(() => setLoading(false));
  }, [open, caseId, onClose]);

  const offer = useMemo(() => {
    if (!setup) return null;
    return renewalOffer({
      currentFee: setup.currentFee,
      currentTenureMonths: setup.tenureMonths,
      agreedEscalationPercentage: setup.agreedEscalationPercentage,
      currentEnd: setup.endDate,
      durationMonths: duration,
      mode,
      customPercentage: Number(customPct) || 0,
    });
  }, [setup, duration, mode, customPct]);

  // A different term means a different end date to confirm.
  useEffect(() => { setEndConfirmed(false); }, [duration]);

  const addCc = () => {
    const email = ccInput.trim().toLowerCase();
    if (!email) return;
    if (!EMAIL_RE.test(email)) { toast.error("Invalid email address"); return; }
    if (cc.includes(email)) { toast.error("Already added"); return; }
    setCc((prev) => [...prev, email]);
    setCcInput("");
  };

  const lockedReason = setup?.openBills.find((b) => b.locked)?.locked ?? null;
  const cannotStartReason = !setup
    ? null
    : setup.postpaid
      ? "This case is billed monthly to a postpaid partner, so it has no renewal bill."
      : !setup.startable
        ? `A ${setup.status.replace(/_/g, " ")} case can't be renewed from here.`
        : setup.paymentLinks === "missing"
          ? "Online payments (Razorpay) aren't set up, so a renewal payment link can't be made."
          : setup.blocked ?? lockedReason ?? (setup.currentFee > 0 ? null : "This case has no fee on record. Set its rate first.");
  const customInvalid = mode === "custom" && (!(Number(customPct) > 0) || reason.trim().length < 10);
  const canSubmit = !!offer && !cannotStartReason && !customInvalid && endConfirmed && !submitting;

  const handleStart = async () => {
    if (!offer || !setup) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/start-renewal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          duration_months: duration,
          escalation_mode: mode,
          custom_percentage: mode === "custom" ? Number(customPct) : null,
          escalation_reason: mode === "custom" ? reason.trim() : null,
          confirm_end_date: offer.term.end,
          expected_total: offer.total,
          send_email: sendEmail,
          send_whatsapp: sendWhatsApp,
          cc: sendEmail ? cc : [],
        }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Could not start the renewal"); return; }
      const r = json.data as Result;
      setResult(r);
      if ((sendEmail && !r.emailSent) || (sendWhatsApp && !r.whatsAppSent)) {
        toast.warning("Renewal bill raised, but a message could not be delivered. Share the link below.");
      } else {
        toast.success("Renewal started");
      }
      onStarted();
    } catch {
      toast.error("Could not start the renewal");
    } finally {
      setSubmitting(false);
    }
  };

  const copyLink = async () => {
    if (!result?.paymentLink) return;
    try {
      await navigator.clipboard.writeText(result.paymentLink);
      toast.success("Payment link copied");
    } catch {
      toast.error("Could not copy the link");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Start renewal</DialogTitle>
          <DialogDescription>
            Raises the renewal bill and payment link. The new term begins only once it is paid.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}

        {result && (
          <div className="space-y-3 text-sm">
            <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 space-y-1.5 dark:bg-emerald-950/30">
              <p className="font-medium">Renewal bill {result.piNumber} raised</p>
              <Line label="New term" value={`${formatDate(result.termStart)} to ${formatDate(result.termEnd)}`} />
              <Line label="Total incl. GST" value={formatCurrency(result.total)} />
              <Line
                label="Sent"
                value={
                  [
                    result.emailSent ? `Email to ${result.sentTo}` : null,
                    result.headsUpSent ? "client copied" : null,
                    result.whatsAppSent ? "WhatsApp" : null,
                  ].filter(Boolean).join(", ") || "Nothing sent"
                }
              />
            </div>
            {result.paymentLink ? (
            <div className="space-y-1.5">
              <Label className="text-xs">Payment link</Label>
              <div className="flex gap-2">
                <Input readOnly value={result.paymentLink} className="text-xs" />
                <Button variant="outline" size="sm" onClick={copyLink} type="button">
                  <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Paid by this link, the case renews by itself. Any other payment is reported paid and
                verified by accounts.
              </p>
            </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No payment link here (staging has no Razorpay). Record or report a payment against the bill to renew the case.
              </p>
            )}
          </div>
        )}

        {setup && offer && !result && (
          <div className="space-y-4 text-sm">
            {cannotStartReason && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950/30 dark:text-red-200">
                {cannotStartReason}
              </div>
            )}

            <div className="rounded-md border p-3 space-y-1.5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{setup.clientName}</p>
                  <p className="text-xs text-muted-foreground">{setup.caseNumber}</p>
                </div>
                <Badge variant="outline" className="shrink-0 text-xs">
                  {VO_PURPOSE_LABELS[setup.purpose] ?? setup.purpose}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">The purpose stays the same at renewal.</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Term length</Label>
                <Select value={String(duration)} onValueChange={(v) => setDuration(Number(v))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {RENEWAL_DURATIONS.map((d) => (
                      <SelectItem key={d} value={String(d)}>{d} months</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Escalation</Label>
                <Select value={mode} onValueChange={(v) => setMode(v as RenewalEscalationMode)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {RENEWAL_ESCALATION_MODES.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m === "agreed"
                          ? `As agreed (${setup.agreedEscalationPercentage || 0}%)`
                          : RENEWAL_ESCALATION_MODE_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {mode === "custom" && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Custom escalation %</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step="0.5"
                    value={customPct}
                    onChange={(e) => setCustomPct(e.target.value)}
                    placeholder="e.g. 7.5"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Reason (kept in the audit trail)</Label>
                  <Textarea
                    rows={2}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why this differs from the agreed escalation"
                  />
                </div>
              </div>
            )}

            <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
              <Line label="Current term ends" value={formatDate(setup.endDate)} />
              <Line label="New term starts" value={`${formatDate(offer.term.start)} (the next day)`} />
              <Line label="New term ends" value={formatDate(offer.term.end)} />
              <Separator />
              <Line label={`Current fee (${setup.tenureMonths} months)`} value={formatCurrency(setup.currentFee)} />
              {duration !== setup.tenureMonths && (
                <Line label={`Pro rata for ${duration} months`} value={formatCurrency(offer.baseFee)} />
              )}
              <Line
                label={offer.escalationPercentage > 0 ? `Escalation ${offer.escalationPercentage}%` : "Escalation"}
                value={offer.escalationPercentage > 0 ? `+${formatCurrency(offer.fee - offer.baseFee)}` : "None"}
              />
              <Line label={`Fee for the term`} value={formatCurrency(offer.fee)} />
              <Line label={`GST ${RENEWAL_GST_PERCENT}%`} value={formatCurrency(offer.gst)} />
              <Separator />
              <Line label="Total" value={formatCurrency(offer.total)} strong />
            </div>

            <div className="rounded-md border p-3 space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Billed to</p>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{setup.billing.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {[setup.billing.email, setup.billing.phone].filter(Boolean).join(" · ") || "No contact on file"}
                  </p>
                </div>
                <Badge variant="outline" className="shrink-0 text-xs">
                  {setup.billing.kind === "aggregator" ? "Partner" : "Client"}
                </Badge>
              </div>
              {setup.headsUp && (
                <p className="text-xs text-muted-foreground">
                  If emailed, {setup.headsUp.name} is copied {setup.headsUp.email ? `at ${setup.headsUp.email}` : "(no email on file)"}.
                </p>
              )}
            </div>

            {setup.openBills.length > 0 && !lockedReason && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                This replaces the unpaid renewal bill{setup.openBills.length > 1 ? "s" : ""}{" "}
                {setup.openBills.map((b) => `${b.statement_number ?? "(no number)"} for ${formatCurrency(b.total_amount)}`).join(", ")}.
                {" "}Its payment link stops working.
              </div>
            )}

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Send to the customer</p>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={sendEmail}
                  disabled={!setup.billing.email || setup.paymentLinks !== "available"}
                  onCheckedChange={(v) => setSendEmail(v === true)}
                />
                <span>Email{setup.billing.email ? ` to ${setup.billing.email}` : " (no email on file)"}</span>
              </label>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={sendWhatsApp}
                  disabled={!setup.billing.phone || setup.paymentLinks !== "available"}
                  onCheckedChange={(v) => setSendWhatsApp(v === true)}
                />
                <span>WhatsApp{setup.billing.phone ? ` to ${setup.billing.phone}` : " (no phone on file)"}</span>
              </label>
              {setup.paymentLinks === "staging_none" ? (
                <p className="text-xs text-muted-foreground">Staging has no Razorpay, so the bill is raised without a payment link and nothing can be sent.</p>
              ) : !sendEmail && !sendWhatsApp && (
                <p className="text-xs text-muted-foreground">Nothing is sent. You get the payment link to share yourself.</p>
              )}
              {sendEmail && (
                <div className="space-y-1.5">
                  {cc.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {cc.map((email) => (
                        <span key={email} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                          {email}
                          <button type="button" onClick={() => setCc((p) => p.filter((e) => e !== email))} className="text-muted-foreground hover:text-foreground">
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Input
                      type="email"
                      value={ccInput}
                      onChange={(e) => setCcInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addCc(); } }}
                      placeholder="CC an email (optional)"
                      className="text-sm"
                    />
                    <Button size="sm" variant="outline" onClick={addCc} type="button">
                      <Mail className="mr-1.5 h-3.5 w-3.5" /> Add
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <label className="flex items-start gap-2 rounded-md border p-3">
              <Checkbox checked={endConfirmed} onCheckedChange={(v) => setEndConfirmed(v === true)} className="mt-0.5" />
              <span>
                The new term runs {formatDate(offer.term.start)} to <strong>{formatDate(offer.term.end)}</strong>, whenever it is paid.
              </span>
            </label>
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={handleStart} disabled={!canSubmit}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {sendEmail || sendWhatsApp ? "Start renewal and send" : "Start renewal"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
