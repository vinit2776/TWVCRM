"use client";

import { Receipt } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";

export default function VendorBillsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Vendor Bills</h1>
        <p className="text-sm text-muted-foreground">Record and track vendor invoices and payments.</p>
      </div>
      <EmptyState
        icon={Receipt}
        title="Coming in Sprint 3"
        description="Vendor bill recording and payment tracking will be available soon."
      />
    </div>
  );
}
