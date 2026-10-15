"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { MaterialRequestForm } from "@/components/procurement/material-request-form";
import { RequestWizard } from "@/components/procurement/request-wizard";
import { PROCUREMENT_DEPARTMENTS } from "@/lib/constants";
import type { ProcurementDepartment } from "@/types";

export default function NewPurchaseRequestPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <NewPurchaseRequestForm />
    </Suspense>
  );
}

function NewPurchaseRequestForm() {
  const searchParams = useSearchParams();
  // ?department= comes from the request wizard (and the legacy /orders/new-service redirect).
  // Without a valid one, the wizard asks what the user wants to buy first.
  const requested = searchParams.get("department");
  const department = PROCUREMENT_DEPARTMENTS.find((d) => d === requested) as ProcurementDepartment | undefined;

  if (!department) return <RequestWizard />;
  return <MaterialRequestForm mode="create" initialDepartment={department} lockDepartment />;
}
