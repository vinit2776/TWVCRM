"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLoopinEnabled } from "@/hooks/use-loopin";
import { useCurrentUser } from "@/providers/current-user-provider";
import { useUsers } from "@/hooks/use-leads";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";
import { LOOPIN_DAYS, loopinProblem } from "@/lib/lead-loopin";

const chip = (on: boolean) => `min-h-10 rounded-full border px-4 py-2 text-sm ${on ? "border-primary bg-primary/10 font-semibold text-primary" : "hover:bg-muted"}`;

interface Watcher { id: string; name: string; addedBy: string | null; reason: string; state: "waiting" | "got_it" | "not_for_me" | "expired"; daysLeft: number }
const STATE_TEXT: Record<Watcher["state"], string> = { waiting: "hasn’t answered yet", got_it: "Got it", not_for_me: "Not for me", expired: "expired" };

/**
 * "Keep someone informed" on a lead: asks colleagues who work leads to see it in their work. It
 * gives them no job and sends nothing to the customer; they answer Got it or Not for me, and it
 * clears itself after 14 days. The Looped in card lists who, why and what they answered. Behind the switch.
 */
export function KeepInformed({ leadId, closed }: { leadId: string; closed: boolean }) {
  const enabled = useLoopinEnabled();
  const { user } = useCurrentUser();
  const { users } = useUsers();
  const [rows, setRows] = useState<Watcher[]>([]);
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState<string[]>([]);
  const [why, setWhy] = useState("");
  const [saving, setSaving] = useState(false);

  const canUse = enabled && !!user?.role && (LEAD_HANDLER_ROLES as readonly string[]).includes(user.role);
  const load = useCallback(() => {
    fetch(`/api/leads/${leadId}/watchers`).then((r) => (r.ok ? r.json() : null)).then((j) => j && setRows(j.data ?? [])).catch(() => {});
  }, [leadId]);
  useEffect(() => {
    if (canUse) load();
  }, [canUse, load]);

  if (!canUse) return null;
  const people = users.filter((u) => u.id !== user?.id && (LEAD_HANDLER_ROLES as readonly string[]).includes(u.role));
  const issue = loopinProblem({ userIds: who, reason: why, addedBy: user?.id ?? "" });

  const save = async () => {
    setSaving(true);
    const res = await fetch(`/api/leads/${leadId}/watchers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_ids: who, reason: why }) });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) return void toast.error(json.error ?? "Could not do that");
    toast.success("Kept informed. Nothing was sent to the customer.");
    setOpen(false);
    setWho([]);
    setWhy("");
    load();
  };

  return (
    <>
      {!closed && (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Eye className="mr-1.5 h-4 w-4" /> Keep someone informed
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keep someone informed</DialogTitle>
            <DialogDescription>They see this enquiry in their work. They get no job and nothing is sent to the customer.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {people.map((p) => (
                <button key={p.id} type="button" className={chip(who.includes(p.id))} onClick={() => setWho((w) => (w.includes(p.id) ? w.filter((x) => x !== p.id) : [...w, p.id]))}>
                  {p.full_name}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Only admin, manager and sales people are listed: others have no lead screens.</p>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="loopin-why">Why are they kept informed? <span className="text-red-600">*</span></label>
              <Input id="loopin-why" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. Arun needs the requirement before the tour" />
              <p className="text-xs text-muted-foreground">It clears by itself after {LOOPIN_DAYS} days, so lists don’t fill with things people only watch.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!!issue || saving} onClick={save}>{saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Keep informed</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {rows.length > 0 && (
        <section className="w-full overflow-hidden rounded-lg border" aria-label="Looped in">
          <div className="border-b bg-muted/30 px-3 py-2 text-sm font-semibold">Looped in <span className="font-normal text-muted-foreground">· they can see this enquiry but have nothing to do on it</span></div>
          <ul>
            {rows.map((r) => (
              <li key={r.id} className="space-y-1 border-b px-3 py-2 text-sm last:border-b-0">
                <div>
                  <b>{r.name}</b>
                  {r.addedBy && <span className="text-muted-foreground"> · added by {r.addedBy}</span>}
                  <span className={r.state === "got_it" ? "font-semibold text-emerald-700" : "text-muted-foreground"}> · {STATE_TEXT[r.state]}</span>
                </div>
                <div className="rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-indigo-800">{r.reason}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
