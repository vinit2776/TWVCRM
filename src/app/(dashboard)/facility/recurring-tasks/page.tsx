"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, Pencil, Trash2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { PRIORITY_STYLES } from "@/lib/facility-ui";
import { RecurrenceRuleDialog } from "@/components/facility/recurrence-rule-dialog";
import type { TaskRecurrenceRule } from "@/types";

const CADENCE_LABEL: Record<string, (rule: TaskRecurrenceRule) => string> = {
  daily: () => "Every day",
  weekly: (r) => `Every ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][r.day_of_week ?? 0]}`,
  monthly: (r) => `Day ${r.day_of_month} of every month`,
};

export default function RecurringTasksPage() {
  const [rules, setRules] = useState<TaskRecurrenceRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TaskRecurrenceRule | null>(null);

  const fetchRules = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/facility/recurrence-rules");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load rules");
      setRules(json.data || []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load rules");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRules(); }, [fetchRules]);

  const toggleActive = async (rule: TaskRecurrenceRule) => {
    const res = await fetch(`/api/facility/recurrence-rules/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !rule.is_active }),
    });
    if (res.ok) {
      toast.success(rule.is_active ? "Rule paused" : "Rule resumed");
      fetchRules();
    } else {
      const json = await res.json();
      toast.error(typeof json.error === "string" ? json.error : "Failed to update rule");
    }
  };

  const deleteRule = async (rule: TaskRecurrenceRule) => {
    if (!confirm(`Delete "${rule.title}"? This won't affect tasks already spawned from it.`)) return;
    const res = await fetch(`/api/facility/recurrence-rules/${rule.id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Rule deleted");
      fetchRules();
    } else {
      const json = await res.json();
      toast.error(typeof json.error === "string" ? json.error : "Failed to delete rule");
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-muted-foreground" />
            Recurring Tasks
          </h1>
          <p className="text-sm text-muted-foreground">
            Rules that auto-delegate a task on a repeating schedule — daily, weekly, or monthly.
          </p>
        </div>
        <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
          <Plus className="h-4 w-4 mr-1.5" />
          New Rule
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Assignee</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Repeats</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Loading...</TableCell></TableRow>
            ) : rules.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No recurring rules yet.</TableCell></TableRow>
            ) : (
              rules.map((rule) => {
                const style = PRIORITY_STYLES[rule.priority];
                return (
                  <TableRow key={rule.id}>
                    <TableCell className="font-medium">{rule.title}</TableCell>
                    <TableCell>{rule.assignee?.full_name ?? "—"}</TableCell>
                    <TableCell>{rule.location?.name ?? "—"}</TableCell>
                    <TableCell>{CADENCE_LABEL[rule.cadence_type]?.(rule) ?? rule.cadence_type}</TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs ring-1 ${style.chip}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
                        {style.label}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Switch checked={rule.is_active} onCheckedChange={() => toggleActive(rule)} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" onClick={() => { setEditing(rule); setDialogOpen(true); }}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => deleteRule(rule)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <RecurrenceRuleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        rule={editing}
        onSaved={fetchRules}
      />
    </div>
  );
}
