// content-hash: ea145b1c3fe5
/* 墨卷 · 离线缓存 */
const CACHE = 'mojuan-v57';
const ASSETS = [
  './',
  './index.html',
  './js/data.js',
  './js/sources.js',
  './js/classics-meta.js',
  './js/classics.js',
  './js/wikisource-clean.js',
  './js/source-wikisource.js',
  './js/voices.js',
  './js/importer.js',
  './js/app.js',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './manifest.webmanifest',
  './css/style.css',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './img/paper.webp'
];
/* 正文分片：不在 install 里等，装好后再慢慢补，不拖慢首屏 */
const SHARDS = ['baijiaxing', 'caocao', 'chuci', 'daodejing', 'daxue', 'dizigui', 'guwen', 'huajianji', 'lunyu', 'mengzi', 'nalan', 'nantang', 'qianjia', 'qianzi', 'sanzi', 'shenglv', 'shijing', 'shuimo', 'songci300', 'tang300', 'youmengying', 'youxueqionglin', 'zengguang', 'zhongyong', 'zhuzi'].map((id) => './js/books/' + id + '.js');

self.addEventListener('install', (e) => {
  /* 逐个缓存：某个路径 404 不应让整个 Service Worker 安装失败 */
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(ASSETS.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

/* 正文分片不抢首屏带宽：等页面闲下来（load 后 5 秒）由主线程叫一声再补缓存 */
self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'prefetch-shards') return;
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      SHARDS.reduce((p, u) => p.then(() => c.match(u).then((hit) => hit || c.add(u).catch(() => {}))), Promise.resolve())
    ).catch(() => {})
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
  )).then(() => self.clients.claim()));
});

/* 先给缓存保证离线可用，同时后台取新版，下次打开即为最新 */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const network = fetch(req).then((res) => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => req.mode === 'navigate'
    ? caches.match('./index.html')
    : new Response('', { status: 503, statusText: 'Offline' }));
  e.waitUntil(network.catch(() => {}));
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || network));
});
