/**
 * Customer Value — which OneGrid meter measures a whole center.
 *
 * A center's meter can be recorded in two places: the electricity connections
 * (a meter attached to a utility connection) and the center's OneGrid setup (its
 * default device, the one the hourly energy ledger capture reads). The capture
 * has always used the setup's default, so a center can have a full ledger and no
 * connection row. Both are honoured here, so the electricity share reads the same
 * meter the ledger holds.
 *
 * The ledger is read one meter at a time (a main plus a sub meter would count
 * the same power twice), so more than one candidate is only accepted when the
 * center's default device is among them: that is the explicit "this one is the
 * whole center" choice.
 */

export interface OnegridSetup {
  enabled: boolean;
  defaultDeviceId: string | null;
}

export type MeterChoice =
  | { status: "ok"; deviceId: string }
  | { status: "no_meter" }
  | { status: "several_meters" };

export function chooseMeter(connectionDeviceIds: Array<string | null | undefined>, setup: OnegridSetup | null): MeterChoice {
  const fromConnections = [...new Set(connectionDeviceIds.filter((d): d is string => Boolean(d)))];
  const fallback = setup?.enabled && setup.defaultDeviceId ? setup.defaultDeviceId : null;

  if (fromConnections.length === 1) return { status: "ok", deviceId: fromConnections[0] };
  if (fromConnections.length > 1) {
    return fallback && fromConnections.includes(fallback) ? { status: "ok", deviceId: fallback } : { status: "several_meters" };
  }
  return fallback ? { status: "ok", deviceId: fallback } : { status: "no_meter" };
}
