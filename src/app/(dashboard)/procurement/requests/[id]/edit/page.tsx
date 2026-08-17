"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { MaterialRequestForm } from "@/components/procurement/material-request-form";
import { MR_EDITABLE_STATUSES } from "@/lib/constants";
import type { PurchaseRequest } from "@/types";

export default function EditPurchaseRequestPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [pr, setPr] = useState<PurchaseRequest | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/procurement/requests/${id}`);
      if (cancelled) return;
      if (!res.ok) {
        toast.error("Failed to load material request");
        router.push("/procurement/requests");
        return;
      }
      const json = await res.json();
      const loaded: PurchaseRequest = json.data;
      // Editing is only possible before approval — once approved the MR is a
      // committed spend that POs and budgets are already derived from.
      if (!MR_EDITABLE_STATUSES.includes(loaded.status)) {
        toast.error("This request can no longer be edited — it has already been approved.");
        router.push(`/procurement/requests/${id}`);
        return;
      }
      setPr(loaded);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [id, router]);

  if (loading || !pr) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <MaterialRequestForm mode="edit" pr={pr} />;
}
