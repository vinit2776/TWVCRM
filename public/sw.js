/**
 * TWV CRM — Service Worker
 *
 * Handles:
 *  1. Web Push notifications (existing)
 *  2. Offline caching with app-shell strategy
 */

const CACHE_NAME = "twv-crm-v2";
const OFFLINE_URL = "/offline";

// ─── Install: precache app shell ───────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(["/", OFFLINE_URL])
    )
  );
  self.skipWaiting();
});

// ─── Activate: clean old caches, take control ──────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ─── Fetch: route-based caching strategy ───────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== "GET") return;

  // Skip cross-origin requests
  if (url.origin !== self.location.origin) return;

  // Skip API and auth routes — always go to network
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
    return;
  }

  // Static assets (content-hashed) → cache-first
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            return response;
          })
      )
    );
    return;
  }

  // Navigation requests → network-first, fallback to offline page
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(OFFLINE_URL))
    );
    return;
  }

  // Other same-origin GETs → stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => cached);

      return cached || fetchPromise;
    })
  );
});

// ─── Push Notifications (existing) ─────────────────────────────────────────────

// Receive push from server
self.addEventListener("push", function (event) {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: "New Enquiry", body: event.data.text() };
  }

  const title = data.title || "New Enquiry — TWV CRM";
  const options = {
    body: data.body || "A new enquiry has been received.",
    icon: "/icons/icon-192x192.png",
    badge: "/icons/icon-192x192.png",
    data: { url: data.url || "/leads" },
    vibrate: [200, 100, 200],
    requireInteraction: true,
    tag: data.tag || "enquiry-notification", // collapse same-tag notifications
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Click on notification → focus/open the CRM tab
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/leads";

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (clientList) {
        // Focus an existing CRM tab if one is open
        for (const client of clientList) {
          if ("focus" in client) {
            client.postMessage({ type: "NAVIGATE", url: targetUrl });
            return client.focus();
          }
        }
        // No tab found — open a new one
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
  );
});
