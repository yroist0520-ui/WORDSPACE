/* WORDSPACE offline service worker
 * 托管部署的访问凭据通过 SW 脚本 URL 的 query 传入（register('./sw.js' + location.search)）。
 * 平台对不带凭据的同源请求一律 403，因此这里为静态资源与导航请求自动补齐凭据。
 * 本地 / 无凭据环境下 CRED 为空，行为退化为普通缓存策略。
 *
 * 缓存策略：
 *  - 带哈希的静态资源（/assets/*.js|css、图标、字体）→ 缓存优先 + 后台刷新，重复访问秒开首屏
 *  - 导航与词库 JSON → 网络优先、失败回退缓存，保证拿到最新页面
 */
// 每次内置词库 / 首屏结构有变化时递增，强制淘汰旧 index.html 缓存，
// 避免弱网回退命中旧脚本（旧逻辑不含专四/专八等新增词库）。
const CACHE = 'wordspace-shell-v9'
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

  // 词库分片 / 清单：v5 起大包拆成 33 个小分片，单片 gzip 后约 80~120KB。
  // 缓存优先 + 后台校验刷新：二次启动秒开，且只有「能被 JSON.parse 且结构正确」
  // 的响应才会写入缓存，杜绝弱网下 200 但 body 截断的坏副本被永久命中。
  const isVocabChunk = /\/vocab\/chunks\/.*\.json$/.test(url.pathname)
  const isVocabManifest = /\/vocab\/manifest\.json$/.test(url.pathname)
  const isLegacyVocabJson = /\/vocab\/[^/]+\.json$/.test(url.pathname)
  if (isVocabChunk || isVocabManifest) {
    const valid = (text, isManifest) => {
      try {
        const o = JSON.parse(text)
        return isManifest
          ? !!(o && Array.isArray(o.packs) && o.packs.length)
          : !!(o && o.pack && Array.isArray(o.decks))
      } catch { return false }
    }
    event.respondWith(
      caches.match(finalReq).then(async (cached) => {
        // 分片命中缓存立即返回，绝不额外发一次网络请求：慢网下重复请求
        // 会与页面下载抢带宽，是线上「全部分片被 abort」的诱因之一。
        if (cached && isVocabChunk) return cached
        try {
          const res = await fetch(finalReq)
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone()
            // 校验与写缓存全部放到后台，不阻塞本次响应；
            // 只有结构完整的 JSON 才进缓存，杜绝截断副本被永久命中。
            void (async () => {
              try {
                const text = await copy.text()
                if (valid(text, isVocabManifest)) {
                  const c = await caches.open(CACHE)
                  await c.put(finalReq, new Response(text, {
                    status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' },
                  }))
                }
              } catch { /* 损坏响应不缓存 */ }
            })()
          }
          return res || cached || Response.error()
        } catch {
          return cached || Response.error()
        }
      })
    )
    return
  }
  // 旧版整包（兜底路径）：完全交给页面代码，不缓存
  if (isLegacyVocabJson) {
    event.respondWith(fetch(finalReq))
    return
  }

  // 带哈希的构建产物与图标/字体：缓存优先，重复访问秒开；后台静默刷新缓存
  const isHashedAsset = /\/(?:assets\/|icons?\/)/.test(url.pathname)
    || /\.(?:js|css|woff2?|png|ico|svg)$/.test(url.pathname)

  if (isHashedAsset) {
    event.respondWith(
      caches.match(finalReq).then((cached) => {
        const network = fetch(finalReq).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(finalReq, copy)).catch(() => {})
          }
          return res
        }).catch(() => cached)
        return cached || network
      })
    )
    return
  }

  // 其余（导航、manifest、词库 JSON 等）：网络优先，失败回退缓存
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
