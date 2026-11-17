"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  NOTICE_KIND_LABELS,
  NOTICE_STATUS_LABELS,
  noticeAttention,
  type NoticeKind,
  type NoticeStatus,
} from "@/lib/auto-renewal-notice";

interface Notice {
  id: string;
  kind: NoticeKind;
  status: NoticeStatus;
  subject: string;
  body: string;
  recipients: string[];
  current_rent: number;
  new_rent: number;
  escalation_percentage: number;
  renewal_start_date: string;
  send_on: string;
  approved_at: string | null;
  sent_at: string | null;
  failure_reason: string | null;
}

interface Props {
  contractId: string;
  termEndDate: string;
  canManage: boolean;
  /** Notice #1's day and the last day the customer can give notice, from the plan. */
  noticeOn: string;
  /** Staff-only: reasons the contract needs a person, and any deposit top-up the new rent brings. */
  holds: string[];
  depositTopUp: number;
  /** Called after anything changes so the card can refresh (e.g. the price lock). */
  onChanged: () => void;
}

const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

async function call(url: string, method: string, body: Record<string, unknown>): Promise<{ error: string | null; json: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => null);
    if (res.ok) return { error: null, json };
    return { error: (json?.error as string) || "Something went wrong", json: null };
  } catch {
    return { error: "Network error. Please try again.", json: null };
  }
}

