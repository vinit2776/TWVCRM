"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  GitBranch,
  Activity,
  CheckSquare,
  FileText,
  Receipt,
  UserPlus,
  Settings,
  ClipboardList,
  ScrollText,
  Wifi,
  IndianRupee,
  MapPin,
  CalendarClock,
  Calculator,
  Server,
  HelpCircle,
  LifeBuoy,
  X,
  Building2,
  Handshake,
  Briefcase,
  ChevronDown,
  ShoppingCart,
  ClipboardList as ClipboardListIcon,
  Package,
  Receipt as ReceiptIcon,
  Truck,
  Archive,
  TicketCheck,
  Ticket,
  Banknote,
  TrendingUp,
  DoorOpen,
  Search,
  Warehouse,
  ArrowLeftRight,
  ShieldCheck,
  UtensilsCrossed,
  BarChart3 as BarChart3Icon,
  UsersRound,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles: string[] | null; // null = visible to all roles
};

type NavSection = {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  items: NavItem[];
};

// Roles that existed before the accounts/fms additions — used as a shorthand below.
const LEGACY_ROLES = ["admin", "manager", "sales_rep", "floor_manager"];

// Operations menu (Bookings, Spaces, Packages, Vouchers): all active roles.
const OPERATIONS_ROLES = ["admin", "manager", "sales_rep", "floor_manager", "accounts", "fms", "office_admin"];

// Top-level items — always visible, never grouped
const topNavItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: null },
  { href: "/my-tickets", label: "My Tickets", icon: Ticket, roles: null },
];

// Collapsible sections
const navSections: NavSection[] = [
  {
    key: "sales",
    label: "Sales",
    icon: TrendingUp,
    items: [
      { href: "/leads",      label: "Leads",      icon: Users,       roles: [...LEGACY_ROLES, "accounts"] },
      { href: "/pipeline",   label: "Pipeline",    icon: GitBranch,   roles: LEGACY_ROLES },
      { href: "/activities", label: "Activities",  icon: Activity,    roles: LEGACY_ROLES },
      { href: "/tasks",      label: "Tasks",       icon: CheckSquare, roles: LEGACY_ROLES },
      { href: "/proposals",  label: "Proposals",   icon: FileText,    roles: [...LEGACY_ROLES, "accounts"] },
    ],
  },
  {
    key: "finance",
    label: "Finance",
    icon: IndianRupee,
    items: [
      { href: "/invoices",   label: "Proforma Invoices",       icon: Receipt,     roles: LEGACY_ROLES },
      { href: "/contracts",  label: "Contracts",               icon: ScrollText,  roles: [...LEGACY_ROLES, "accounts"] },
      { href: "/billing",    label: "Billing - Acc Receivables", icon: IndianRupee, roles: [...LEGACY_ROLES, "accounts"] },
      { href: "/accounting", label: "Acc Payables",             icon: Calculator,  roles: [...LEGACY_ROLES, "accounts"] },
    ],
  },
  {
    key: "operations",
    label: "Operations",
    icon: CalendarClock,
    items: [
      { href: "/bookings",  label: "Bookings",  icon: CalendarClock, roles: OPERATIONS_ROLES },
      { href: "/spaces",    label: "Spaces",    icon: DoorOpen,      roles: OPERATIONS_ROLES },
      { href: "/headcount", label: "Headcount", icon: UsersRound,    roles: OPERATIONS_ROLES },
      { href: "/packages",  label: "Packages",  icon: TicketCheck,   roles: OPERATIONS_ROLES },
      { href: "/vouchers",  label: "Vouchers",  icon: Wifi,          roles: OPERATIONS_ROLES },
    ],
  },
  {
    key: "virtual-offices",
    label: "Virtual Offices",
    icon: Building2,
    items: [
      { href: "/aggregators", label: "Aggregators", icon: Handshake, roles: LEGACY_ROLES },
      { href: "/cases",       label: "Cases",       icon: Briefcase, roles: LEGACY_ROLES },
    ],
  },
  {
    key: "procurement",
    label: "Procurement",
    icon: ShoppingCart,
    items: [
      { href: "/procurement",              label: "Dashboard",         icon: BarChart3Icon,     roles: ["admin", "manager", "office_admin"] },
      { href: "/procurement/requests",    label: "Material Requests", icon: ClipboardListIcon, roles: ["admin", "manager", "office_admin"] },
      { href: "/procurement/orders",      label: "Purchase Orders",   icon: Package,           roles: ["admin", "manager", "office_admin"] },
      { href: "/procurement/bills",       label: "Vendor Bills",      icon: ReceiptIcon,       roles: ["admin", "manager", "office_admin"] },
      { href: "/procurement/payables",    label: "Payables",          icon: IndianRupee,       roles: ["admin", "manager", "office_admin"] },
      { href: "/procurement/vendors",     label: "Vendors",           icon: Truck,             roles: ["admin", "manager", "office_admin", "accounts"] },
      { href: "/procurement/catalog",     label: "Item Catalog",      icon: Archive,           roles: ["admin", "manager", "office_admin"] },
      { href: "/procurement/inventory",   label: "Inventory",         icon: Warehouse,         roles: ["admin", "manager", "office_admin"] },
      { href: "/procurement/transfers",   label: "Transfers",         icon: ArrowLeftRight,    roles: ["admin", "manager", "office_admin"] },
      { href: "/procurement/consumption", label: "Consumption",       icon: UtensilsCrossed,   roles: ["admin", "manager", "office_admin"] },
      { href: "/procurement/amc",         label: "AMC Contracts",     icon: Wrench,            roles: ["admin", "manager", "office_admin"] },
      { href: "/procurement/verify",      label: "Verify Approval",   icon: ShieldCheck,       roles: ["admin", "manager", "office_admin"] },
    ],
  },
  {
    key: "facility",
    label: "Facility",
    icon: Wrench,
    items: [
      { href: "/facility",            label: "Dashboard",  icon: BarChart3Icon, roles: ["admin", "it_manager"] },
      { href: "/facility/issues",     label: "Issues",     icon: ClipboardList, roles: null },
      { href: "/facility/my-issues",  label: "My Issues",  icon: Ticket,        roles: null },
      { href: "/facility/assets",     label: "Assets",     icon: Server,        roles: ["admin", "manager", "it_manager", "it_technician"] },
      { href: "/facility/team-kpi",   label: "Team KPI",   icon: TrendingUp,    roles: ["admin", "it_manager"] },
    ],
  },
  {
    key: "admin",
    label: "Admin",
    icon: Settings,
    items: [
      { href: "/locations",      label: "Locations",      icon: MapPin,        roles: ["admin", "manager", "fms", "floor_manager"] },
      { href: "/audit-logs",     label: "Audit Logs",     icon: ClipboardList, roles: ["admin", "manager"] },
      { href: "/infrastructure", label: "Infrastructure", icon: Server,        roles: ["admin"] },
      { href: "/support",        label: "Support",        icon: LifeBuoy,      roles: ["admin"] },
      { href: "/settings",       label: "Settings",       icon: Settings,      roles: ["admin"] },
      { href: "/team",           label: "Team",           icon: UserPlus,      roles: ["admin", "manager", "sales_rep"] },
    ],
  },
];

