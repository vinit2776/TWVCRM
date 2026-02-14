import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";

export default function TasksPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Tasks</h1>
          <p className="text-muted-foreground">Manage tasks and subtasks</p>
        </div>
        <Link href="/tasks/new">
          <Button>
            <Plus className="h-4 w-4" />
            Create Task
          </Button>
        </Link>
      </div>
      <div className="rounded-lg border p-8 text-center">
        <p className="text-muted-foreground">No tasks yet. Create your first task to get started.</p>
      </div>
    </div>
  );
}
