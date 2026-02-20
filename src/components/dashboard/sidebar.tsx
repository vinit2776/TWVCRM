"use client";

import { useState, useEffect } from "react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";
import { createClient } from "@/lib/supabase/client";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles: string[] | null; // null = visible to all roles
};

const allNavItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: null },
  { href: "/leads", label: "Leads", icon: Users, roles: null },
  { href: "/pipeline", label: "Pipeline", icon: GitBranch, roles: null },
  { href: "/activities", label: "Activities", icon: Activity, roles: null },
  { href: "/tasks", label: "Tasks", icon: CheckSquare, roles: null },
  { href: "/proposals", label: "Proposals", icon: FileText, roles: null },
  { href: "/invoices", label: "Invoices", icon: Receipt, roles: null },
  { href: "/contracts", label: "Contracts", icon: ScrollText, roles: null },
  { href: "/billing", label: "Billing", icon: IndianRupee, roles: null },
  { href: "/accounting", label: "Accounting", icon: Calculator, roles: null },
  { href: "/bookings", label: "Bookings", icon: CalendarClock, roles: null },
  { href: "/vouchers", label: "Vouchers", icon: Wifi, roles: null },
];

const adminNavItems = [
  { href: "/locations", label: "Locations", icon: MapPin, roles: ["admin", "manager"] },
  { href: "/audit-logs", label: "Audit Logs", icon: ClipboardList, roles: ["admin", "manager"] },
  { href: "/infrastructure", label: "Infrastructure", icon: Server, roles: ["admin"] },
  { href: "/support", label: "Support", icon: LifeBuoy, roles: ["admin"] },
  { href: "/settings", label: "Settings", icon: Settings, roles: ["admin"] },
  { href: "/team", label: "Team", icon: UserPlus, roles: ["admin", "manager", "sales_rep"] },
];

export function Sidebar() {
  const pathname = usePathname();
  const { sidebarOpen, setSidebarOpen } = useUiStore();
  const [userRole, setUserRole] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (user) {
        const { data } = await supabase
          .from("users")
          .select("role")
          .eq("auth_id", user.id)
          .single();
        setUserRole(data?.role || "sales_rep");
      }
    });
  }, []);

  // Filter nav items based on role (null = visible to all roles)
  const visibleNavItems = allNavItems.filter(
    (item) => item.roles === null || (userRole && item.roles.includes(userRole))
  );

  const visibleAdminItems = adminNavItems.filter(
    (item) => userRole && item.roles.includes(userRole)
  );

  return (
    <>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
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
            onClick={() => setSidebarOpen(false)}
            className="rounded-md p-1 hover:bg-sidebar-accent lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable nav area */}
        <nav className="flex-1 overflow-y-auto space-y-1 px-3 py-4">
          {visibleNavItems.map((item) => {
            const isActive =
              pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setSidebarOpen(false)}
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

          {/* Admin items inside scrollable area */}
          {visibleAdminItems.length > 0 && (
            <div className="border-t border-sidebar-accent pt-4 mt-3 space-y-1">
              {visibleAdminItems.map((item) => {
                const isActive =
                  pathname === item.href || pathname.startsWith(item.href + "/");
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setSidebarOpen(false)}
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
            </div>
          )}
        </nav>

        {/* Help — pinned at bottom, always visible */}
        <div className="shrink-0 border-t border-sidebar-accent px-3 py-3">
          <Link
            href="/help"
            onClick={() => setSidebarOpen(false)}
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
