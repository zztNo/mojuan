# 墨卷 · 一卷在手，人间可读

中式水墨风的公版书阅读应用。纯前端、零后端、可离线、可"安装"成手机/桌面 App。

## 功能特性

- **书源**：内置 108 卷公版书 —— 25 卷离线（经清洗去广告/夹注）、83 卷在线（维基文库实时取回并清洗）。在线书分小说、史部、典籍、诗词、文集、医部、兵书、笔记、佛道九类。
- **沉浸式阅读器**：翻页 / 滚动两种模式，昼夜间切换，宣纸/米黄等纸纹背景，字号行距可调。
- **听书**：基于浏览器语音合成（`speechSynthesis`），退出阅读器后通过悬浮球继续播放，进度条与播放键对齐。
- **书架 / 书城 / 榜单**：本地收藏、在线浏览、按分类与热度检索。
- **书源插件框架**：`classic` 与 `wikisource` 两种书源，支持自定义导入。

## 技术栈

- 原生 JavaScript（SPA + hash 路由），无框架、无构建步骤。
- **PWA**：`manifest.webmanifest` + `sw.js` 离线缓存，支持"添加到主屏幕 / 安装"。
- 离线内容按书分片懒加载（`js/books/<id>.js`）。

## 安装为 App（推荐）

墨卷本身是完整 PWA，无需应用商店即可当原生 App 用：

- **手机**：iOS 用 Safari 打开 → 分享 →「添加到主屏幕」；安卓用 Chrome 打开 → 菜单 →「安装应用」。之后桌面出现图标，全屏打开、离线可用。
- **桌面**：Chrome / Edge 打开后，地址栏右侧点「安装」→ 变成独立窗口。

## 本地运行

需通过 HTTP 访问（`file://` 下 Service Worker 与在线取书不可用）：

```bash
cd mojuan
python -m http.server 8768
# 浏览器打开 http://127.0.0.1:8768/
```

## 构建单文件版

`tools/build_standalone.py` 会把所有资源内联进一个 `mojuan-offline.html`，双击即可用、便于分享：

```bash
python tools/build_standalone.py
```

## 目录结构

```
index.html              入口
css/style.css           样式
js/app.js               主逻辑（路由 / 阅读器 / 听书 / PWA）
js/books/<id>.js        离线书分片内容
js/sources.js           书源插件框架
manifest.webmanifest    PWA 清单
sw.js                   Service Worker（离线缓存）
icons/                  应用图标
tools/                  抓取、清洗、分片、构建脚本
```

## 版权与许可

- 书籍内容均为**公共领域公版书**（不含仍在版权期内的文本）。
- 本仓库**代码**以 MIT 许可证开源，详见 [LICENSE](LICENSE)。
