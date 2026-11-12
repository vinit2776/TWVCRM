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
} from "@/components/ui/dialog";
import { TASK_PRIORITIES, TASK_PRIORITY_LABELS } from "@/lib/constants";
import { preventEnterSubmit } from "@/lib/utils";
import { toast } from "sonner";
import type { User as UserType } from "@/types";

interface LeadOption {
  id: string;
  first_name: string;
  last_name: string;
  company?: string;
}

interface CreateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  /** Pre-set lead ID (used when creating from a lead detail page) */
  leadId?: string;
  /** Pre-set lead name to display when leadId is provided */
  leadName?: string;
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  onSuccess,
  leadId,
  leadName,
}: CreateTaskDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [dueDate, setDueDate] = useState("");
  const [selectedLeadId, setSelectedLeadId] = useState(leadId || "");
  const [assignedTo, setAssignedTo] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Data for dropdowns
  const [leads, setLeads] = useState<LeadOption[]>([]);
  const [users, setUsers] = useState<UserType[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(false);

  // Sync leadId prop changes
  useEffect(() => {
    if (leadId) setSelectedLeadId(leadId);
  }, [leadId]);

  // Fetch leads and users when dialog opens
  useEffect(() => {
    if (!open) return;
    setLoadingOptions(true);

    Promise.all([
      // Only fetch leads if not pre-set
      leadId
        ? Promise.resolve(null)
        : fetch("/api/leads?limit=200").then((r) => r.ok ? r.json() : null),
      fetch("/api/users").then((r) => r.ok ? r.json() : null),
    ]).then(([leadsRes, usersRes]) => {
      if (leadsRes?.data) setLeads(leadsRes.data);
      if (usersRes?.data) setUsers(usersRes.data);
      setLoadingOptions(false);
    });
  }, [open, leadId]);

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setPriority("medium");
    setDueDate("");
    setSelectedLeadId(leadId || "");
    setAssignedTo("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);

    const payload: Record<string, unknown> = {
      title,
      description: description || undefined,
      status: "todo",
      priority,
      due_date: dueDate || undefined,
      tags: [],
    };

    if (selectedLeadId && selectedLeadId !== "none") {
      payload.lead_id = selectedLeadId;
    }
    if (assignedTo && assignedTo !== "me") {
      payload.assigned_to = assignedTo;
    }

    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    setSubmitting(false);
    if (res.ok) {
      toast.success("Task created successfully");
      resetForm();
      onOpenChange(false);
      onSuccess();
    } else {
      toast.error("Failed to create task");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Title *</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title..."
              required
            />
          </div>

          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Details..."
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TASK_PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {TASK_PRIORITY_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Due Date</Label>
              <Input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Lead selector */}
            <div className="space-y-2">
              <Label>Lead / Contact</Label>
              {leadId ? (
                <Input
                  value={leadName || "Linked lead"}
                  disabled
                  className="bg-muted"
                />
              ) : (
                <Select
                  value={selectedLeadId || "none"}
                  onValueChange={(val) =>
                    setSelectedLeadId(val === "none" ? "" : val)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select lead..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {loadingOptions ? (
                      <SelectItem value="loading" disabled>
                        Loading...
                      </SelectItem>
                    ) : (
                      leads.map((lead) => (
                        <SelectItem key={lead.id} value={lead.id}>
                          {lead.first_name} {lead.last_name}
                          {lead.company ? ` (${lead.company})` : ""}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Assignee selector */}
            <div className="space-y-2">
              <Label>Assign To</Label>
              <Select
                value={assignedTo || "me"}
                onValueChange={(val) =>
                  setAssignedTo(val === "me" ? "" : val)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Myself" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="me">Myself (default)</SelectItem>
                  {loadingOptions ? (
                    <SelectItem value="loading" disabled>
                      Loading...
                    </SelectItem>
                  ) : (
                    users.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.full_name} ({u.role})
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !title.trim()}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
