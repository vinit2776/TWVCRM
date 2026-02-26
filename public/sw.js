/**
 * TWV CRM — Service Worker for Web Push Notifications
 *
 * Handles push events sent by the server (via web-push + VAPID)
 * and shows OS-level notifications even when the CRM tab is minimised or closed.
 */

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
    icon: "/logo.png",
    badge: "/logo.png",
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
