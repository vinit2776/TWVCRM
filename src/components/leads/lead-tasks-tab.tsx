"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  CheckCircle2,
  Circle,
  Clock,
  ListTodo,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { formatDate, isOverdue, cn } from "@/lib/utils";
import { toast } from "sonner";
import type { Task } from "@/types";
import { CreateTaskDialog } from "@/components/tasks/create-task-dialog";

interface LeadTasksTabProps {
  leadId: string;
  leadName: string;
}

export function LeadTasksTab({ leadId, leadName }: LeadTasksTabProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/tasks?lead_id=${leadId}&limit=100`);
    if (res.ok) {
      const json = await res.json();
      setTasks(json.data || []);
    }
    setLoading(false);
  }, [leadId]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const handleStatusToggle = async (task: Task) => {
    const nextStatus =
      task.status === "done"
        ? "todo"
        : task.status === "todo"
          ? "in_progress"
          : "done";

    const res = await fetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    });
    if (res.ok) {
      toast.success(`Task marked as ${nextStatus.replace("_", " ")}`);
    }
    fetchTasks();
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Tasks</CardTitle>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add Task
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-12 bg-muted animate-pulse rounded" />
              ))}
            </div>
          ) : tasks.length === 0 ? (
            <EmptyState
              icon={ListTodo}
              title="No tasks"
              description="Create a task for this lead to track follow-ups and action items."
              actionLabel="Add Task"
              onAction={() => setCreateOpen(true)}
            />
          ) : (
            <div className="space-y-2">
              {tasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center gap-3 rounded-md border p-3 hover:bg-muted/30 transition-colors"
                >
                  <button
                    onClick={() => handleStatusToggle(task)}
                    className="text-muted-foreground hover:text-foreground shrink-0"
                  >
                    {task.status === "done" ? (
                      <CheckCircle2 className="h-5 w-5 text-green-600" />
                    ) : task.status === "in_progress" ? (
                      <Clock className="h-5 w-5 text-blue-600" />
                    ) : (
                      <Circle className="h-5 w-5" />
                    )}
                  </button>
                  <div className="flex-1 min-w-0">
                    <p
                      className={cn(
                        "text-sm font-medium truncate",
                        task.status === "done" &&
                          "line-through text-muted-foreground"
                      )}
                    >
                      {task.title}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <StatusBadge type="task_priority" value={task.priority} />
                      {task.assignee && (
                        <span className="text-xs text-muted-foreground">
                          {task.assignee.full_name}
                        </span>
                      )}
                    </div>
                  </div>
                  {task.due_date && (
                    <span
                      className={cn(
                        "text-xs whitespace-nowrap",
                        task.status !== "done" && isOverdue(task.due_date)
                          ? "text-red-600 font-medium"
                          : "text-muted-foreground"
                      )}
                    >
                      {formatDate(task.due_date)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <CreateTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={fetchTasks}
        leadId={leadId}
        leadName={leadName}
      />
    </>
  );
}