function filterItems(items: NavItem[], userRole: string | null) {
  return items.filter(
    (item) => item.roles === null || (userRole && item.roles.includes(userRole))
  );
}

function findActiveSection(pathname: string, userRole: string | null): string | null {
  for (const section of navSections) {
    const visible = filterItems(section.items, userRole);
    if (visible.some((item) => pathname === item.href || pathname.startsWith(item.href + "/"))) {
      return section.key;
    }
  }
  return null;
}

function CollapsibleSection({
  section,
  isOpen,
  onToggle,
  pathname,
  userRole,
  onNavigate,
}: {
  section: NavSection;
  isOpen: boolean;
  onToggle: () => void;
  pathname: string;
  userRole: string | null;
  onNavigate: () => void;
}) {
  const visibleItems = filterItems(section.items, userRole);
  if (visibleItems.length === 0) return null;

  const isActive = visibleItems.some(
    (item) => pathname === item.href || pathname.startsWith(item.href + "/")
  );

  return (
    <div>
      <button
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          isActive
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
        )}
      >
        <section.icon className="h-5 w-5 shrink-0" />
        {section.label}
        <ChevronDown
          className={cn(
            "ml-auto h-4 w-4 shrink-0 transition-transform duration-200",
            isOpen ? "rotate-0" : "-rotate-90"
          )}
        />
      </button>
      {isOpen && (
        <div className="ml-4 mt-1 space-y-1 border-l border-sidebar-accent pl-3">
          {visibleItems.map((item) => {
            const itemActive =
              pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  itemActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const { sidebarOpen, setSidebarOpen } = useUiStore();
  const [userRole, setUserRole] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((json) => setUserRole(json.role ?? null))
      .catch(() => setUserRole(null));
  }, []);

  // Auto-expand the section containing the active route
  useEffect(() => {
    const active = findActiveSection(pathname, userRole);
    if (active) {
      setOpenSections((prev) => {
        if (prev.has(active)) return prev;
        const next = new Set(prev);
        next.add(active);
        return next;
      });
    }
  }, [pathname, userRole]);

  const toggleSection = useCallback((key: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const closeSidebar = useCallback(() => setSidebarOpen(false), [setSidebarOpen]);

  const visibleTopItems = filterItems(topNavItems, userRole);

  // Flat list of all searchable items (top items + section items + Help)
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    const results: { item: NavItem; section?: string }[] = [];
    for (const item of filterItems(topNavItems, userRole)) {
      if (item.label.toLowerCase().includes(q)) results.push({ item });
    }
    for (const section of navSections) {
      for (const item of filterItems(section.items, userRole)) {
        if (
          item.label.toLowerCase().includes(q) ||
          section.label.toLowerCase().includes(q)
        ) {
          results.push({ item, section: section.label });
        }
      }
    }
    const helpItem: NavItem = { href: "/help", label: "Help", icon: HelpCircle, roles: null };
    if ("help".includes(q)) results.push({ item: helpItem });
    return results;
  }, [search, userRole]);

  const clearSearch = useCallback(() => {
    setSearch("");
    searchRef.current?.blur();
  }, []);

  return (
    <>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={closeSidebar}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-sidebar text-sidebar-foreground transition-transform duration-200 lg:static lg:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Logo */}
        <div className="flex h-16 items-center justify-between px-6">
          <Link href="/dashboard" className="flex items-center gap-2">
            <img src="/logo-white.png" alt="The WorkVilla" className="h-8" />
          </Link>
          <button
            onClick={closeSidebar}
            className="rounded-md p-1 hover:bg-sidebar-accent lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-sidebar-foreground/40" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") clearSearch();
              }}
              placeholder="Search menu..."
              className="w-full rounded-md border border-sidebar-accent bg-sidebar-accent/30 py-1.5 pl-8 pr-8 text-sm text-sidebar-foreground placeholder:text-sidebar-foreground/40 focus:outline-none focus:ring-1 focus:ring-sidebar-accent"
            />
            {search && (
              <button
                onClick={clearSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-sidebar-foreground/40 hover:text-sidebar-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Scrollable nav area */}
        <nav className="flex-1 overflow-y-auto space-y-1 px-3 py-2">
          {searchResults ? (
            /* Search results — flat list */
            searchResults.length === 0 ? (
              <p className="px-3 py-4 text-sm text-sidebar-foreground/50 text-center">
                No matching menu items
              </p>
            ) : (
              searchResults.map(({ item, section }) => {
                const isActive =
                  pathname === item.href || pathname.startsWith(item.href + "/");
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => { clearSearch(); closeSidebar(); }}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                    )}
                  >
                    <item.icon className="h-5 w-5 shrink-0" />
                    <span className="flex-1">{item.label}</span>
                    {section && (
                      <span className="text-xs text-sidebar-foreground/40">{section}</span>
                    )}
                  </Link>
                );
              })
            )
          ) : (
            /* Normal navigation */
            <>
              {/* Top-level items */}
              {visibleTopItems.map((item) => {
                const isActive =
                  pathname === item.href || pathname.startsWith(item.href + "/");
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={closeSidebar}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                    )}
                  >
                    <item.icon className="h-5 w-5 shrink-0" />
                    {item.label}
                  </Link>
                );
              })}

              {/* Collapsible sections */}
              {navSections.map((section) => (
                <CollapsibleSection
                  key={section.key}
                  section={section}
                  isOpen={openSections.has(section.key)}
                  onToggle={() => toggleSection(section.key)}
                  pathname={pathname}
                  userRole={userRole}
                  onNavigate={closeSidebar}
                />
              ))}
            </>
          )}
        </nav>

        {/* Help — pinned at bottom, always visible */}
        <div className="shrink-0 border-t border-sidebar-accent px-3 py-3">
          <Link
            href="/help"
            onClick={closeSidebar}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              pathname === "/help" || pathname.startsWith("/help/")
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            )}
          >
            <HelpCircle className="h-5 w-5 shrink-0" />
            Help
          </Link>
        </div>
      </aside>
    </>
  );
}
