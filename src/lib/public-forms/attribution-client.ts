"use client";

import { ATTRIBUTION_KEYS, type Attribution } from "./attribution";

const STORAGE_KEY = "twv_attribution";
const URL_KEYS = ATTRIBUTION_KEYS.filter(
  (k) => !["fbp", "fbc", "landing_url", "referrer"].includes(k)
);

function readCookie(name: string): string | undefined {
  const match = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

/** Capture the ad parameters from the landing URL once per browser session, so they are
 *  still available after the customer reloads or the URL is cleaned. Never throws — a
 *  blocked sessionStorage just means this submission carries no attribution. */
export function readAttribution(): Attribution {
  try {
    let stored: Attribution = {};
    try {
      stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}") as Attribution;
    } catch {
      stored = {};
    }

    const params = new URLSearchParams(window.location.search);
    const fromUrl: Attribution = {};
    for (const key of URL_KEYS) {
      const value = params.get(key);
      if (value) fromUrl[key] = value;
    }

    // A fresh landing with ad parameters replaces older ones; otherwise keep what we had.
    const base: Attribution =
      Object.keys(fromUrl).length > 0
        ? { ...fromUrl, landing_url: window.location.href.split("#")[0], referrer: document.referrer || undefined }
        : stored;

    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(base));
    } catch {
      /* storage blocked — carry on without persisting */
    }

    // The Meta cookies change independently of the URL, so always read them fresh.
    return { ...base, fbp: readCookie("_fbp"), fbc: readCookie("_fbc") };
  } catch {
    return {};
  }
}
