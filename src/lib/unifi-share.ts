/**
 * Shared helpers for UniFi voucher sharing.
 * Used by ApprovalBell (dashboard header) and UnifiPanel (vouchers page).
 */

export interface ShareableVoucher {
  code: string;
  ssid: string | null;
  durationMinutes: number;
  quota: number;
  locationName: string;
}

export function fmtDuration(minutes: number): string {
  if (!minutes) return "—";
  if (minutes < 60)   return `${minutes} min`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} hr`;
  const days = Math.floor(minutes / 1440);
  const remaining = minutes % 1440;
  if (remaining === 0) return `${days} day${days !== 1 ? "s" : ""}`;
  const hrs = Math.round(remaining / 60);
  return `${days}d ${hrs}h`;
}

/**
 * Builds a plain-text, WhatsApp-friendly message to share with the customer.
 *
 * When the network name could not be fetched (`ssid` null) the message does not
 * name one. It used to fall back to "WorkVilla Clients" — Nungambakkam's guest
 * network — which sent customers at other sites looking for a network that
 * does not exist there.
 */
export function buildShareableMessage(voucher: ShareableVoucher): string {
  const duration = fmtDuration(voucher.durationMinutes);
  const devices  = voucher.quota === 1 ? "1 device" : `up to ${voucher.quota} devices`;
  const ssid     = voucher.ssid?.trim() || null;
  const location = voucher.locationName || "The WorkVilla";

  return [
    `📶 *WiFi Access — ${location}*`,
    ``,
    ...(ssid ? [`Network:  ${ssid}`] : []),
    `Code:     ${voucher.code}`,
    `Valid for: ${duration}`,
    `Devices:  ${devices}`,
    ``,
    `*How to connect:*`,
    ssid
      ? `1. Connect to "${ssid}" on your device`
      : `1. Connect to the ${location} guest WiFi on your device`,
    `2. Open any browser`,
    `3. Enter your code at the login page`,
    ``,
    `— The WorkVilla Team`,
  ].join("\n");
}
