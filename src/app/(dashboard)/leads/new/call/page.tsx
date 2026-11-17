"use client";

import { useRouter } from "next/navigation";
import { CallInLeadForm } from "@/components/leads/call-in-lead-form";

export default function LogCallPage() {
  const router = useRouter();
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-5">
        <h1 className="text-2xl font-bold">Log a call</h1>
        <p className="text-sm text-muted-foreground">
          Start with what they want, then how to reach them. Nothing is sent to the customer.
        </p>
      </div>
      <CallInLeadForm onUseFullForm={() => router.push("/leads/new")} />
    </div>
  );
}
