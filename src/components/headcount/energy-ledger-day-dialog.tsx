"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { BarChart3 } from "lucide-react";
import { EnergyLedgerDayChart } from "./energy-ledger-day-chart";

interface Props {
  locationId: string;
  locationName: string;
  /** YYYY-MM-DD, IST calendar day */
  date: string;
  dateLabel: string;
}

export function EnergyLedgerDayDialog({ locationId, locationName, date, dateLabel }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost" size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        title="View energy log for this day"
        onClick={() => setOpen(true)}
      >
        <BarChart3 className="h-3.5 w-3.5" />
      </Button>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Energy log — {dateLabel}</DialogTitle>
          <DialogDescription>{locationName}</DialogDescription>
        </DialogHeader>
        {open && <EnergyLedgerDayChart locationId={locationId} date={date} />}
      </DialogContent>
    </Dialog>
  );
}
