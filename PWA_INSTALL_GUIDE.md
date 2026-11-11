# 墨卷安装指南（桌面端 + 手机端，免 exe / 不被 Defender 拦截）

## 为什么不再主推 exe

v1.1.0 曾用 Electron 打出 `墨卷-1.1.0-portable.exe`，但它**没有代码签名证书**。Windows 的 SmartScreen / Microsoft Defender 会对所有「无数字签名 + 没有下载声誉」的 exe 拦截——哪怕程序完全干净，新发布第一次运行也几乎一定被拦；Electron 应用还容易被启发式当病毒误报。而一张能消除拦截的 EV 代码签名证书要几千元且需公司资质，对个人完全不划算。

因此改用 **PWA 安装**：用浏览器把墨卷装成独立的原生风格窗口应用，**不经过任何 exe，Defender 绝不拦**，离线也能用，手机端还能用同一套方案出 APK。

> 旧 `desktop/` 工程（含 Electron 打包脚本）仍保留在仓库里，仅作为「高级用户手动放行后使用」的可选项，不再主推。

---

## 一、Windows 桌面端（离线可用、0 拦截）

> ⚠️ **不能用 `file://` 直接装**：双击本地文件打开的地址是 `file:///...`，浏览器的「安装为应用 / PWA 安装」要求页面来自安全的 `http(s)` 或 `localhost` 源，`file://` 不在允许范围内，所以 Edge 不会显示安装按钮。必须让墨卷跑在一个 http 源下再装。

### 方法 1：在线版 PWA 安装（最推荐，装完可离线）

1. 先把在线版挂到公网：仓库 **Settings → Pages → main / (root) → Save**，等 1~2 分钟。
2. 用 **Microsoft Edge** 打开 `https://zztNo.github.io/mojuan/`。
3. 地址栏右侧出现「安装」图标（圆圈带 +）→ 点它 → 名称填「墨卷」→ 安装。
   - 没有图标的话，点 `···` → **应用** → **将此站点安装为应用** 也行。
4. 装完后 Service Worker 会把整站缓存，**之后断网也能进书架、读内置离线书**（首次安装 / 打开需联网拉取一次）。
   - 维基文库 83 部在线古籍取正文仍需联网。

### 方法 2：本地离线版 + 本地服务器（不想发公网时用）

1. 进入墨卷项目文件夹，运行：`python -m http.server 8080`
2. Edge 打开 `http://localhost:8080/mojuan-offline.html`（localhost 是安全源，可安装）
3. 同上点「安装」装成应用。
   - 注意：此方式安装的应用指向 `http://localhost:8080/...`，**需要那个 python 服务器一直开着**才能打开；关掉服务器应用就进不去。适合临时用，长期建议用方法 1。

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

#### 重新打包时这几项必须照着填（数值量自 v1.1.0 的 APK）

| 项 | 填什么 | 为什么不能改 |
|---|---|---|
| Site URL | `https://zztNo.github.io/mojuan/` | TWA 壳只负责加载这个地址，别的地址就是另一个站 |
| App ID / Package ID | `io.github.zztno.twa` | 改了会被 Android 当成**另一个 App**：老用户装完多出一个图标，桌面快捷方式、通知权限、已下载的数据全都不继承 |
| Version code | 旧包是 `1`，新包填 `2`（以后每次 +1） | 新包的 versionCode 必须 ≥ 已装版本，否则安装器直接报「应用未安装」，不提示原因 |
| Version name | `1.1.1`（旧包是 `1.0.0.0`） | 只影响系统设置里显示的版本号，随便写但要能看出来 |
| minSdk / targetSdk | `24` / `36`（PWABuilder 默认即可） | 决定最低支持 Android 7.0，不用改 |
| Signing key | 旧包是**未签名**，这次要么继续选 None，要么接受「老用户得先卸载」 | 换签名 = 签名不匹配，Android 不允许覆盖安装，必须先卸载旧版（卸载会清掉 App 内的数据，书库在浏览器 profile 里一般还在） |

> 只更新内容、不换壳的话，其实**不需要重新打包**：APK 加载的是在线地址，`git push` 之后自动就是新版。只有要改包名 / 版本号 / 图标 / 签名时才需要重走这一遍。

#### 想要「没有地址栏」的真全屏（可选，需要自己的签名）

TWA 打开时会做 Digital Asset Links 校验：站点根目录得有一个 `/.well-known/assetlinks.json`，里面写 APK 签名的 SHA-256 指纹。没有这个文件时，安卓会退化成带地址栏的 Custom Tab——能正常用，但不是全屏应用。

做的顺序是**先生成签名、再写文件**：

1. 在 PWABuilder 里选 **Use my own signing key**（或让它新生成一个），把 keystore 和密码存好，别丢——以后每次更新都得用同一个签名。
2. 拿到指纹（二选一）：
   - `keytool -list -v -keystore 你的.jks -alias 别名` → 复制 **SHA256** 那一行
   - 或对已签名的 apk 跑 `apksigner verify --print-certs 你的.apk`
3. 在仓库新建 `.well-known/assetlinks.json`：

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "io.github.zztno.twa",
    "sha256_cert_fingerprints": ["这里换成你的 SHA256 指纹，冒号保留大写"]
  }
}]
```

4. 仓库根目录必须有 `.nojekyll`（空文件，已随仓库提供）。GitHub Pages 默认走 Jekyll，而 Jekyll 会**忽略 `.well-known` 这类点开头的目录**，文件推上去也是 404；`.nojekyll` 让它原样发布。
5. 推上去后验证：浏览器直接打开 `https://zztNo.github.io/mojuan/.well-known/assetlinks.json`，能看到上面那段 JSON 才算成功（能看到就说明路径、编码都没问题）。再装新 APK，第一次打开若还是带地址栏，多半是签名指纹对不上。

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
