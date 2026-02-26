"use client";

import { createContext, useContext } from "react";
import {
  useEnquiryNotificationsCore,
  type EnquiryNotificationItem,
  type EnquiryAlert,
} from "@/hooks/use-enquiry-notifications";

// Re-export types for consumers
export type { EnquiryNotificationItem, EnquiryAlert };

type EnquiryNotificationsContextType = ReturnType<typeof useEnquiryNotificationsCore>;

const EnquiryNotificationsContext =
  createContext<EnquiryNotificationsContextType | null>(null);

/**
 * Provides shared enquiry notification state to the entire dashboard layout.
 * Wrap once — prevents duplicate Supabase subscriptions.
 */
export function EnquiryNotificationsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const value = useEnquiryNotificationsCore();
  return (
    <EnquiryNotificationsContext.Provider value={value}>
      {children}
    </EnquiryNotificationsContext.Provider>
  );
}

/** Use inside any component under EnquiryNotificationsProvider */
export function useEnquiryNotifications() {
  const ctx = useContext(EnquiryNotificationsContext);
  if (!ctx) {
    throw new Error(
      "useEnquiryNotifications must be used within <EnquiryNotificationsProvider>"
    );
  }
  return ctx;
}
