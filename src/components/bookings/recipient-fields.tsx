"use client";

/**
 * RecipientFields — the To and CC a staff member can set before emailing a customer.
 * To starts from the booking's saved email and can be changed; CC takes several
 * addresses separated by commas or spaces.
 */

import { Input } from "@/components/ui/input";
import { parseEmailList, MAX_CC, EMAIL_PATTERN } from "@/lib/email-recipients";

interface Props {
  to: string;
  cc: string;
  onTo: (v: string) => void;
  onCc: (v: string) => void;
  /** The email saved on the booking, named so staff can see what they are changing. */
  savedEmail: string | null;
  idPrefix: string;
}

/** True when To is a valid address and every CC entry is, within the cap. */
export function recipientsValid(to: string, cc: string): boolean {
  const { emails, invalid } = parseEmailList(cc);
  return EMAIL_PATTERN.test(to.trim()) && invalid.length === 0 && emails.length <= MAX_CC;
}

export function RecipientFields({ to, cc, onTo, onCc, savedEmail, idPrefix }: Props) {
  const ccInvalid = parseEmailList(cc).invalid;
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor={`${idPrefix}-to`}>To</label>
        <Input id={`${idPrefix}-to`} type="email" value={to} onChange={(e) => onTo(e.target.value)} placeholder="name@company.com" />
        <p className="text-[11px] text-muted-foreground">
          {savedEmail
            ? `The booking has ${savedEmail}. Change it to send to someone else.`
            : "No email on the booking. Enter one to send."}
        </p>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor={`${idPrefix}-cc`}>CC (optional)</label>
        <Input id={`${idPrefix}-cc`} value={cc} onChange={(e) => onCc(e.target.value)} placeholder="another@company.com, third@company.com" />
        {ccInvalid.length > 0 && (
          <p className="text-[11px] text-red-600">Check this address: {ccInvalid[0]}</p>
        )}
      </div>
    </div>
  );
}
