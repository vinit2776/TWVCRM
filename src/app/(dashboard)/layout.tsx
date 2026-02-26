import { Sidebar } from "@/components/dashboard/sidebar";
import { DashboardMain } from "@/components/dashboard/dashboard-main";
import { MobileNav } from "@/components/shared/mobile-nav";
import { CommandPalette } from "@/components/shared/command-palette";
import { ReportIssueButton } from "@/components/support/report-issue-button";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      {/*
       * DashboardMain is a client component that:
       *   1. Wraps everything in <EnquiryNotificationsProvider> (single Supabase subscription)
       *   2. Renders <Header> (contains NotificationBell — reads from the shared context)
       *   3. Renders <EnquiryAlertBanner> (dismissable full-width banner + audio chime)
       *   4. Renders {children} (pages may also consume the same context)
       */}
      <DashboardMain>{children}</DashboardMain>
      <MobileNav />
      <CommandPalette />
      <ReportIssueButton />
    </div>
  );
}
