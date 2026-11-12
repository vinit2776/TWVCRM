import type { HelpSection, HelpWorkflow, HelpFaqItem } from "@/lib/help-content";

/**
 * One match against a section — either the whole section matched (title or
 * overview), or only specific workflows/tips/faqs within it did. Shared by
 * the /help search box and the help-chat retrieval, so there is exactly one
 * place that knows how to match a question against the knowledgebase.
 */
export interface SectionMatch {
  section: HelpSection;
  /** true if the section's own title/overview matched — everything inside is relevant */
  wholeSectionMatch: boolean;
  matchedWorkflows: HelpWorkflow[];
  matchedTips: string[];
  matchedFaqs: HelpFaqItem[];
  score: number;
}

const WEIGHTS = {
  title: 5,
  overview: 3,
  workflowTitle: 2,
  workflowStep: 1,
  tip: 1,
  faq: 2,
};

function countMatches(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.toLowerCase().split(needle).length - 1;
}

/**
 * Score every section against a free-text query. Returns only sections with
 * at least one match, ranked highest score first. A blank query returns
 * every section, unscored and in original order (used by the /help page
 * when there's nothing typed into the search box yet).
 */
export function scoreSections(sections: HelpSection[], query: string): SectionMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return sections.map((section) => ({
      section,
      wholeSectionMatch: true,
      matchedWorkflows: section.workflows,
      matchedTips: section.tips,
      matchedFaqs: section.faqs,
      score: 0,
    }));
  }

  const matches: SectionMatch[] = [];

  for (const section of sections) {
    const titleMatch = section.title.toLowerCase().includes(q);
    const overviewMatch = section.overview.toLowerCase().includes(q);
    let score = titleMatch ? WEIGHTS.title * countMatches(section.title, q) : 0;
    score += overviewMatch ? WEIGHTS.overview * countMatches(section.overview, q) : 0;

    const matchedWorkflows = section.workflows.filter((w) => {
      const workflowTitleMatch = w.title.toLowerCase().includes(q);
      const stepMatch = w.steps.some(
        (s) => s.title.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
      );
      if (workflowTitleMatch) score += WEIGHTS.workflowTitle;
      if (stepMatch) score += WEIGHTS.workflowStep;
      return workflowTitleMatch || stepMatch;
    });

    const matchedTips = section.tips.filter((t) => {
      const hit = t.toLowerCase().includes(q);
      if (hit) score += WEIGHTS.tip;
      return hit;
    });

    const matchedFaqs = section.faqs.filter((f) => {
      const hit = f.question.toLowerCase().includes(q) || f.answer.toLowerCase().includes(q);
      if (hit) score += WEIGHTS.faq;
      return hit;
    });

    const wholeSectionMatch = titleMatch || overviewMatch;
    const hasMatch = wholeSectionMatch || matchedWorkflows.length > 0 || matchedTips.length > 0 || matchedFaqs.length > 0;
    if (!hasMatch) continue;

    matches.push({
      section,
      wholeSectionMatch,
      matchedWorkflows: wholeSectionMatch ? section.workflows : matchedWorkflows,
      matchedTips: wholeSectionMatch ? section.tips : matchedTips,
      matchedFaqs: wholeSectionMatch ? section.faqs : matchedFaqs,
      score,
    });
  }

  return matches.sort((a, b) => b.score - a.score);
}

/** Top N section matches for a query — used to build the chat's grounding context. */
export function getTopMatches(sections: HelpSection[], query: string, limit: number): SectionMatch[] {
  return scoreSections(sections, query).slice(0, limit);
}
