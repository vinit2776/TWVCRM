"use client";

import { useState, useEffect } from "react";
import { Loader2, AlertTriangle, Wifi, ThermometerSun, Droplets, Zap, Sparkles, ShieldAlert, HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { FacilityPhotoUpload, type FacilityUploadedPhoto } from "@/components/facility/photo-upload";
import { PRIORITY_STYLES, SCOPE_LABEL } from "@/lib/facility-ui";
import { BUSINESS_HOURS_TIME_SLOTS } from "@/lib/time-slots";
import { cn, preventEnterSubmit } from "@/lib/utils";
import { toast } from "sonner";
import type { FacilityIssuePriority, FacilityScope } from "@/types";

const SCOPE_ORDER: FacilityScope[] = ["it", "hvac", "electrical", "plumbing", "housekeeping", "security", "other", "facility"];

const SCOPE_ICONS: Record<FacilityScope, typeof Wifi> = {
  it: Wifi, hvac: ThermometerSun, plumbing: Droplets,
  electrical: Zap, housekeeping: Sparkles, security: ShieldAlert, other: HelpCircle, facility: HelpCircle,
};

interface AssigneeOption {
  id: string;
  full_name: string;
  email: string;
  role: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}

const PRIORITY_ORDER: FacilityIssuePriority[] = ["low", "medium", "high", "critical"];

export function DelegateTaskDialog({ open, onOpenChange, onCreated }: Props) {
  const [locationId, setLocationId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<FacilityIssuePriority>("medium");
  // No default — previously this was never sent at all and the server silently
  // defaulted every delegated task to IT regardless of what the task was about.
  const [scope, setScope] = useState<FacilityScope | null>(null);
  const [assignedTo, setAssignedTo] = useState("");
  const [dueMode, setDueMode] = useState<"hours" | "datetime">("datetime");
  const [dueHours, setDueHours] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [dueTime, setDueTime] = useState("");
  // Combined "YYYY-MM-DDTHH:mm" — same wire format the old datetime-local
  // input produced, so the resolve/validation logic below is unchanged.
  const dueDateTime = dueDate && dueTime ? `${dueDate}T${dueTime}` : "";
  const [photos, setPhotos] = useState<FacilityUploadedPhoto[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const [assignees, setAssignees] = useState<AssigneeOption[]>([]);
  const [loadingAssignees, setLoadingAssignees] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoadingAssignees(true);
    fetch("/api/facility/assignees")
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((j) => setAssignees(j.data ?? []))
      .finally(() => setLoadingAssignees(false));
  }, [open]);

  const resetForm = () => {
    setLocationId(null);
    setTitle("");
    setDescription("");
    setPriority("medium");
    setScope(null);
    setAssignedTo("");
    setDueMode("datetime");
    setDueHours("");
    setDueDate("");
    setDueTime("");
    setPhotos([]);
  };

  // Due date, resolved from whichever mode is active — hours-from-now, or a
  // specific date/time picked directly. Mirrors the Work Order TAT toggle.
  // Only called from the submit handler (not render) since it reads Date.now().
  const resolveDueDate = (): Date | null => {
    if (dueMode === "hours") {
      const hours = Number(dueHours);
      if (!dueHours.trim() || !isFinite(hours) || hours <= 0) return null;
      return new Date(Date.now() + hours * 3_600_000);
    }
    if (!dueDateTime) return null;
    const d = new Date(dueDateTime);
    return isNaN(d.getTime()) ? null : d;
  };

  const hasValidDueInput = dueMode === "hours"
    ? !!dueHours.trim() && isFinite(Number(dueHours)) && Number(dueHours) > 0
    : !!dueDateTime && !isNaN(new Date(dueDateTime).getTime());
  const canSubmit = !!locationId && !!title.trim() && !!assignedTo && !!scope && hasValidDueInput;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !scope) return;
    const resolvedDueDate = resolveDueDate();
    if (!resolvedDueDate || resolvedDueDate.getTime() <= Date.now()) {
      toast.error("Due date must be in the future");
      return;
    }
    setSubmitting(true);

    const res = await fetch("/api/facility/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_type: "delegated_task",
        location_id: locationId,
        scope,
        title: title.trim(),
        description: description || undefined,
        priority,
        assigned_to: assignedTo,
        due_date: resolvedDueDate.toISOString(),
        attachments: photos.map((p) => ({
          file_url: p.file_url, file_path: p.file_path,
          file_type: p.file_type, caption: p.caption ?? null,
        })),
      }),
    });

    setSubmitting(false);
    const json = await res.json();
    if (res.ok) {
      const assignee = assignees.find((a) => a.id === assignedTo);
      toast.success(`Task delegated to ${assignee?.full_name ?? "assignee"}`);
      resetForm();
      onOpenChange(false);
      onCreated?.();
    } else {
      toast.error(json.error || "Failed to delegate task");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) resetForm(); onOpenChange(next); }}>
      <DialogContent className="max-w-lg p-0 gap-0 max-h-[92vh] flex flex-col">
        <form onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="flex flex-col overflow-hidden flex-1">
        <DialogHeader className="p-4 pb-3 border-b">
          <DialogTitle>New Task</DialogTitle>
          <DialogDescription>
            Assign a one-time task to a teammate with a due date — no problem report needed.
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-y-auto p-4 flex-1 space-y-4">
          <div className="space-y-2">
            <Label>Location *</Label>
            <LocationSelector value={locationId} onValueChange={setLocationId} />
          </div>

          <div className="space-y-2">
            <Label>Department *</Label>
            <div className="grid grid-cols-2 gap-2">
              {SCOPE_ORDER.map((s) => {
                const sel = scope === s;
                const Icon = SCOPE_ICONS[s];
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setScope(s)}
                    className={cn(
                      "flex items-center gap-2 p-2 rounded-lg border text-left transition text-sm",
                      sel ? "border-[#015E65] bg-[#015E65]/5 font-medium" : "border-border hover:bg-muted/40",
                    )}
                  >
                    <div className={cn("h-6 w-6 rounded flex items-center justify-center shrink-0",
                      sel ? "bg-[#015E65] text-white" : "bg-muted text-muted-foreground")}>
                      <Icon className="h-3.5 w-3.5" />
                    </div>
                    {SCOPE_LABEL[s]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Title *</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Get vendor quote for AC servicing"
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

          <div className="space-y-2">
            <Label>Due date <span className="font-normal text-muted-foreground">— required (TAT)</span> *</Label>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setDueMode("hours")}
                className={cn(
                  "px-2.5 py-1 text-xs rounded-full border",
                  dueMode === "hours" ? "bg-[#015E65] text-white border-[#015E65]" : "bg-muted/40",
                )}
              >Hours</button>
              <button
                type="button"
                onClick={() => setDueMode("datetime")}
                className={cn(
                  "px-2.5 py-1 text-xs rounded-full border",
                  dueMode === "datetime" ? "bg-[#015E65] text-white border-[#015E65]" : "bg-muted/40",
                )}
              >Date &amp; time</button>
            </div>
            {dueMode === "hours" ? (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={dueHours}
                  onChange={(e) => setDueHours(e.target.value)}
                  placeholder="Hours"
                  className="max-w-[140px]"
                  required
                />
                <span className="text-xs text-muted-foreground">from now</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="max-w-[160px]"
                  required
                />
                <Select value={dueTime} onValueChange={setDueTime}>
                  <SelectTrigger className="w-[120px]">
                    <SelectValue placeholder="Time" />
                  </SelectTrigger>
                  <SelectContent>
                    {BUSINESS_HOURS_TIME_SLOTS.map((slot) => (
                      <SelectItem key={slot.value} value={slot.value}>{slot.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {!hasValidDueInput && (
              <div className="flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>A due date is required — this task can&apos;t be created without one.</span>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>Attachments (optional)</Label>
            <FacilityPhotoUpload
              pathPrefix="task"
              photos={photos}
              onUploaded={(p) => setPhotos((prev) => [...prev, p])}
              onRemove={(i) => setPhotos((prev) => prev.filter((_, idx) => idx !== i))}
              disabled={submitting}
            />
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
        </div>

        <div className="border-t p-3 flex justify-end gap-2 bg-background">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !canSubmit}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create Task
          </Button>
        </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
