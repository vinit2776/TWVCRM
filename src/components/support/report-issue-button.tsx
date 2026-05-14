"use client";

import { useState } from "react";
import { LifeBuoy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReportIssueDialog } from "./report-issue-dialog";

export function ReportIssueButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        size="icon"
        className="fixed bottom-24 right-6 z-50 h-12 w-12 rounded-full shadow-lg lg:bottom-[72px] lg:right-auto lg:left-[196px]"
        title="Report an Issue"
      >
        <LifeBuoy className="h-5 w-5" />
      </Button>

      <ReportIssueDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
