"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { MaterialRequestForm } from "@/components/procurement/material-request-form";
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
  // Pre-select department from ?department=amc — used by the legacy /orders/new-service redirect
  const initialDepartment = searchParams.get("department") as ProcurementDepartment | null;

  return <MaterialRequestForm mode="create" initialDepartment={initialDepartment} />;
}
