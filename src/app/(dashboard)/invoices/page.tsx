import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";

export default function InvoicesPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Proforma Invoices</h1>
          <p className="text-muted-foreground">Create and track invoices</p>
        </div>
        <Link href="/invoices/new">
          <Button>
            <Plus className="h-4 w-4" />
            Create Invoice
          </Button>
        </Link>
      </div>
      <div className="rounded-lg border p-8 text-center">
        <p className="text-muted-foreground">No invoices yet.</p>
      </div>
    </div>
  );
}
