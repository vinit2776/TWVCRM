"use client";

import { useState } from "react";
import { Hourglass, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSpaceWaitingEnabled } from "@/hooks/use-space-waiting";
import { useLocations } from "@/hooks/use-locations";
import { useCurrentUser } from "@/providers/current-user-provider";
import { LEAD_HANDLER_ROLES, WORKSPACE_TYPES, WORKSPACE_TYPE_LABELS } from "@/lib/constants";
import { PARK_REASONS, PARK_REASON_LABELS, parkProblem, releaseProblem, type ParkReason } from "@/lib/space-parking";

const chip = (on: boolean) => `min-h-10 rounded-full border px-4 py-2 text-sm ${on ? "border-primary bg-primary/10 font-semibold text-primary" : "hover:bg-muted"}`;

/**
 * "Waiting for space" on a lead. Open and not yet parked: a button that records what we cannot offer
 * yet (where, what, why, a note and an optional look-again date) and moves the enquiry out of the
 * follow-up lists. Already parked: a banner with Take out of Waiting, which needs a next step so the
 * lead never comes back to nothing. Nothing is sent to the customer. Behind the switch.
 */
export function ParkControl({ leadId, parkedAt, closed, onChanged }: { leadId: string; parkedAt: string | null | undefined; closed: boolean; onChanged: () => void }) {
  const enabled = useSpaceWaitingEnabled();
  const { user } = useCurrentUser();
  const { locations } = useLocations();
  const [open, setOpen] = useState<null | "park" | "release">(null);
  const [busy, setBusy] = useState(false);
  const [locationId, setLocationId] = useState("");
  const [otherArea, setOtherArea] = useState("");
  const [type, setType] = useState("");
  const [seats, setSeats] = useState("");
  const [reason, setReason] = useState<ParkReason | "">("");
  const [note, setNote] = useState("");
  const [lookAgain, setLookAgain] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [when, setWhen] = useState("");

  if (!enabled || !user?.role || !(LEAD_HANDLER_ROLES as readonly string[]).includes(user.role)) return null;

  const seatsNum = seats ? Number(seats) : null;
  const parkIssue = parkProblem({ locationId: locationId || null, otherArea, reason, note, lookAgainOn: lookAgain || null, seatsNeeded: seatsNum });
  const releaseIssue = releaseProblem({ nextStep, followUpDate: when ? new Date(when).toISOString() : null });

  const send = async (method: "POST" | "DELETE", body: Record<string, unknown>, done: string) => {
    setBusy(true);
    const res = await fetch(`/api/leads/${leadId}/park`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return void toast.error(json.error ?? "Could not do that");
    toast.success(done);
    setOpen(null);
    onChanged();
  };

  if (parkedAt) {
    return (
      <>
        <div className="flex w-full flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <Hourglass className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1"><b>Waiting for space.</b> No follow-up and nobody chases it. Take it out when you can make an offer.</span>
          <Button size="sm" variant="outline" className="h-9 bg-white" onClick={() => setOpen("release")}>Take out of Waiting</Button>
        </div>
        <Dialog open={open === "release"} onOpenChange={(o) => !o && setOpen(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Take out of Waiting for space</DialogTitle>
              <DialogDescription>It becomes a normal lead again with this next step. Nothing is sent to the customer.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div className="space-y-1"><div className="font-semibold">What is the next step?</div><Input value={nextStep} onChange={(e) => setNextStep(e.target.value)} placeholder="e.g. Call to offer Cabin 3" /></div>
              <div className="space-y-1"><div className="font-semibold">When?</div><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></div>
              {releaseIssue && (nextStep || when) && <p className="text-red-700">{releaseIssue}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(null)}>Cancel</Button>
              <Button disabled={!!releaseIssue || busy} onClick={() => send("DELETE", { next_step: nextStep, follow_up_date: when }, "Taken out of Waiting for space.")}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Take it out
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }
  if (closed) return null;

  return (
    <>
      <Button size="sm" variant="outline" className="h-9 gap-1.5" onClick={() => setOpen("park")}>
        <Hourglass className="h-4 w-4" /> Waiting for space
      </Button>
      <Dialog open={open === "park"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Park: we can&apos;t offer it yet</DialogTitle>
            <DialogDescription>A real enquiry we have nothing to offer yet. It leaves Call today, nobody chases it, and it waits here until space opens. The customer is sent nothing.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="space-y-2">
              <div className="font-semibold">Where do they want space?</div>
              <select value={locationId} onChange={(e) => { setLocationId(e.target.value); if (e.target.value) setOtherArea(""); }} className="h-10 w-full rounded-md border bg-background px-2">
                <option value="">An area we have no centre in…</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              {!locationId && <Input value={otherArea} onChange={(e) => setOtherArea(e.target.value)} placeholder="Name the area, e.g. Anna Nagar" />}
            </div>
            <div className="space-y-2">
              <div className="font-semibold">Why can&apos;t we offer it?</div>
              <div className="flex flex-wrap gap-2">{PARK_REASONS.map((r) => <button key={r} type="button" className={chip(reason === r)} onClick={() => setReason(r)}>{PARK_REASON_LABELS[r]}</button>)}</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><div className="font-semibold">Type <span className="font-normal text-muted-foreground">(optional)</span></div>
                <select value={type} onChange={(e) => setType(e.target.value)} className="h-10 w-full rounded-md border bg-background px-2"><option value="">Any</option>{WORKSPACE_TYPES.map((t) => <option key={t} value={t}>{WORKSPACE_TYPE_LABELS[t] ?? t}</option>)}</select></div>
              <div className="space-y-1"><div className="font-semibold">Seats <span className="font-normal text-muted-foreground">(optional)</span></div><Input type="number" min={1} value={seats} onChange={(e) => setSeats(e.target.value)} /></div>
            </div>
            <div className="space-y-1"><div className="font-semibold">Note</div><Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="What they want, by when, anything we promised…" /></div>
            <div className="space-y-1"><div className="font-semibold">Look again on <span className="font-normal text-muted-foreground">(optional, a reminder for staff only)</span></div><Input type="date" value={lookAgain} onChange={(e) => setLookAgain(e.target.value)} /></div>
            {parkIssue && (locationId || otherArea || reason || note) && <p className="text-red-700">{parkIssue}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)}>Cancel</Button>
            <Button disabled={!!parkIssue || busy} onClick={() => send("POST", { location_id: locationId || null, other_area: otherArea || null, workspace_type: type || null, seats_needed: seatsNum, reason, note, look_again_on: lookAgain || null }, "Parked. It is now waiting for space.")}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Park it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
