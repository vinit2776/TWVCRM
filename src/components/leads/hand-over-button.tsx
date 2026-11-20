"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PersonName } from "@/components/shared/person-name";
import { useHandoverJobsEnabled } from "@/hooks/use-handover-jobs";
import { useCurrentUser } from "@/providers/current-user-provider";
import { useUsers } from "@/hooks/use-leads";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";
import { JOB_KINDS, JOB_KIND_LABELS, type JobKind } from "@/lib/handover-jobs";

const chip = (on: boolean) =>
  `rounded-full border px-4 py-2 text-sm min-h-10 ${on ? "border-primary bg-primary/10 font-semibold text-primary" : "hover:bg-muted"}`;

/**
 * "Hand over": give someone else a job on this lead (call back, book a tour, send a proposal, or
 * something else) with a note of what was discussed, so they do not start from nothing. Shown only
 * when handing over is switched on and the signed-in person works leads. Nothing is sent to the customer.
 */
export function HandOverButton({ leadId, leadName, onDone }: { leadId: string; leadName: string; onDone?: () => void }) {
  const enabled = useHandoverJobsEnabled();
  const { user } = useCurrentUser();
  const { users } = useUsers();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [kind, setKind] = useState<JobKind>("send_proposal");
  const [who, setWho] = useState("");
  const [title, setTitle] = useState("");
  const [discussed, setDiscussed] = useState("");
  const [proposalKind, setProposalKind] = useState("");
  const [due, setDue] = useState("");

  if (!enabled || !user?.role || !(LEAD_HANDLER_ROLES as readonly string[]).includes(user.role)) return null;
  const people = users.filter((u) => (LEAD_HANDLER_ROLES as readonly string[]).includes(u.role));
  const canSend = !!who && (kind !== "other" || title.trim() !== "");

  const send = async () => {
    if (!canSend || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/leads/${leadId}/handover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobs: [
            {
              kind,
              assigned_to: who,
              title: title.trim() || undefined,
              due_date: due || undefined,
              discussed: discussed.trim() || undefined,
              proposal_kind: kind === "send_proposal" ? proposalKind.trim() || undefined : undefined,
            },
          ],
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.details?.[0]?.message ?? json.error ?? "Could not hand it over");
        return;
      }
      toast.success("Handed over. They have been told in the app. Nothing was sent to the customer.");
      setOpen(false);
      setDiscussed("");
      setProposalKind("");
      setTitle("");
      setDue("");
      onDone?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Send className="mr-1.5 h-3.5 w-3.5" /> Hand over
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Hand over a job for {leadName}</DialogTitle>
            <DialogDescription>They see the lead as it is now, plus what you write here. Nothing is sent to the customer.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="space-y-2">
              <div className="font-medium">What needs doing?</div>
              <div className="flex flex-wrap gap-2">
                {JOB_KINDS.map((k) => (
                  <button key={k} type="button" className={chip(kind === k)} onClick={() => setKind(k)}>
                    {JOB_KIND_LABELS[k]}
                  </button>
                ))}
              </div>
              {kind === "other" && <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is the job?" maxLength={200} />}
            </div>
            <label className="block space-y-1">
              <span className="font-medium">Who should do it?</span>
              <select value={who} onChange={(e) => setWho(e.target.value)} className="h-10 w-full rounded-md border bg-background px-2">
                <option value="">Choose a person</option>
                {people.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.id === user.id ? "You" : u.full_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="font-medium">What was discussed? <span className="font-normal text-muted-foreground">so they do not have to ask</span></span>
              <Textarea rows={3} value={discussed} onChange={(e) => setDiscussed(e.target.value)} placeholder="e.g. 6 seats from January, wants a corner cabin, asked about parking" maxLength={2000} />
            </label>
            {kind === "send_proposal" && (
              <label className="block space-y-1">
                <span className="font-medium">What kind of proposal?</span>
                <Input value={proposalKind} onChange={(e) => setProposalKind(e.target.value)} placeholder="e.g. 6 dedicated desks, 12 months, with parking" maxLength={500} />
              </label>
            )}
            <label className="block space-y-1">
              <span className="font-medium">Needed by <span className="font-normal text-muted-foreground">optional</span></span>
              <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="w-48" />
            </label>
            {who && who !== user.id && (
              <p className="text-xs text-muted-foreground">
                <PersonName id={who} name={people.find((p) => p.id === who)?.full_name} /> will be told in the app and by push.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="button" disabled={!canSend || saving} onClick={send}>
                {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                Hand over
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
