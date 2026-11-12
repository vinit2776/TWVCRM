"use client";

import Link from "next/link";
import { LogOut } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import type { ExitView } from "@/lib/contract-exit-server";

/** Sidebar summary on the contract page. Renders nothing when there is no exit. */
export function ExitCard({ contractId, view }: { contractId: string; view: ExitView | null }) {
  if (!view) return null;
  const { exit } = view;
  return (
    <Card data-testid="exit-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <LogOut className="h-4 w-4" />
          Exit
          <Badge variant="secondary" className={exit.status === "completed" ? "bg-gray-100 text-gray-700" : "bg-amber-100 text-amber-800"}>
            {exit.status === "completed" ? "Completed" : "In notice"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex justify-between"><span className="text-muted-foreground">Notice</span><span>{formatDate(exit.notice_received_on)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Last day</span><span>{formatDate(exit.last_day)}</span></div>
        {exit.is_early_exit && (
          <div className="flex justify-between"><span className="text-muted-foreground">Type</span><Badge variant="secondary" className="bg-red-100 text-red-700">Early exit</Badge></div>
        )}
        <div className="flex justify-between"><span className="text-muted-foreground">Charges</span><span>{view.charges.length}</span></div>
        <Button asChild size="sm" className="w-full">
          <Link href={`/contracts/${contractId}/exit`}>Open exit</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
