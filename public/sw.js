// Verdex app shell. Navigations go network first and fall back to the cached shell offline;
// hashed bundles, logos and images are served from the cache and refreshed in the background.
// Prices, quotes and wallet traffic never touch the cache.
const CACHE = 'verdex-shell-v1'
const STATIC = /^\/(assets|img|logos|icons|design|brand)\//

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((cache) => cache.put('/', res.clone()))
          return res
        })
        .catch(() => caches.match('/').then((hit) => hit ?? Response.error())),
    )
    return
  }

  if (STATIC.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(request)
        const refresh = fetch(request)
          .then((res) => {
            if (res.ok) cache.put(request, res.clone())
            return res
          })
          .catch(() => hit)
        return hit ?? refresh
      }),
    )
  }
})

// Push notifications: fills, runs and trades of the wallets this device follows (see /notifications).
self.addEventListener('push', (event) => {
  let d = {}
  try { d = event.data ? event.data.json() : {} } catch { d = { body: event.data && event.data.text() } }
  event.waitUntil(self.registration.showNotification(d.title || 'Verdex', { body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: d.url || '/' } }))
})
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) { c.navigate(url); return c.focus() }
    return self.clients.openWindow(url)
  }))
})
