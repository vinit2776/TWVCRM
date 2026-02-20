"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  Users,
  CheckSquare,
  FileText,
  Receipt,
  LayoutDashboard,
  Activity,
  GitBranch,
  FolderOpen,
  UserPlus,
  Settings,
  HelpCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SearchResult {
  id: string;
  label: string;
  description?: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  category: string;
}

const QUICK_LINKS: SearchResult[] = [
  { id: "dashboard", label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, category: "Pages" },
  { id: "leads", label: "Leads", href: "/leads", icon: Users, category: "Pages" },
  { id: "pipeline", label: "Pipeline", href: "/pipeline", icon: GitBranch, category: "Pages" },
  { id: "activities", label: "Activities", href: "/activities", icon: Activity, category: "Pages" },
  { id: "tasks", label: "Tasks", href: "/tasks", icon: CheckSquare, category: "Pages" },
  { id: "proposals", label: "Proposals", href: "/proposals", icon: FileText, category: "Pages" },
  { id: "invoices", label: "Invoices", href: "/invoices", icon: Receipt, category: "Pages" },
  { id: "documents", label: "Documents", href: "/documents", icon: FolderOpen, category: "Pages" },
  { id: "team", label: "Team", href: "/team", icon: UserPlus, category: "Pages" },
  { id: "settings", label: "Settings", href: "/settings", icon: Settings, category: "Pages" },
  { id: "help", label: "Help & User Manual", href: "/help", icon: HelpCircle, category: "Pages" },
  { id: "new-lead", label: "Create New Lead", href: "/leads/new", icon: Users, category: "Actions" },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [leadResults, setLeadResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const router = useRouter();

  // Keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Filter quick links
  useEffect(() => {
    if (!query.trim()) {
      setResults(QUICK_LINKS);
      setLeadResults([]);
      setSelectedIndex(0);
      return;
    }

    const filtered = QUICK_LINKS.filter(
      (item) =>
        item.label.toLowerCase().includes(query.toLowerCase()) ||
        item.category.toLowerCase().includes(query.toLowerCase())
    );
    setResults(filtered);
    setSelectedIndex(0);
  }, [query]);

  // Search leads from API
  useEffect(() => {
    if (!query.trim() || query.length < 2) {
      setLeadResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/leads?search=${encodeURIComponent(query)}&limit=5`);
        if (res.ok) {
          const json = await res.json();
          const leads = (json.data || []).map(
            (lead: { id: string; first_name: string; last_name: string; company?: string; email?: string }) => ({
              id: lead.id,
              label: `${lead.first_name} ${lead.last_name}`,
              description: lead.company || lead.email || "",
              href: `/leads/${lead.id}`,
              icon: Users,
              category: "Leads",
            })
          );
          setLeadResults(leads);
        }
      } catch {
        // Ignore search errors
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  const allResults = [...results, ...leadResults];

  const handleSelect = useCallback(
    (result: SearchResult) => {
      router.push(result.href);
      setOpen(false);
      setQuery("");
    },
    [router]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, allResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && allResults[selectedIndex]) {
      handleSelect(allResults[selectedIndex]);
    }
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[100] bg-black/50"
        onClick={() => {
          setOpen(false);
          setQuery("");
        }}
      />

      {/* Palette */}
      <div className="fixed inset-x-0 top-[15%] z-[101] mx-auto w-full max-w-lg px-4">
        <div className="rounded-xl border bg-background shadow-2xl overflow-hidden">
          {/* Search input */}
          <div className="flex items-center gap-3 border-b px-4 py-3">
            <Search className="h-5 w-5 text-muted-foreground shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search pages, leads, actions..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="hidden sm:inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div className="max-h-80 overflow-y-auto p-2">
            {allResults.length === 0 && !searching ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No results found.
              </p>
            ) : (
              <>
                {/* Group by category */}
                {["Pages", "Actions", "Leads"].map((category) => {
                  const items = allResults.filter((r) => r.category === category);
                  if (items.length === 0) return null;
                  return (
                    <div key={category}>
                      <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                        {category}
                      </p>
                      {items.map((result) => {
                        const index = allResults.indexOf(result);
                        return (
                          <button
                            key={result.id}
                            onClick={() => handleSelect(result)}
                            className={cn(
                              "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                              index === selectedIndex
                                ? "bg-accent text-accent-foreground"
                                : "hover:bg-muted"
                            )}
                          >
                            <result.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <div className="flex-1 text-left">
                              <span>{result.label}</span>
                              {result.description && (
                                <span className="ml-2 text-xs text-muted-foreground">
                                  {result.description}
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
                {searching && (
                  <p className="py-2 text-center text-xs text-muted-foreground">
                    Searching leads...
                  </p>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t px-4 py-2">
            <span className="text-xs text-muted-foreground">Navigate with arrow keys</span>
            <span className="text-xs text-muted-foreground">
              <kbd className="rounded border px-1 py-0.5 text-[10px]">Enter</kbd> to select
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
