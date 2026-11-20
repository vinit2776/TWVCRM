"use client";

import { use } from "react";
import { ContactBackContent } from "@/components/leads/contact-back-content";

/** Calling back someone who filled in a public form, on its own page. */
export default function ContactBackPage({ params }: { params: Promise<{ enquiryId: string }> }) {
  const { enquiryId } = use(params);
  return <ContactBackContent enquiryId={enquiryId} />;
}
