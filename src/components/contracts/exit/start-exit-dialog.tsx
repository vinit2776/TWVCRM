"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { daysBetween, isEarlyExit, istDateOf } from "@/lib/contract-exit";
import { formatDate } from "@/lib/utils";

interface Props {
  contractId: string;
  contractNumber: string;
  endDate: string | null;
  lockInMonths?: number | null;
  noticePeriodMonths?: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: () => void;
}

export function StartExitDialog({ contractId, contractNumber, endDate, lockInMonths, noticePeriodMonths, open, onOpenChange, onStarted }: Props) {
  const today = istDateOf(new Date());
  const [noticeOn, setNoticeOn] = useState(today);
  const [lastDay, setLastDay] = useState(today);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const early = !!lastDay && isEarlyExit(lastDay, endDate);
  const noticeDays = noticeOn && lastDay && lastDay >= noticeOn ? daysBetween(noticeOn, lastDay) : null;

  const submit = async () => {
    if (!reason.trim()) { toast.error("Enter a reason"); return; }
    setSaving(true);
    const res = await fetch(`/api/contracts/${contractId}/exit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notice_received_on: noticeOn, last_day: lastDay, reason: reason.trim() }),
    });
    setSaving(false);
    if (res.ok) {
      toast.success("Exit started. The team has been notified.");
      setReason("");
      onOpenChange(false);
      onStarted();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Couldn't start the exit");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Start exit for {contractNumber}</DialogTitle>
          <DialogDescription>
            Records the customer&apos;s notice. Door access and seats stay on until you complete the exit.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="exit-notice">Notice received on</Label>
              <Input id="exit-notice" type="date" value={noticeOn} onChange={(e) => setNoticeOn(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exit-last">Last day</Label>
              <Input id="exit-last" type="date" min={noticeOn} value={lastDay} onChange={(e) => setLastDay(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exit-reason">Reason (internal)</Label>
            <Textarea id="exit-reason" rows={2} placeholder="Relocating to own office" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {early && endDate && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Early exit: the contract runs to {formatDate(endDate)}
              {lockInMonths ? ` with a ${lockInMonths}-month lock-in` : ""}
              {noticePeriodMonths && noticeDays !== null ? `. Notice period is ${noticePeriodMonths} month${noticePeriodMonths > 1 ? "s" : ""}; this notice gives ${noticeDays} days` : ""}.
              No penalty is added. The flag is kept on the record.
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            The customer is not contacted. An exit notice goes to all CRM users for their information.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !lastDay || !noticeOn}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Start exit and notify team
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
