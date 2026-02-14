import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";

export default function LeadsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Leads</h1>
          <p className="text-muted-foreground">Manage your leads and pipeline</p>
        </div>
        <Link href="/leads/new">
          <Button>
            <Plus className="h-4 w-4" />
            Create Lead
          </Button>
        </Link>
      </div>
      <div className="rounded-lg border p-8 text-center">
        <p className="text-muted-foreground">No leads yet. Create your first lead to get started.</p>
      </div>
    </div>
  );
}
