"use client";

import { Menu, Search, LogOut, HelpCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useUiStore } from "@/stores/ui-store";
import { createClient } from "@/lib/supabase/client";
import { getInitials } from "@/lib/utils";
import { useState, useEffect } from "react";
import { NotificationBell } from "@/components/dashboard/notification-bell";

export function Header() {
  const { toggleSidebar } = useUiStore();
  const router = useRouter();
  const [userEmail, setUserEmail] = useState("");
  const [userName, setUserName] = useState("");

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        setUserEmail(user.email || "");
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
        {/* User info */}
        <div className="hidden sm:flex items-center gap-3">
          <div className="text-right">
            <p className="text-sm font-medium leading-none">{userName}</p>
            <p className="text-xs text-muted-foreground">{userEmail}</p>
          </div>
          <Avatar className="h-8 w-8">
            <AvatarFallback className="text-xs">
              {getInitials(userName || "U")}
            </AvatarFallback>
          </Avatar>
        </div>

        {/* Enquiry notifications */}
        <NotificationBell />

        {/* Help */}
        <Button variant="ghost" size="icon" asChild title="Help & User Manual">
          <Link href="/help">
            <HelpCircle className="h-4 w-4" />
          </Link>
        </Button>

        {/* Sign out */}
        <Button variant="ghost" size="icon" onClick={handleSignOut} title="Sign out">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
