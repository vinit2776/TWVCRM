"use client";

import { Header } from "@/components/dashboard/header";
import { EnquiryAlertBanner } from "@/components/dashboard/enquiry-alert-banner";
import { PushNotificationPrompt } from "@/components/dashboard/push-notification-prompt";
import { InstallPrompt } from "@/components/dashboard/install-prompt";
import { EnquiryNotificationsProvider } from "@/providers/enquiry-notifications-provider";
import { useServiceWorker } from "@/hooks/use-service-worker";
import { FlowGuideHint } from "@/components/shared/flow-guide-hint";

/**
 * Client wrapper for the dashboard layout's main content area.
 *
 * Provides:
 *   - CurrentUserProvider: fetches /api/me ONCE and shares via context so that
 *     sidebar, header, approval-bell, notification-bell, and all pages can read
 *     the current user without each issuing their own redundant round-trips.
 *   - EnquiryNotificationsProvider: single Supabase realtime subscription shared
 *     across Header → NotificationBell, EnquiryAlertBanner, Dashboard widget, Leads.
 */
export function DashboardMain({ children }: { children: React.ReactNode }) {
  useServiceWorker();

  return (
    <EnquiryNotificationsProvider>
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        {/* One-time prompt to enable OS push notifications */}
        <PushNotificationPrompt />
        {/* One-time prompt to install PWA */}
        <InstallPrompt />
        {/* Real-time full-width alert banner (audio chime + banner) */}
        <EnquiryAlertBanner />
        <main className="flex-1 overflow-y-auto p-4 pb-20 lg:p-6 lg:pb-6">
          {children}
        </main>
      </div>
      {/* Contextual idle-triggered flow guide — zero infra, sessionStorage only */}
      <FlowGuideHint />
    </EnquiryNotificationsProvider>
  );
}
