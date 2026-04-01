"use client";

import { Lightbulb } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { HelpFaqItem } from "./help-faq-item";
import type { HelpSection as HelpSectionType } from "@/lib/help-content";

interface HelpSectionProps {
  section: HelpSectionType;
  highlightFaqs?: boolean;
}

export function HelpSection({ section, highlightFaqs = false }: HelpSectionProps) {
  const Icon = section.icon;

  return (
    <Card id={section.id} className="scroll-mt-24">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Icon className="h-5 w-5 text-primary shrink-0" />
          {section.title}
          {section.roles && (
            <Badge variant="outline" className="text-[10px] font-normal">
              {section.roles.join(", ")}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Overview */}
        <div>
          <h4 className="text-sm font-medium mb-1">Overview</h4>
          <p className="text-sm text-muted-foreground leading-relaxed">{section.overview}</p>
        </div>

        {/* Workflows */}
        {section.workflows.map((workflow, wi) => (
          <div key={wi}>
            <h4 className="text-sm font-medium mb-3">{workflow.title}</h4>
            <ol className="space-y-3">
              {workflow.steps.map((step) => (
                <li key={step.step} className="flex gap-3 text-sm">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
                    {step.step}
                  </span>
                  <div>
                    <span className="font-medium">{step.title}</span>
                    <p className="text-muted-foreground mt-0.5">{step.description}</p>
                    {step.hint && (
                      <div className="mt-1.5 flex items-start gap-1.5 rounded-md bg-amber-50 border border-amber-200 px-2.5 py-1.5">
                        <span className="text-amber-500 text-xs mt-0.5 shrink-0">💡</span>
                        <p className="text-xs text-amber-800 leading-relaxed">{step.hint}</p>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        ))}

        {/* Tips */}
        {section.tips.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">Tips</h4>
            <ul className="space-y-1.5">
              {section.tips.map((tip, ti) => (
                <li key={ti} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Lightbulb className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
                  <span>{tip}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* FAQs */}
        {section.faqs.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">Frequently Asked Questions</h4>
            <div className="space-y-2">
              {section.faqs.map((faq, fi) => (
                <HelpFaqItem
                  key={fi}
                  question={faq.question}
                  answer={faq.answer}
                  defaultOpen={highlightFaqs}
                />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
