"use client";

import { Keyboard, Shield, HelpCircle } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { HelpSection } from "@/lib/help-content";

interface HelpSidebarNavProps {
  sections: HelpSection[];
  activeSection: string | null;
}

export function HelpSidebarNav({ sections, activeSection }: HelpSidebarNavProps) {
  return (
    <nav className="hidden lg:block w-56 shrink-0">
      <div className="sticky top-6 space-y-0.5 max-h-[calc(100vh-12rem)] overflow-y-auto pr-2">
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <a
              key={section.id}
              href={`#${section.id}`}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                activeSection === section.id
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{section.title}</span>
            </a>
          );
        })}

        <Separator className="my-2" />

        <a
          href="#global-faqs"
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
            activeSection === "global-faqs"
              ? "bg-primary/10 text-primary font-medium"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          )}
        >
          <HelpCircle className="h-4 w-4 shrink-0" />
          <span>General FAQs</span>
        </a>

        <a
          href="#keyboard-shortcuts"
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
            activeSection === "keyboard-shortcuts"
              ? "bg-primary/10 text-primary font-medium"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          )}
        >
          <Keyboard className="h-4 w-4 shrink-0" />
          <span>Keyboard Shortcuts</span>
        </a>

        <a
          href="#role-permissions"
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
            activeSection === "role-permissions"
              ? "bg-primary/10 text-primary font-medium"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          )}
        >
          <Shield className="h-4 w-4 shrink-0" />
          <span>Role Permissions</span>
        </a>
      </div>
    </nav>
  );
}
