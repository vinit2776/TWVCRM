"use client";

import { ChevronDown } from "lucide-react";

interface HelpFaqItemProps {
  question: string;
  answer: string;
  defaultOpen?: boolean;
}

export function HelpFaqItem({ question, answer, defaultOpen = false }: HelpFaqItemProps) {
  return (
    <details className="group rounded-md border px-4 py-3" open={defaultOpen || undefined}>
      <summary className="flex cursor-pointer items-center justify-between text-sm font-medium list-none [&::-webkit-details-marker]:hidden">
        <span>{question}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
      </summary>
      <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{answer}</p>
    </details>
  );
}
