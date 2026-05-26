"use client";

import { Menu, Search, LogOut, HelpCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUiStore } from "@/stores/ui-store";
import { createClient } from "@/lib/supabase/client";
import { getInitials } from "@/lib/utils";
import { useState, useEffect } from "react";
import { NotificationBell } from "@/components/dashboard/notification-bell";
import { ApprovalBell } from "@/components/dashboard/approval-bell";
import { InAppNotificationBell } from "@/components/dashboard/in-app-notification-bell";

export function Header() {
  const { toggleSidebar } = useUiStore();
  const router = useRouter();
  const [userEmail, setUserEmail] = useState("");
  const [userName, setUserName] = useState("");
  const [userRole, setUserRole] = useState("");

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      setUserEmail(user.email || "");

      // Fetch full_name from the users table (auth metadata may not have it for email/password users)
      const { data: dbUser } = await supabase
        .from("users")
        .select("full_name, role")
        .eq("auth_id", user.id)
        .single();

      if (dbUser) {
        setUserName(dbUser.full_name || user.email || "");
        setUserRole(dbUser.role || "");
      } else {
        // Fallback to auth metadata
        setUserName(user.user_metadata?.full_name || user.email || "");
      }
    });
  }, []);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  function openCommandPalette() {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true })
    );
  }

  return (
    <header className="flex h-16 items-center gap-4 border-b bg-background px-4 lg:px-6">
      {/* Mobile menu button */}
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={toggleSidebar}
      >
        <Menu className="h-5 w-5" />
      </Button>

      {/* Search - opens command palette */}
      <button
        onClick={openCommandPalette}
        className="flex-1 max-w-md"
      >
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <div className="flex items-center justify-between w-full rounded-md bg-muted/50 pl-9 pr-3 py-2 text-sm text-muted-foreground cursor-pointer hover:bg-muted transition-colors">
            <span>Search...</span>
            <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px]">
              <span className="text-xs">&#8984;</span>K
            </kbd>
          </div>
        </div>
      </button>

      <div className="flex items-center gap-3 ml-auto">
        {/* Notification group — three distinct alert streams, grouped visually */}
        <div className="flex items-center rounded-md border border-border/60 bg-muted/40 px-1 gap-0.5" title="Notifications">
          {/* Pending approvals (admin/manager only) */}
          <ApprovalBell />
          {/* In-app notifications (facility tickets, comments, reassignments) */}
          <InAppNotificationBell />
          {/* Enquiry notifications (new leads, re-enquiries, WhatsApp) */}
          <NotificationBell />
        </div>

        {/* Help */}
        <Button variant="ghost" size="icon" asChild title="Help & User Manual">
          <Link href="/help">
            <HelpCircle className="h-4 w-4" />
          </Link>
        </Button>

        {/* User menu — click name/avatar to get dropdown with logout */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="hidden sm:flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <div className="text-right">
                <p className="text-sm font-medium leading-none">{userName || "—"}</p>
                {userRole && (
                  <p className="text-xs text-muted-foreground capitalize">{userRole.replace(/_/g, " ")}</p>
                )}
              </div>
              <Avatar className="h-8 w-8">
                <AvatarFallback className="text-xs">
                  {getInitials(userName || "U")}
                </AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56" sideOffset={8}>
            {/* Profile info */}
            <div className="px-3 py-2">
              <p className="text-sm font-medium">{userName || "—"}</p>
              <p className="text-xs text-muted-foreground truncate">{userEmail}</p>
            </div>
            <DropdownMenuSeparator />
            {/* Logout */}
            <button
              onClick={handleSignOut}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors rounded-sm"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
