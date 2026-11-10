/* WORDSPACE offline service worker — network first, cache fallback
 * 托管部署的访问凭据通过 SW 脚本 URL 的 query 传入（register('./sw.js' + location.search)）。
 * 平台对不带凭据的同源请求一律 403，因此这里为静态资源与导航请求自动补齐凭据。
 * 本地 / 无凭据环境下 CRED 为空，行为退化为普通网络优先缓存。
 */
const CACHE = 'wordspace-shell-v3'
const CRED = self.location.search || ''

function withCred(raw) {
  var url
  try { url = new URL(raw, self.location.href) } catch { return { url: raw, changed: false } }
  if (url.origin !== self.location.origin || !CRED) return { url: url.href, changed: false }
  var params = new URLSearchParams(CRED.replace(/^\?/, ''))
  var changed = false
  params.forEach(function (v, k) {
    if (!url.searchParams.has(k)) { url.searchParams.set(k, v); changed = true }
  })
  return { url: url.href, changed: changed }
}

const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './apple-touch-icon.png']
  .map(function (p) { return withCred(p).url })

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(async (cache) => {
        // 逐项缓存：单个资源失败不应导致整个 SW 安装失败
        await Promise.all(CORE.map(async (u) => {
          try {
            const res = await fetch(u)
            if (res && res.ok) await cache.put(u, res)
          } catch { /* 忽略不可用资源 */ }
        }))
      })
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  let url
  try { url = new URL(req.url) } catch { return }
  if (url.origin !== self.location.origin) return

  const target = withCred(req.url)

  // 从主屏幕以无凭据地址启动时，先把导航重定向到带凭据地址，避免 403 拦截页
  if (req.mode === 'navigate' && target.changed) {
    event.respondWith(Response.redirect(target.url, 302))
    return
  }

  const finalReq = target.url === req.url ? req : new Request(target.url, req)
  event.respondWith(
    fetch(finalReq)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(finalReq, copy)).catch(() => {})
        }
        return res
      })
      .catch(async () => {
        const cached = await caches.match(finalReq)
        if (cached) return cached
        if (req.mode === 'navigate') {
          const shell = await caches.match(CORE[1])
          if (shell) return shell
        }
        return Response.error()
      })
  )
})
