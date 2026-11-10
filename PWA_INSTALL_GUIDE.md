# 墨卷安装指南（桌面端 + 手机端，免 exe / 不被 Defender 拦截）

## 为什么不再主推 exe

v1.1.0 曾用 Electron 打出 `墨卷-1.1.0-portable.exe`，但它**没有代码签名证书**。Windows 的 SmartScreen / Microsoft Defender 会对所有「无数字签名 + 没有下载声誉」的 exe 拦截——哪怕程序完全干净，新发布第一次运行也几乎一定被拦；Electron 应用还容易被启发式当病毒误报。而一张能消除拦截的 EV 代码签名证书要几千元且需公司资质，对个人完全不划算。

因此改用 **PWA 安装**：用浏览器把墨卷装成独立的原生风格窗口应用，**不经过任何 exe，Defender 绝不拦**，离线也能用，手机端还能用同一套方案出 APK。

> 旧 `desktop/` 工程（含 Electron 打包脚本）仍保留在仓库里，仅作为「高级用户手动放行后使用」的可选项，不再主推。

---

## 一、Windows 桌面端（推荐：纯本地、离线可用、0 拦截）

### 方法 A：离线版直接装（最简单，无需联网、无需服务器）

1. 用 **Microsoft Edge** 打开你下载的 `mojuan-offline.html`（双击文件，或把文件拖进 Edge 窗口）。
2. 右上角 `···` → **应用** → **将此站点安装为应用**。
   - 如果地址栏右侧出现一个「安装」图标（圆圈带 + 号），点它也一样。
3. 名称填「墨卷」，点 **安装**。
4. 完成后桌面和开始菜单都会出现「墨卷」图标，双击即开一个独立窗口。
   - 内置的 25 卷离线书离线可读；维基文库 83 部在线古籍需要联网取正文。

> 说明：Chrome 也支持「安装应用」，但对本地 `file://` 页面不一定弹出安装按钮，**桌面端安装建议用 Edge**。离线单文件版本身不是标准 PWA（为保持单文件自包含，没有 manifest 链接），但 Edge 的「安装此站点」对任意页面都生效，所以照样能装成应用。

### 方法 B：在线版标准 PWA 安装（带 Service Worker 缓存，体验最完整）

在线版（`index.html`）是标准 PWA，装完会有 Service Worker 缓存，离线也能进书架；而且只有在线版能正常被 PWABuilder 打包出手机 APK。

两种方式都能进安装流程：

- **本地起服务（无需联网发公网）**：在项目文件夹里运行 `python -m http.server 8080`，浏览器访问 `http://localhost:8080/`，地址栏出现「安装」图标 → 点它 → 安装。
- **公网（推荐，顺便满足手机 APK 前提）**：先把在线版挂到 GitHub Pages（见下方「手机端 APK 第 1 步」），然后访问 `https://zztNo.github.io/mojuan/`，点地址栏「安装」图标即可。

---

## 二、Android 手机端（APK）

墨卷是标准 PWA，出手机安装包走官方 **PWABuilder** 最省事，不需要装 Android Studio。

### 第 1 步：把在线版挂到公网（GitHub Pages）

1. 打开 https://github.com/zztNo/mojuan → **Settings** → 左侧 **Pages**。
2. **Build and deployment** → Source 选 **Deploy from a branch**。
3. Branch 选 **main**，目录选 **/ (root)**，点 **Save**。
4. 等 1~2 分钟，访问 `https://zztNo.github.io/mojuan/` 能正常打开书架即可。
   - 注意是 `/mojuan/`（项目站点带仓库名前缀），仓库内资源都是相对路径，能正确加载。

### 第 2 步：用 PWABuilder 出包

1. 打开 https://pwabuilder.com
2. 输入上面的地址 `https://zztNo.github.io/mojuan/`，点 **Start**。
3. 看到评分卡片后：
   - **Android** 卡片 → 点 **Download** 或 **Generate Package** → 下载 `.apk`（也能选 `.aab` 上架 Play 商店）。
   - （可选）**Windows** 卡片 → 点 **Download** → 下载 `.msix` 安装包（Win10/11 双击安装，相当于官方商店版，也不触发 Defender）。
4. 手机装 `.apk` 时若提示「未知来源」，在系统设置里允许该安装器一次即可。

### 说明

- PWABuilder 生成的 APK 是个 **TWA（可信 Web 活动）**：首次打开会从上面的网址加载墨卷，之后 Service Worker 把整站缓存下来，离线也能进书架、读内置离线书。
- 维基文库在线取书（83 部在线古籍）本身需要联网；内置的 25 卷离线书不依赖网络。
- 如果你改了代码，记得先 `git push`（Pages 会自动跟着 main 分支重新发布），再重新走一遍 PWABuilder。

---

## 三、exe（可选，已不主推）

`desktop/dist/墨卷-1.1.0-portable.exe` 仍保留，仅给愿意手动放行的用户：

- 若是 SmartScreen 弹窗（「Windows 已保护你的电脑 / 未知发布者」）：点 **更多信息 → 仍要运行** 即可，功能一切正常。
- 若是 Defender 实时防护直接报病毒拦掉：打开 **Windows 安全中心 → 病毒和威胁防护 → 允许/排除项**，把该 exe 加进排除列表。

普通用户不建议使用，直接用上方的 PWA 安装更省心。

---

## 常见问题

- **Edge 里没有「安装」按钮？** 确认用的是 Microsoft Edge，并且打开的是 `file://` 或 `http(s)://` 页面；离线版请走「`···` → 应用 → 将此站点安装为应用」菜单项，而不是等地址栏图标。
- **装好的应用图标在哪？** 桌面和开始菜单各一份；任务栏可右键「固定到任务栏」。
- **换电脑怎么办？** 把 `mojuan-offline.html` 拷过去，按方法 A 重新装一次即可，书签/进度存在浏览器本地。
- **在线书读不了？** 在线古籍来自维基文库，需要联网；若公司/校园网限制外网会失败，离线书不受影响。
