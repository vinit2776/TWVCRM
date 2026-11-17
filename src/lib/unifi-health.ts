/**
 * Maps a UniFi `stat/health` subsystem status to what the Network screens show.
 *
 * UniFi reports a healthy WAN as "ok" (then "warning" / "error" / "unknown"),
 * not "online". The screens used to test for the literal "online", so every
 * healthy site was shown as "Degraded".
 */
export type InternetState = "online" | "degraded" | "offline" | "unknown";

export function internetState(status: string | null | undefined): InternetState {
  switch ((status ?? "").toLowerCase()) {
    case "ok":
    case "online":
      return "online";
    case "warning":
    case "degraded":
      return "degraded";
    case "error":
    case "offline":
    case "down":
      return "offline";
    default:
      return "unknown";
  }
}

export const INTERNET_STATE_LABEL: Record<InternetState, string> = {
  online: "Online",
  degraded: "Degraded",
  offline: "Offline",
  unknown: "Unknown",
};

export const INTERNET_STATE_DOT: Record<InternetState, string> = {
  online: "bg-green-500",
  degraded: "bg-amber-500",
  offline: "bg-red-500",
  unknown: "bg-slate-400",
};

export const INTERNET_STATE_TEXT: Record<InternetState, string> = {
  online: "text-green-700",
  degraded: "text-amber-700",
  offline: "text-red-600",
  unknown: "text-muted-foreground",
};
