"use client";

import { ClipboardList } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";

export default function PurchaseRequestsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Purchase Requests</h1>
        <p className="text-sm text-muted-foreground">Raise and track purchase requests for all departments.</p>
      </div>
      <EmptyState
        icon={ClipboardList}
        title="Coming in Sprint 2"
        description="Purchase request creation and approval workflows will be available soon."
      />
    </div>
  );
}
