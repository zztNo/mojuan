# 墨卷 APK / Windows 安装包 生成指南

墨卷已经是一个标准 PWA（带 `manifest.webmanifest` 和 `sw.js`），所以出手机/桌面安装包走官方 **PWABuilder** 最省事，不需要装 Android Studio。

## 第 1 步：把 PWA 挂到公网（GitHub Pages）

1. 打开 https://github.com/zztNo/mojuan → **Settings** → 左边 **Pages**
2. **Build and deployment** → Source 选 **Deploy from a branch**
3. Branch 选 **main** ，目录选 **/ (root)**，点 **Save**
4. 等 1~2 分钟，访问 `https://zztNo.github.io/mojuan/` 能正常打开书架即可
   - 注意是 `/mojuan/`（项目站点带仓库名前缀），所有资源都是相对路径，能正确加载

## 第 2 步：用 PWABuilder 出包

1. 打开 https://pwabuilder.com
2. 输入上面的地址 `https://zztNo.github.io/mojuan/` ，点 **Start**
3. 看到评分卡片后：
   - **Android** 卡片 → 点 **Download** 或 **Generate Package** → 下载 `.apk`（也能选 `.aab` 上架 Play 商店）
   - （可选）**Windows** 卡片 → 点 **Download** → 下载 `.msix` 安装包（Windows 10/11 双击安装，相当于官方商店版）
4. 手机装 `.apk` 时若提示「未知来源」，在系统设置里允许该安装器一次即可

## 说明

- PWABuilder 生成的 APK 是个 **TWA（可信 Web 活动）**：首次打开会从上面的网址加载墨卷，之后 Service Worker 会把整站缓存下来，离线也能进书架、读内置的离线书。
- 维基文库在线取书（83 部在线古籍）本身需要联网；内置的 25 卷离线书不依赖网络。
- 如果你改了代码，记得先 `git push` 并更新 GitHub Pages（Pages 会自动跟着 main 分支重新发布），再重新走一遍 PWABuilder。
