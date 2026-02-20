"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { HelpCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HelpSearch } from "@/components/help/help-search";
import { HelpSidebarNav } from "@/components/help/help-sidebar-nav";
import { HelpSection } from "@/components/help/help-section";
import { HelpFaqItem } from "@/components/help/help-faq-item";
import { HelpKeyboardShortcuts } from "@/components/help/help-keyboard-shortcuts";
import { HelpRolePermissions } from "@/components/help/help-role-permissions";
import { HelpContactSupport } from "@/components/help/help-contact-support";
import { HELP_CONTENT, type HelpSection as HelpSectionType } from "@/lib/help-content";

/* ------------------------------------------------------------------ */
/*  Search filter logic                                                */
/* ------------------------------------------------------------------ */

function filterSections(sections: HelpSectionType[], query: string) {
  if (!query.trim()) return sections;

  const q = query.toLowerCase();

  return sections
    .map((section) => {
      const titleMatch = section.title.toLowerCase().includes(q);
      const overviewMatch = section.overview.toLowerCase().includes(q);

      const matchingWorkflows = section.workflows.filter(
        (w) =>
          w.title.toLowerCase().includes(q) ||
          w.steps.some(
            (s) =>
              s.title.toLowerCase().includes(q) ||
              s.description.toLowerCase().includes(q)
          )
      );

      const matchingTips = section.tips.filter((t) =>
        t.toLowerCase().includes(q)
      );

      const matchingFaqs = section.faqs.filter(
        (f) =>
          f.question.toLowerCase().includes(q) ||
          f.answer.toLowerCase().includes(q)
      );

      const hasMatch =
        titleMatch ||
        overviewMatch ||
        matchingWorkflows.length > 0 ||
        matchingTips.length > 0 ||
        matchingFaqs.length > 0;

      if (!hasMatch) return null;

      // If title or overview matches, show full section. Otherwise, show only matching parts.
      return {
        ...section,
        workflows:
          titleMatch || overviewMatch ? section.workflows : matchingWorkflows,
        tips: titleMatch || overviewMatch ? section.tips : matchingTips,
        faqs: titleMatch || overviewMatch ? section.faqs : matchingFaqs,
      };
    })
    .filter(Boolean) as HelpSectionType[];
}

/* ------------------------------------------------------------------ */
/*  Page component                                                     */
/* ------------------------------------------------------------------ */

export default function HelpPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Filter sections based on search
  const filteredSections = useMemo(
    () => filterSections(HELP_CONTENT.sections, searchQuery),
    [searchQuery]
  );

  // Filter global FAQs based on search
  const filteredGlobalFaqs = useMemo(() => {
    if (!searchQuery.trim()) return HELP_CONTENT.globalFaqs;
    const q = searchQuery.toLowerCase();
    return HELP_CONTENT.globalFaqs.filter(
      (f) =>
        f.question.toLowerCase().includes(q) ||
        f.answer.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  // Total result count for search badge
  const resultCount = searchQuery.trim()
    ? filteredSections.length +
      (filteredGlobalFaqs.length > 0 ? 1 : 0)
    : undefined;

  // Deep-link: scroll to hash on mount
  useEffect(() => {
    const hash = window.location.hash.replace("#", "");
    if (hash) {
      setTimeout(() => {
        const el = document.getElementById(hash);
        if (el) {
          el.scrollIntoView({ behavior: "smooth" });
        }
      }, 100);
    }
  }, []);

  // IntersectionObserver for active section tracking
  useEffect(() => {
    if (searchQuery.trim()) return; // Don't track when searching

    const sectionIds = [
      ...HELP_CONTENT.sections.map((s) => s.id),
      "global-faqs",
      "keyboard-shortcuts",
      "role-permissions",
    ];

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        }
      },
      {
        rootMargin: "-20% 0px -70% 0px",
        threshold: 0,
      }
    );

    sectionIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [searchQuery]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Help & User Manual</h1>
        <p className="text-muted-foreground">
          Learn how to use The WorkVilla CRM effectively
        </p>
      </div>

      {/* Search */}
      <HelpSearch
        value={searchQuery}
        onChange={setSearchQuery}
        resultCount={resultCount}
      />

      {/* Two-column layout */}
      <div className="flex gap-6">
        {/* Desktop sidebar nav */}
        {!searchQuery.trim() && (
          <HelpSidebarNav
            sections={HELP_CONTENT.sections}
            activeSection={activeSection}
          />
        )}

        {/* Content */}
        <div ref={contentRef} className="flex-1 min-w-0 space-y-6">
          {/* Section cards */}
          {filteredSections.length > 0 ? (
            filteredSections.map((section) => (
              <HelpSection
                key={section.id}
                section={section}
                highlightFaqs={!!searchQuery.trim()}
              />
            ))
          ) : searchQuery.trim() ? (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground">
                  No results found for &quot;{searchQuery}&quot;. Try a different search term.
                </p>
              </CardContent>
            </Card>
          ) : null}

          {/* Global FAQs */}
          {filteredGlobalFaqs.length > 0 && (
            <Card id="global-faqs" className="scroll-mt-24">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <HelpCircle className="h-5 w-5 text-primary" />
                  General FAQs
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {filteredGlobalFaqs.map((faq, i) => (
                    <HelpFaqItem
                      key={i}
                      question={faq.question}
                      answer={faq.answer}
                      defaultOpen={!!searchQuery.trim()}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Keyboard Shortcuts */}
          {!searchQuery.trim() && (
            <HelpKeyboardShortcuts shortcuts={HELP_CONTENT.keyboardShortcuts} />
          )}

          {/* Role Permissions */}
          {!searchQuery.trim() && (
            <HelpRolePermissions permissions={HELP_CONTENT.rolePermissions} />
          )}

          {/* Contact Support */}
          <HelpContactSupport
            email={HELP_CONTENT.supportInfo.email}
            phone={HELP_CONTENT.supportInfo.phone}
          />
        </div>
      </div>
    </div>
  );
}
