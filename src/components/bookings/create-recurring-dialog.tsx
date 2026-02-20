"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { RECURRENCE_FREQUENCIES } from "@/lib/constants";
import { Loader2, Repeat } from "lucide-react";
import { toast } from "sonner";

const DAYS_OF_WEEK = [
  { value: "0", label: "Sunday" }, { value: "1", label: "Monday" }, { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" }, { value: "4", label: "Thursday" }, { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
];

export function CreateRecurringDialog({
  open,
  onOpenChange,
  prefill,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefill?: {
    space_id: string;
    customer_type: string;
    contract_id?: string;
    lead_id?: string;
    booker_phone?: string;
    guest_name?: string;
    guest_email?: string;
    guest_phone?: string;
    guest_company?: string;
    start_time?: string;
    end_time?: string;
  };
  onCreated: () => void;
}) {
  const [frequency, setFrequency] = useState("weekly");
  const [dayOfWeek, setDayOfWeek] = useState("1");
  const [dayOfMonth, setDayOfMonth] = useState("1");
  const [seriesStart, setSeriesStart] = useState("");
  const [seriesEnd, setSeriesEnd] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    if (!prefill?.space_id || !seriesStart || !seriesEnd) {
      toast.error("All fields are required");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/bookings/recurring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          space_id: prefill.space_id,
          customer_type: prefill.customer_type,
          contract_id: prefill.contract_id,
          lead_id: prefill.lead_id,
          booker_phone: prefill.booker_phone,
          guest_name: prefill.guest_name,
          guest_email: prefill.guest_email,
          guest_phone: prefill.guest_phone,
          guest_company: prefill.guest_company,
          start_time: prefill.start_time,
          end_time: prefill.end_time,
          frequency,
          day_of_week: ["weekly", "biweekly"].includes(frequency) ? parseInt(dayOfWeek) : undefined,
          day_of_month: frequency === "monthly" ? parseInt(dayOfMonth) : undefined,
          series_start: seriesStart,
          series_end: seriesEnd,
          notes,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(typeof json.error === "string" ? json.error : "Failed to create recurring series");
        return;
      }
      toast.success(`Recurring series created: ${json.created} bookings, ${json.skipped} skipped`);
      onCreated();
      onOpenChange(false);
    } catch {
      toast.error("Failed to create recurring series");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Repeat className="w-5 h-5" /> Create Recurring Booking</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Frequency</Label>
            <Select value={frequency} onValueChange={setFrequency}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {RECURRENCE_FREQUENCIES.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {["weekly", "biweekly"].includes(frequency) && (
            <div>
              <Label>Day of Week</Label>
              <Select value={dayOfWeek} onValueChange={setDayOfWeek}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DAYS_OF_WEEK.map(d => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {frequency === "monthly" && (
            <div>
              <Label>Day of Month</Label>
              <Input type="number" min={1} max={31} value={dayOfMonth} onChange={e => setDayOfMonth(e.target.value)} />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Series Start</Label>
              <Input type="date" value={seriesStart} onChange={e => setSeriesStart(e.target.value)} />
            </div>
            <div>
              <Label>Series End</Label>
              <Input type="date" value={seriesEnd} onChange={e => setSeriesEnd(e.target.value)} />
            </div>
          </div>

          <div>
            <Label>Notes</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Optional notes for all bookings..." />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleCreate} disabled={loading}>
            {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Create Series
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
