import type { LeadsView } from "@/lib/leads-views";

/** What the new navigation needs to know about the page to mark the right entry as current. */
export interface LeadsNavState {
  view: LeadsView;
  pinnedOnly: boolean;
  statusFilter: string;
}

export interface LeadsNavCounts {
  enquiries: number;
  followups: number;
  tours: number;
  replies: number;
  /** Enquiries waiting for space; shown only when the entry is switched on. */
  waiting?: number;
}

export type LeadsNavTarget =
  | { kind: "view"; view: LeadsView }
  | { kind: "bucket"; bucket: "pinned" | "all" | "junk" }
  | { kind: "link"; href: string };

export interface LeadsNavItem {
  key: string;
  label: string;
  count: number;
  /** Classes for the count badge. */
  tone: string;
  target: LeadsNavTarget;
  active: boolean;
}

export interface LeadsNavGroup {
  key: string;
  label: string;
  items: LeadsNavItem[];
}

export interface LeadsNav {
  daily: LeadsNavItem[];
  menus: LeadsNavGroup[];
}

/**
 * The new Leads navigation: three daily tabs, then Buckets and Reports menus. Entries whose own
 * screen is not built yet are left out rather than shown dead; each later phase adds its entry here.
 * A menu's own badge is the sum of its entries' counts, so work waiting inside it stays visible.
 */
export function buildLeadsNav(state: LeadsNavState, counts: LeadsNavCounts, options: { showHome?: boolean; showWaiting?: boolean; showChannels?: boolean } = {}): LeadsNav {
  const onAll = state.view === "all";
  const daily: LeadsNavItem[] = [
    ...(options.showHome ? [{ key: "home", label: "Home", count: 0, tone: "", target: { kind: "view", view: "home" } as LeadsNavTarget, active: state.view === "home" }] : []),
    { key: "enquiries", label: "New enquiries", count: counts.enquiries, tone: "bg-emerald-500 text-white", target: { kind: "view", view: "enquiries" }, active: state.view === "enquiries" },
    { key: "followups", label: "Follow-ups", count: counts.followups, tone: "bg-red-500 text-white", target: { kind: "view", view: "followups" }, active: state.view === "followups" },
    { key: "tours", label: "Tours", count: counts.tours, tone: "bg-violet-600 text-white", target: { kind: "view", view: "tours" }, active: state.view === "tours" },
  ];
  const menus: LeadsNavGroup[] = [
    {
      key: "buckets",
      label: "Buckets",
      items: [
        { key: "pinned", label: "Pinned", count: 0, tone: "", target: { kind: "bucket", bucket: "pinned" }, active: onAll && state.pinnedOnly },
        { key: "replies", label: "Waiting on a reply", count: counts.replies, tone: "bg-blue-600 text-white", target: { kind: "view", view: "replies" }, active: state.view === "replies" },
        ...(options.showWaiting ? [{ key: "waiting", label: "Waiting for space", count: counts.waiting ?? 0, tone: "bg-amber-500 text-white", target: { kind: "view", view: "waiting" } as LeadsNavTarget, active: state.view === "waiting" }] : []),
        { key: "all", label: "All leads", count: 0, tone: "", target: { kind: "bucket", bucket: "all" }, active: onAll && !state.pinnedOnly && state.statusFilter !== "junk" },
        { key: "junk", label: "Junk", count: 0, tone: "", target: { kind: "bucket", bucket: "junk" }, active: onAll && !state.pinnedOnly && state.statusFilter === "junk" },
      ],
    },
    {
      key: "reports",
      label: "Reports",
      items: [
        ...(options.showChannels ? [{ key: "channels", label: "Channels", count: 0, tone: "", target: { kind: "view", view: "channels" } as LeadsNavTarget, active: state.view === "channels" }] : []),
        { key: "pipeline", label: "Pipeline", count: 0, tone: "", target: { kind: "link", href: "/pipeline" }, active: false },
        { key: "whatsapp", label: "WhatsApp log", count: 0, tone: "", target: { kind: "view", view: "whatsapp" }, active: state.view === "whatsapp" },
      ],
    },
  ];
  return { daily, menus };
}

/** The badge on a menu that is not the current one: everything waiting inside it. */
export function groupCount(group: LeadsNavGroup): number {
  return group.items.reduce((sum, i) => sum + i.count, 0);
}
