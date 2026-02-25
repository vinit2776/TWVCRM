"use client";

import { Package } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";

export default function PurchaseOrdersPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Purchase Orders</h1>
        <p className="text-sm text-muted-foreground">Create and track purchase orders from approved requests.</p>
      </div>
      <EmptyState
        icon={Package}
        title="Coming in Sprint 3"
        description="Purchase order creation and delivery tracking will be available soon."
      />
    </div>
  );
}
