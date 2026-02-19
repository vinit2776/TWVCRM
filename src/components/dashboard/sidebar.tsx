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
  FolderOpen,
  UserPlus,
  Settings,
  ClipboardList,
  ScrollText,
  Wifi,
  IndianRupee,
  MapPin,
  DoorOpen,
  CalendarClock,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";
import { createClient } from "@/lib/supabase/client";

const allNavItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: null },
  { href: "/leads", label: "Leads", icon: Users, roles: ["admin", "manager", "sales_rep"] },
  { href: "/pipeline", label: "Pipeline", icon: GitBranch, roles: ["admin", "manager", "sales_rep"] },
  { href: "/activities", label: "Activities", icon: Activity, roles: ["admin", "manager", "sales_rep"] },
  { href: "/tasks", label: "Tasks", icon: CheckSquare, roles: ["admin", "manager", "sales_rep"] },
  { href: "/proposals", label: "Proposals", icon: FileText, roles: ["admin", "manager", "sales_rep"] },
  { href: "/invoices", label: "Invoices", icon: Receipt, roles: ["admin", "manager", "sales_rep"] },
  { href: "/contracts", label: "Contracts", icon: ScrollText, roles: ["admin", "manager", "sales_rep"] },
  { href: "/billing", label: "Billing", icon: IndianRupee, roles: ["admin", "manager", "sales_rep"] },
  { href: "/spaces", label: "Spaces", icon: DoorOpen, roles: null },
  { href: "/bookings", label: "Bookings", icon: CalendarClock, roles: null },
  { href: "/documents", label: "Documents", icon: FolderOpen, roles: ["admin", "manager", "sales_rep"] },
];

const bottomNavItems = [
  { href: "/team", label: "Team", icon: UserPlus },
  { href: "/settings", label: "Settings", icon: Settings },
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

  const isAdmin = userRole === "admin";

  // Filter nav items based on role (null = visible to all roles)
  const visibleNavItems = allNavItems.filter(
    (item) => item.roles === null || (userRole && item.roles.includes(userRole))
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

        {/* Nav items */}
        <nav className="flex-1 space-y-1 px-3 py-4">
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
        </nav>

        {/* Bottom nav */}
        <div className="border-t border-sidebar-accent px-3 py-4 space-y-1">
          {isAdmin && (
            <Link
              href="/vouchers"
              onClick={() => setSidebarOpen(false)}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                pathname === "/vouchers" || pathname.startsWith("/vouchers/")
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              )}
            >
              <Wifi className="h-5 w-5 shrink-0" />
              Vouchers
            </Link>
          )}
          {isAdmin && (
            <Link
              href="/locations"
              onClick={() => setSidebarOpen(false)}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                pathname === "/locations" || pathname.startsWith("/locations/")
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              )}
            >
              <MapPin className="h-5 w-5 shrink-0" />
              Locations
            </Link>
          )}
          {isAdmin && (
            <Link
              href="/audit-logs"
              onClick={() => setSidebarOpen(false)}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                pathname === "/audit-logs" || pathname.startsWith("/audit-logs/")
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              )}
            >
              <ClipboardList className="h-5 w-5 shrink-0" />
              Audit Logs
            </Link>
          )}
          {bottomNavItems.map((item) => {
            // Floor managers only see Settings, not Team
            if (userRole === "floor_manager" && item.href === "/team") return null;
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
      </aside>
    </>
  );
}
