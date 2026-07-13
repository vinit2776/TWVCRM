"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { LocationSelector } from "@/components/shared/location-selector";
import { PRIORITY_STYLES } from "@/lib/facility-ui";
import { toast } from "sonner";
import type { FacilityIssuePriority, TaskRecurrenceCadence, TaskRecurrenceRule } from "@/types";

interface AssigneeOption {
  id: string;
  full_name: string;
  email: string;
  role: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
  rule?: TaskRecurrenceRule | null; // present = edit mode
}

const PRIORITY_ORDER: FacilityIssuePriority[] = ["low", "medium", "high", "critical"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function RecurrenceRuleDialog({ open, onOpenChange, onSaved, rule }: Props) {
  const isEdit = !!rule;

  const [locationId, setLocationId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<FacilityIssuePriority>("medium");
  const [assignedTo, setAssignedTo] = useState("");
  const [cadenceType, setCadenceType] = useState<TaskRecurrenceCadence>("daily");
  const [dayOfWeek, setDayOfWeek] = useState<string>("1");
  const [dayOfMonth, setDayOfMonth] = useState<string>("1");
  const [skipIfOpen, setSkipIfOpen] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [assignees, setAssignees] = useState<AssigneeOption[]>([]);
  const [loadingAssignees, setLoadingAssignees] = useState(false);

  const resetForm = () => {
    setLocationId(null);
    setTitle("");
    setDescription("");
    setPriority("medium");
    setAssignedTo("");
    setCadenceType("daily");
    setDayOfWeek("1");
    setDayOfMonth("1");
    setSkipIfOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    setLoadingAssignees(true);
    fetch("/api/facility/assignees")
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((j) => setAssignees(j.data ?? []))
      .finally(() => setLoadingAssignees(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (rule) {
      setLocationId(rule.location_id);
      setTitle(rule.title);
      setDescription(rule.description ?? "");
      setPriority(rule.priority);
      setAssignedTo(rule.assigned_to);
      setCadenceType(rule.cadence_type);
      setDayOfWeek(String(rule.day_of_week ?? 1));
      setDayOfMonth(String(rule.day_of_month ?? 1));
      setSkipIfOpen(rule.skip_if_open);
    } else {
      resetForm();
    }
  }, [open, rule]);

  const canSubmit = !!locationId && !!title.trim() && !!assignedTo;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);

    const payload = {
      location_id: locationId,
      title: title.trim(),
      description: description || undefined,
      priority,
      assigned_to: assignedTo,
      cadence_type: cadenceType,
      day_of_week: cadenceType === "weekly" ? Number(dayOfWeek) : undefined,
      day_of_month: cadenceType === "monthly" ? Number(dayOfMonth) : undefined,
      skip_if_open: skipIfOpen,
    };

    const res = await fetch(
      isEdit ? `/api/facility/recurrence-rules/${rule!.id}` : "/api/facility/recurrence-rules",
      {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    setSubmitting(false);
    const json = await res.json();
    if (res.ok) {
      toast.success(isEdit ? "Rule updated" : "Recurring rule created");
      onOpenChange(false);
      onSaved?.();
    } else {
      toast.error(typeof json.error === "string" ? json.error : "Failed to save rule");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) resetForm(); onOpenChange(next); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Recurring Task" : "New Recurring Task"}</DialogTitle>
          <DialogDescription>
            Automatically delegate this task on a repeating schedule — no need to remember it yourself.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Location *</Label>
            <LocationSelector value={locationId} onValueChange={setLocationId} />
          </div>

          <div className="space-y-2">
            <Label>Title *</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Check fire extinguisher tags"
              required
            />
          </div>

          <div className="space-y-2">
            <Label>Details (optional)</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Any context the assignee needs..."
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label>Assign To *</Label>
            <Select value={assignedTo} onValueChange={setAssignedTo}>
              <SelectTrigger>
                <SelectValue placeholder={loadingAssignees ? "Loading..." : "Select teammate"} />
              </SelectTrigger>
              <SelectContent>
                {assignees.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.full_name} ({a.role})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Repeats *</Label>
              <Select value={cadenceType} onValueChange={(v) => setCadenceType(v as TaskRecurrenceCadence)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Every day</SelectItem>
                  <SelectItem value="weekly">Every week</SelectItem>
                  <SelectItem value="monthly">Every month</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {cadenceType === "weekly" && (
              <div className="space-y-2">
                <Label>On</Label>
                <Select value={dayOfWeek} onValueChange={setDayOfWeek}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAYS.map((d, i) => (
                      <SelectItem key={i} value={String(i)}>{d}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {cadenceType === "monthly" && (
              <div className="space-y-2">
                <Label>Day of month</Label>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={dayOfMonth}
                  onChange={(e) => setDayOfMonth(e.target.value)}
                />
              </div>
            )}
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label className="text-sm">Skip if previous instance still open</Label>
              <p className="text-xs text-muted-foreground">
                Avoids piling up duplicates when the last one hasn&apos;t been resolved yet.
              </p>
            </div>
            <Switch checked={skipIfOpen} onCheckedChange={setSkipIfOpen} />
          </div>

          <div className="space-y-2">
            <Label>Priority</Label>
            <div className="flex gap-2">
              {PRIORITY_ORDER.map((p) => {
                const selected = priority === p;
                const style = PRIORITY_STYLES[p];
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ring-1 transition-colors ${
                      selected ? style.chip : "bg-background text-muted-foreground ring-border"
                    }`}
                  >
                    <span className={`h-2 w-2 rounded-full ${style.dot}`} />
                    {style.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !canSubmit}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isEdit ? "Save Changes" : "Create Rule"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
