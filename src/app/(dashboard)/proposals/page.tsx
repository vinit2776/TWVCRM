import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";

export default function ProposalsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Proposals</h1>
          <p className="text-muted-foreground">Create and track proposals</p>
        </div>
        <Link href="/proposals/new">
          <Button>
            <Plus className="h-4 w-4" />
            Create Proposal
          </Button>
        </Link>
      </div>
      <div className="rounded-lg border p-8 text-center">
        <p className="text-muted-foreground">No proposals yet.</p>
      </div>
    </div>
  );
}
