"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/providers/current-user-provider";
import { ENQUIRY_VIEWER_HOME, ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";

/**
 * Swaps the full dashboard chrome (`full`) for a bare shell when the signed-in user's role
 * is confined to one page. Nothing from `full` mounts for them — no sidebar, search,
 * notification bells or realtime subscriptions — and any page other than their own is
 * replaced by a redirect before it renders.
 *
 * Until /api/me answers the role is unknown, so everyone briefly gets the full shell, as before.
 */
export function RoleShell({ full, children }: { full: ReactNode; children: ReactNode }) {
  const { user } = useCurrentUser();
  if (user?.role !== ENQUIRY_VIEWER_ROLE) return <>{full}</>;
  return <EnquiryViewerShell name={user.full_name}>{children}</EnquiryViewerShell>;
}

function EnquiryViewerShell({ name, children }: { name: string; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const allowed = pathname === ENQUIRY_VIEWER_HOME;

  useEffect(() => {
    if (!allowed) router.replace(ENQUIRY_VIEWER_HOME);
  }, [allowed, router]);

  async function handleSignOut() {
    await createClient().auth.signOut();
    router.push("/login");
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b bg-sidebar px-4 text-sidebar-foreground lg:px-6">
        <img src="/logo-white.png" alt="The WorkVilla" className="h-8" />
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-sm sm:inline">{name}</span>
          <Button variant="ghost" size="sm" onClick={handleSignOut} className="hover:bg-sidebar-accent">
            <LogOut className="mr-1.5 h-4 w-4" />
            Sign out
          </Button>
        </div>
      </header>
      <main className="flex-1 overflow-y-auto p-4 lg:p-6">{allowed ? children : null}</main>
    </div>
  );
}
