"use client";

import { useEffect, useState } from "react";
import { Clock, MapPin, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TOUR_SEEN_KEY, readFlag, writeFlag } from "@/lib/package-tour";

const POINTS = [
  { icon: Package, title: "A bundle of units", body: "For example 10 hours of Meeting Room A. Never a rupee balance." },
  { icon: MapPin, title: "Tied to a space and places", body: "The places are chosen when you sell it, not on the template." },
  { icon: Clock, title: "Valid for 30 days", body: "That's the default expiry. You can change it for each sale." },
];

interface PackageTourDialogProps {
  /** Bumping this opens the tour on demand (the "Take the tour" link). */
  openSignal?: number;
}

export function PackageTourDialog({ openSignal = 0 }: PackageTourDialogProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!readFlag(TOUR_SEEN_KEY)) setOpen(true);
  }, []);

  useEffect(() => {
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);

  const close = () => {
    writeFlag(TOUR_SEEN_KEY, true);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Welcome to packages</DialogTitle>
          <DialogDescription>
            A package is a bundle of hours, days or bookings sold to a customer. It isn&apos;t a wallet.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          {POINTS.map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-md border p-3">
              <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
              <p className="mt-1 text-sm font-medium">{title}</p>
              <p className="text-xs text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
        <ul className="space-y-1 text-sm text-muted-foreground">
          <li>Cancel early enough and the hours come back. A late cancel or no-show uses them up.</li>
          <li>Every booking and cancellation shows on a statement you can send from the lead page.</li>
          <li>Sales can create packages. A manager activates them before they can be sold.</li>
        </ul>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close}>Skip</Button>
          <Button onClick={close}>Got it</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
