"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { renewalWalkthrough } from "@/lib/vo-renewal-learning";

/**
 * A short tour of the renewal journey, tailored to the viewer's role. It shows
 * once per person (the Renewals desk records that it was seen) and comes back
 * from the ? button. It only explains; it never does anything.
 */
export function RenewalWalkthrough({
  role,
  onClose,
}: {
  role: string | null;
  /** Called when the person finishes or dismisses the tour. */
  onClose: () => void;
}) {
  const steps = renewalWalkthrough(role);
  const [i, setI] = useState(0);
  const step = steps[i];
  const last = i === steps.length - 1;

  return (
    <Card className="border-blue-200 bg-blue-50/40 p-4 dark:bg-blue-950/20" data-testid="renewal-walkthrough">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            How renewals work · {i + 1} of {steps.length}
          </p>
          <p className="text-sm font-medium">{step.title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
          {step.forYou && <p className="mt-1 text-sm font-medium text-blue-700 dark:text-blue-300">{step.forYou}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close the walkthrough" className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <div className="flex gap-1" aria-hidden="true">
          {steps.map((_, n) => (
            <span key={n} className={`h-1.5 w-6 rounded-full ${n <= i ? "bg-blue-600" : "bg-muted"}`} />
          ))}
        </div>
        <div className="flex gap-2">
          {i > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setI(i - 1)}>
              <ChevronLeft className="mr-1 h-4 w-4" /> Back
            </Button>
          )}
          {last ? (
            <Button size="sm" onClick={onClose}>Got it</Button>
          ) : (
            <Button size="sm" onClick={() => setI(i + 1)}>
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
