"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
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
import { PRIORITY_STYLES } from "@/lib/facility-ui";
import { toast } from "sonner";
import type { FacilityIssuePriority } from "@/types";

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
const todayIso = () => new Date().toISOString().slice(0, 10);

export function DelegateTaskDialog({ open, onOpenChange, onCreated }: Props) {
  const [locationId, setLocationId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<FacilityIssuePriority>("medium");
  const [assignedTo, setAssignedTo] = useState("");
  const [dueDate, setDueDate] = useState("");
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
    setAssignedTo("");
    setDueDate("");
  };

  const canSubmit = !!locationId && !!title.trim() && !!assignedTo && !!dueDate;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);

    const res = await fetch("/api/facility/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_type: "delegated_task",
        location_id: locationId,
        title: title.trim(),
        description: description || undefined,
        priority,
        assigned_to: assignedTo,
        due_date: new Date(dueDate).toISOString(),
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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Delegate a Task</DialogTitle>
          <DialogDescription>
            Assign a one-time task to a teammate with a due date — no problem report needed.
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

          <div className="grid grid-cols-2 gap-4">
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
              <Label>Due Date (TAT) *</Label>
              <Input
                type="date"
                min={todayIso()}
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                required
              />
            </div>
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
              Delegate Task
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
