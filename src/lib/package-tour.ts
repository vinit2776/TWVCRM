// Per-browser preferences for the packages guided tour. Kept in localStorage
// because they are conveniences, not business data; every access is guarded so
// private windows or blocked storage just show the defaults.
export const TOUR_SEEN_KEY = "twv.packages.tourSeen";
export const TIPS_OFF_KEY = "twv.packages.tipsOff";
export const TIPS_EVENT = "twv:package-tips-changed";

export function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeFlag(key: string, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // storage unavailable: the preference simply won't persist
  }
}
