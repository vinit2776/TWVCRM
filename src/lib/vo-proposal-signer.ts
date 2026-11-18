import { z } from "zod";

/** Signer the customer names when accepting a Virtual Office proposal. */
export const signerSchema = z.object({
  name: z.string().trim().min(2, "Enter the signer's full name").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid signer email").max(200),
  phone: z
    .string()
    .trim()
    .max(20)
    .refine((v) => v.replace(/\D/g, "").length >= 10 && /^[+\d\s()-]+$/.test(v), "Enter a valid signer phone number"),
});

export type VoSigner = z.infer<typeof signerSchema>;

/** Reason staff give when withdrawing a VO proposal. */
export const withdrawReasonSchema = z.object({ reason: z.string().trim().min(3, "Give a short reason").max(500) });

/** Public customer page for a VO proposal; the token is the only credential. */
export function voProposalViewUrl(token: string, baseUrl: string | undefined | null): string {
  const base = (baseUrl || "https://crm.theworkvilla.com").replace(/\/+$/, "");
  return `${base}/vo-proposal/${token}`;
}

/** Signer details to show staff, or null when none were captured. */
export function signerForDisplay(p: {
  signer_name?: string | null;
  signer_email?: string | null;
  signer_phone?: string | null;
}): { name: string; email: string; phone: string } | null {
  if (!p.signer_name && !p.signer_email && !p.signer_phone) return null;
  return { name: p.signer_name ?? "", email: p.signer_email ?? "", phone: p.signer_phone ?? "" };
}
