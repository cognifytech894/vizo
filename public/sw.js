// Vizo service worker: shows push notifications and opens the app page they point to.
// It does no caching, so the app itself always loads fresh from the server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  e.waitUntil(self.registration.showNotification(String(d.title || 'Vizo').slice(0, 80), {
    body: String(d.body || '').slice(0, 200), icon: '/icon.svg', badge: '/icon.svg', tag: d.tag || undefined, data: { url: d.url || '/?notif=1' },
  }));
});

// Opens only pages of this app (same origin); an existing Vizo tab is reused when there is one
self.addEventListener('notificationclick', e => {
  e.notification.close();
  let url;
  try { url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin); } catch { return; }
  if (url.origin !== self.location.origin) return;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const w = list.find(c => new URL(c.url).origin === url.origin);
    if (!w) return self.clients.openWindow(url.href);
    return w.navigate(url.href).then(c => (c || w).focus()).catch(() => self.clients.openWindow(url.href));
  }));
});
