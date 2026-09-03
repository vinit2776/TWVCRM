import type { HelpSection } from "@/lib/help-content";

/**
 * A section with no `roles` is visible to everyone. One with `roles` set is
 * only visible to a signed-in user whose role is in that list — a section
 * with a role restriction is never shown to a signed-out/unresolved user.
 */
export function isSectionVisible(section: HelpSection, role: string | null): boolean {
  return !section.roles || (!!role && section.roles.includes(role));
}

export function filterSectionsForRole(sections: HelpSection[], role: string | null): HelpSection[] {
  return sections.filter((section) => isSectionVisible(section, role));
}
