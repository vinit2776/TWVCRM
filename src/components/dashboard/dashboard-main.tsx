"use client";

import { Header } from "@/components/dashboard/header";
import { EnquiryAlertBanner } from "@/components/dashboard/enquiry-alert-banner";
import { PushNotificationPrompt } from "@/components/dashboard/push-notification-prompt";
import { EnquiryNotificationsProvider } from "@/providers/enquiry-notifications-provider";

/**
 * Client wrapper for the dashboard layout's main content area.
 *
 * Provides EnquiryNotificationsProvider once so that:
 *   - Header → NotificationBell (bell icon + count)
 *   - EnquiryAlertBanner (full-width dismissable banner)
 *   - Dashboard page widget
 *   - Leads page pinned section
 * …all share the SAME Supabase realtime subscription (no duplicate connections).
 */
export function DashboardMain({ children }: { children: React.ReactNode }) {
  return (
    <EnquiryNotificationsProvider>
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        {/* One-time prompt to enable OS push notifications */}
        <PushNotificationPrompt />
        {/* Real-time full-width alert banner (audio chime + banner) */}
        <EnquiryAlertBanner />
        <main className="flex-1 overflow-y-auto p-4 pb-20 lg:p-6 lg:pb-6">
          {children}
        </main>
      </div>
    </EnquiryNotificationsProvider>
  );
}
