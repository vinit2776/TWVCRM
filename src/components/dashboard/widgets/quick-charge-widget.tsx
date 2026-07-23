"use client";

import { useState } from "react";
import { Receipt } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AddUsageChargeDialog } from "@/components/billing/add-usage-charge-dialog";

export function QuickChargeWidget() {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Receipt className="h-4 w-4 text-muted-foreground" />
          Log a Charge
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <p className="text-sm text-muted-foreground">
          Breakages, reimbursements, or any other one-off charge — pick the
          customer, enter the amount, and it lands on their next bill
          automatically.
        </p>
        <Button onClick={() => setOpen(true)} className="w-full">
          <Receipt className="h-4 w-4 mr-2" />
          Log a Charge
        </Button>
      </CardContent>

      <AddUsageChargeDialog
        open={open}
        onOpenChange={setOpen}
        onSuccess={() => setOpen(false)}
      />
    </Card>
  );
}