export function ContractAutoRenewalNotices({ contractId, termEndDate, canManage, noticeOn, holds, depositTopUp, onChanged }: Props) {
  const [mode, setMode] = useState<string>("dry_run");
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [recipients, setRecipients] = useState("");
  const [confirmSend, setConfirmSend] = useState(false);

  const base = `/api/contracts/${contractId}/auto-renewal/notices`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(base);
      if (!res.ok) return setNotices(null);
      const json = await res.json();
      if (!json.data) return setNotices(null);
      setMode(json.data.mode);
      setNotices(json.data.notices as Notice[]);
    } catch {
      setNotices(null);
    }
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  if (notices === null) return null;

  const today = todayIst();
  // Only this term's notices; a cancelled one is history and a new one can replace it.
  const mine = notices.filter((n) => n.status !== "cancelled");
  const hasRateNotice = mine.some((n) => n.kind === "notice");
  const open = mine.find((n) => n.id === openId) ?? null;

  const openNotice = (n: Notice) => {
    setSubject(n.subject);
    setBody(n.body);
    setRecipients(n.recipients.join(", "));
    setConfirmSend(false);
    setOpenId(n.id);
  };

  const recipientList = recipients.split(/[,;\s]+/).map((r) => r.trim()).filter(Boolean);
  const dirty =
    !!open && (subject !== open.subject || body !== open.body || recipientList.join(",") !== open.recipients.join(","));
  const editable = !!open && open.status !== "sent" && open.status !== "sending";

  const patch = async (action: string, extra: Record<string, unknown> = {}, ok?: string) => {
    if (!open) return false;
    setBusy(true);
    const r = await call(`${base}/${open.id}`, "PATCH", { action, ...extra });
    setBusy(false);
    if (r.error) {
      toast.error(r.error);
      // A refused send may still have saved the edits, so show what is really stored.
      await load();
      return false;
    }
    if (ok) toast.success(ok);
    await load();
    onChanged();
    return true;
  };

  const edits = { subject: subject.trim(), body: body.trim(), recipients: recipientList };

  const prepare = async (kind: NoticeKind) => {
    setBusy(true);
    const r = await call(base, "POST", { kind });
    setBusy(false);
    if (r.error) return toast.error(r.error);
    toast.success("Draft prepared. Nothing has been sent.");
    await load();
    const created = r.json?.data as Notice | undefined;
    if (created) openNotice(created);
  };

  const late = mine.some((n) => noticeAttention(today, { kind: n.kind, status: n.status, sendOn: n.send_on }) === "late");
  const rateNoticeDue = !hasRateNotice && today >= noticeOn && today <= termEndDate;

  return (
    <div className="space-y-2 border-t pt-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <Mail className="h-3.5 w-3.5" />
        Customer notices
      </p>

      <p className="text-[11px] text-muted-foreground">
        {mode === "live"
          ? "The system prepares each notice as a draft. A person approves it, and it is emailed on its day."
          : "The system is not preparing or sending notices yet. You can still prepare one and send it by hand."}
      </p>

      {late && (
        <div className="flex gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>A notice has not gone out by its day. Open it, check the draft, change anything you need and send it now.</p>
        </div>
      )}

      {mine.map((n) => {
        const attention = noticeAttention(today, { kind: n.kind, status: n.status, sendOn: n.send_on });
        return (
          <div key={n.id} className="rounded-md border px-3 py-2 text-xs space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{NOTICE_KIND_LABELS[n.kind]}</span>
              <Badge variant={n.status === "sent" ? "default" : "outline"} className="ml-auto text-[10px]">
                {attention === "late" && n.status !== "failed" ? "Late, not sent" : NOTICE_STATUS_LABELS[n.status]}
              </Badge>
            </div>
            <p className="text-muted-foreground">
              {n.status === "sent" && n.sent_at
                ? `Emailed ${formatDate(n.sent_at)} to ${n.recipients.join(", ")}`
                : `Goes out ${formatDate(n.send_on)} · ${formatCurrency(n.new_rent)} per month (+${n.escalation_percentage}%)`}
            </p>
            {n.status === "failed" && n.failure_reason && <p className="text-destructive">{n.failure_reason}</p>}
            <Button size="sm" variant="outline" className="h-7 w-full text-xs" onClick={() => openNotice(n)}>
              {n.status === "sent" ? "View" : canManage ? "Review and edit" : "View"}
            </Button>
          </div>
        );
      })}

      {canManage && !hasRateNotice && (
        <Button size="sm" variant={rateNoticeDue ? "default" : "outline"} className="w-full" disabled={busy} onClick={() => prepare("notice")}>
          {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Mail className="mr-1.5 h-3.5 w-3.5" />}
          Prepare the renewal notice
        </Button>
      )}

      <Dialog open={!!open} onOpenChange={(v) => !v && setOpenId(null)}>
        <DialogContent className="max-w-2xl">
          {open && (
            <>
              <DialogHeader>
                <DialogTitle>{NOTICE_KIND_LABELS[open.kind]}</DialogTitle>
                <DialogDescription>
                  Emailed to the customer. New rent {formatCurrency(open.new_rent)} per month from {formatDate(open.renewal_start_date)}; the price is
                  locked once this goes out. Goes out on {formatDate(open.send_on)} when approved.
                </DialogDescription>
              </DialogHeader>

              {(holds.length > 0 || depositTopUp > 0) && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-1">
                  {holds.length > 0 && <p><span className="font-semibold">Needs a person:</span> {holds.join(", ")}. The system will not send this while that stands.</p>}
                  {depositTopUp > 0 && (
                    <p>
                      <span className="font-semibold">Deposit top-up:</span> the new rent raises the security deposit by about {formatCurrency(depositTopUp)}. It is not
                      mentioned in this email and does not hold the renewal.
                    </p>
                  )}
                </div>
              )}

              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="n-to">To (comma separated)</Label>
                  <Input id="n-to" value={recipients} disabled={!editable || !canManage} onChange={(e) => setRecipients(e.target.value)} className="h-9" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="n-sub">Subject</Label>
                  <Input id="n-sub" value={subject} disabled={!editable || !canManage} onChange={(e) => setSubject(e.target.value)} className="h-9" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="n-body">Message</Label>
                  <Textarea id="n-body" rows={14} value={body} disabled={!editable || !canManage} onChange={(e) => setBody(e.target.value)} className="font-mono text-xs" />
                </div>
                {open.status === "failed" && open.failure_reason && <p className="text-xs text-destructive">{open.failure_reason}</p>}
              </div>

              {canManage && editable && (
                <DialogFooter className="flex-wrap gap-2 sm:justify-between">
                  <Button variant="ghost" className="text-destructive" disabled={busy} onClick={async () => { if (await patch("cancel", {}, "Notice cancelled")) setOpenId(null); }}>
                    Cancel this notice
                  </Button>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" disabled={busy || !dirty} onClick={() => patch("edit", edits, "Changes saved")}>
                      Save changes
                    </Button>
                    {open.status === "approved" ? (
                      <Button variant="outline" disabled={busy} onClick={() => patch("unapprove", {}, "Back to draft")}>
                        Take back approval
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={async () => {
                          if (dirty && !(await patch("edit", edits))) return;
                          if (await patch("approve", {}, `Approved. It goes out on ${formatDate(open.send_on)}.`)) setOpenId(null);
                        }}
                      >
                        Approve
                      </Button>
                    )}
                    {!confirmSend ? (
                      <Button disabled={busy} onClick={() => setConfirmSend(true)}>Send now</Button>
                    ) : (
                      <Button
                        variant="destructive"
                        disabled={busy}
                        onClick={async () => {
                          if (await patch("send", edits, "Emailed to the customer")) setOpenId(null);
                          else setConfirmSend(false);
                        }}
                      >
                        {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                        Confirm: email {recipientList.length || 0} {recipientList.length === 1 ? "address" : "addresses"} now
                      </Button>
                    )}
                  </div>
                </DialogFooter>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
