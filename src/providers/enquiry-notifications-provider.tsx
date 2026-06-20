"use client";

import { createContext, useContext } from "react";
import {
  useEnquiryNotificationsCore,
  type EnquiryItem,
  type EnquiryAlert,
  type WhatsAppInboundItem,
  type ResolutionOutcome,
} from "@/hooks/use-enquiry-notifications";

export type { EnquiryItem, EnquiryAlert, WhatsAppInboundItem, ResolutionOutcome };

type EnquiryNotificationsContextType = ReturnType<typeof useEnquiryNotificationsCore>;

const EnquiryNotificationsContext =
  createContext<EnquiryNotificationsContextType | null>(null);

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

export function useEnquiryNotifications() {
  const ctx = useContext(EnquiryNotificationsContext);
  if (!ctx) {
    throw new Error(
      "useEnquiryNotifications must be used within <EnquiryNotificationsProvider>"
    );
  }
  return ctx;
}
