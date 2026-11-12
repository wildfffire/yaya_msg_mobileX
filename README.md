<p align="center">
  <img src="assets/banner.svg" width="100%" alt="牙牙消息 X" />
</p>
<p align="center">
  <img src="assets/icon.png" width="96" alt="logo" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-ff6f91" alt="license" /></a>
  <a href="https://github.com/wildfffire/yaya_msg_mobileX/releases"><img src="https://img.shields.io/badge/release-v3.0.0-ff6f91" alt="release" /></a>
  <img src="https://img.shields.io/badge/platform-Android-3DDC84?logo=android" alt="Android" />
  <img src="https://img.shields.io/badge/React%20Native-0.83-61dafb?logo=react" alt="React Native" />
</p>

# 牙牙消息 X

口袋48 / SNH48 Group 的**第三方 Android 客户端**，用 React Native 编写：进入成员房间看消息、看直播与回放、听歌看视频、翻牌私信。**横屏平板 / 大屏优先**，持续优化房间与直播体验。

- 上游基础：[Xenia0922/yaya_msg_mobile](https://github.com/Xenia0922/yaya_msg_mobile)，再往上溯源去 [yk1z/yaya_msg](https://github.com/yk1z/yaya_msg)
- 自 v2.7.5 起由 [@wildfffire](https://github.com/wildfffire) 独立维护，更新路线与上游分离
- 仅支持 Android（原生工程已入库，不做 iOS 适配）

## 项目定位

- **不定期与上游同步功能**：上游（[yk1z/yaya_msg](https://github.com/yk1z/yaya_msg) 等）新增的能力会**按需择期回移**，不做逐版本跟随，也不承诺与上游功能完全对齐
- **主要面向横屏的平板 / 大屏场景**：布局、控制坞、弹幕与多列信息都按横屏优先设计，手机竖屏可用但不是主要目标
- **主要优化房间与直播体验**：房间消息、未读、房间内直播与回放、播放器与弹幕是持续投入的方向
- **翻牌、礼物等功能：具体情况未知**：这部分**尽可能复用了上游已有的优化实现，但未做测试** —— 是否可用、行为是否与上游一致都无法保证，遇到问题欢迎反馈

## 接下来的开发目标

- **更多个性化选择**：把「能调的都做成可选项」——头像来源（房间内 / 房间外）、播放器行为、界面信息密度、列表与弹幕展示等会继续拆成独立开关，优先满足「按自己的习惯用」
- 主线不变：仍以横屏平板场景下的**房间与直播体验**为优化重点（见上方「项目定位」）

## 相对上游的主要变化

- **播放器统一**：主直播页、房间内、观看历史、稍后再看共用一套会话层（解析 / 续播 / 在线人数 / 弹幕 / 公告 / 小窗），一套 UI 覆盖直播、回放、录播视频、公演直播、电台与直链播放
- **账号中心**：一套「Hero 账号横幅 + 分区列表」的账号页（宽屏左身份右内容），点头像 / 昵称直接弹窗改资料，大小号切换、余额充值、签到与 B站绑定都在同一页
- **房间**：关注成员房间（大房间 / 小房间分侧未读角标）、引用回复与翻牌渲染、房间公告、礼物特效与公屏、房间内直播与回放、点封面直接进房间内直播
- **公演**：公演排期卡条（未来 10 天），已开演场次 **B站优先**，B站未开播才走应用内信号
- **成员**：自建成员库镜像（每日同步 + 人工修正）、成员档案就地内嵌、成员动态、鸡腿榜
- **观看历史 / 稍后再看**：同一直播只留一条记录，退出播放回到来源列表页
- **面板语言统一**：贡献榜 / 礼物 / 弹幕列表 / 弹幕设置共用一套黑白深色抽屉（同一抬头、同一圆角与遮罩），横屏统一贴右
- **体验**：全局横竖屏、深色 / 浅色 / 跟随系统一键切换、多套主题配色（主题色 / 强调色）、中 / 繁 / 英 / 日 / 韩五语言、画中画与小窗、进入播放器自动隐藏系统栏
- **工程**：出包脚本化（默认仅 arm64-v8a）、版本号三处一致性校验、纯 Node 回归测试

## 最近更新（Build 3000046）

- **账号中心重做**：旧登录页换成「Hero 账号横幅 + 分区列表」。平板 / 横屏是左右双栏（左身份 + 导航，右分区），手机单列；点头像或昵称弹「编辑资料」改头像与昵称，列表里不再散着头像 / 昵称 / 改名次数三行。
- **分区收敛为 4 个**：账号切换（含主号 / 小号网格与注销）、鸡腿充值、自动签到、B站账号。停用「登录状态 / 账号 ID / Token」三行冗余展示，账号列表也不再每行重复同一个 Token。
- **播放器功能面板**：去掉「进入房间」与「小窗」入口；横屏改为右侧竖排抽屉。公告只从该面板移除，顶栏喇叭与公告面板照旧。
- **礼物 / 贡献榜**：面板改成与弹幕列表同一套黑白深色抽屉，横屏贴右；修复列表被屏幕裁掉、底部留大片空白的问题（列表现在有确定高度并可滚动）。
- **播放速度**：从整屏弹层改成右下角下拉菜单；**暂停钮样式**默认 Glass，切换后记住选择。
- **沉浸播放**：进入播放器即隐藏设备状态栏与导航栏，关闭时恢复。
- **弹幕**：飘屏条目可直接点开发送者资料卡（直播与房间都支持，回放 LRC 无身份不触发）；贡献榜行、弹幕列表发送者同样可点。弹幕设置面板去掉顶部小条、开关与胶囊改细长、关闭按钮靠右。
- **「我的」页**：运行日志与成员数据迁入设置 → 关于（成员数据固定置底），现场互动移到首页工具第一位，右上角新增「跟随系统 / 浅色 / 深色」一键切换。
- **充值页**：去掉页头余额卡只留官方网页，右上角保留一个刷新按钮。

## 功能

| 模块 | 内容 |
|:--|:--|
| 房间 | 关注成员房间、实时消息、未读角标、引用回复与翻牌、房间公告、礼物特效、房间内直播 / 回放、房间电台 |
| 直播 | 口袋直播与回放、B站直播间、公演排期直播、弹幕（飘屏 / 抽屉 / 发送 / 设置，飘屏可点进资料卡）、在线人数、续播定位、倍速下拉、小窗与画中画 |
| 媒体 | 官方音乐库、视频库、电台节目、观看历史、稍后再看、下载管理 |
| 成员 | 成员库、成员档案、成员动态、鸡腿榜、公演记录 |
| 账号 | 账号中心（Hero + 分区）、验证码登录、Token 登录与校验、大小号切换、资料弹窗编辑、私信、翻牌统计、充值、开发票 |
| 其他 | 深色 / 浅色 / 跟随系统、主题配色、横竖屏、五语言、图片查看器、运行时日志、清除缓存 |

## 安装

从 [Releases](https://github.com/wildfffire/yaya_msg_mobileX/releases) 下载 APK。

文件名为 `yaya-msg-mobile-v<版本>-b<小版本>-<abi>.apk`，例如 `yaya-msg-mobile-v3.0.0-b3000046-v8a.apk`：

- **v8a**（arm64-v8a）：真机使用，默认只提供这一个
- **x86_64**：模拟器专用，需要时自行构建

文件名只用于区分，不影响安装 —— Android 只校验 APK 内的 versionCode 与签名。

## 兼容

- Android 8.0+（minSdk 26）
- HarmonyOS 2 / 3 / 4 可安装（Android 基座为 8–10）
- 模拟器需安装 x86_64 包，否则无法启动

## 构建

### 环境

- Node.js 20+（CI 使用 22）
- JDK 17+
- Android SDK / NDK（版本见 `android/build.gradle`）

### 命令

```sh
npm install --legacy-peer-deps

npm run typecheck     # tsc + 版本号一致性校验
npm run test:core     # 纯 Node 回归测试（不依赖 jest）

node scripts/build-apk.js
```

默认只构建 **arm64-v8a**，产物复制到 `~/yaya-apk/yaya-msg-mobile-v<版本>-b<小版本>-v8a.apk`。

按需调整：

```sh
node scripts/build-apk.js                        # arm64-v8a（默认）
YAYA_ABIS=x86_64 node scripts/build-apk.js       # 模拟器
YAYA_ABIS=arm64-v8a,x86_64 node scripts/build-apk.js
YAYA_UNIVERSAL=true node scripts/build-apk.js    # universal
YAYA_APK_OUT_DIR=D:/out node scripts/build-apk.js # 自定义输出目录
```

### 签名

正式出包需要在 `~/.gradle/gradle.properties` 或环境变量中提供：

```
RELEASE_STORE_FILE
RELEASE_STORE_PASSWORD
RELEASE_KEY_ALIAS
RELEASE_KEY_PASSWORD
```

未提供时 release 包会回落到 debug 签名（脚本会打印警告）。仓库内**不含任何密钥**，`android/local.properties` 也不入库。

### 开发调试

```sh
npm start          # Metro
npm run android    # expo run:android
```

## 版本号约定

三处必须同步，否则 `npm run verify:version`（已并入 `npm run typecheck`）会失败：

| 位置 | 字段 |
|:--|:--|
| `app.json` | `expo.version` / `expo.android.versionCode` |
| `android/app/build.gradle` | `versionName` / `versionCode` |
| `src/constants/index.ts` | `APP_VERSION` / `APP_BUILD` |

`APP_BUILD` 即 Android versionCode（设置页显示为 `Build {n}`）。

## 项目结构

```
android/     原生工程，含自定义 Kotlin 模块（云信 IM / 聊天室 / 圈组、播放器控制）
assets/      图标、启动图、成员库离线快照
docs/        接口映射、设计系统、重构方案等内部文档
member-db/   成员库同步脚本与产物（App 通过 jsDelivr 拉取 dist/members.json）
modules/     本地原生模块（liquid-glass-native）
scripts/     出包、版本校验、回归测试
src/
  api/         口袋48 / B站 / 官方媒体接口
  auth/        pa 签名（WASM）
  components/  通用组件
  hooks/       通用 hooks
  i18n/        多语言
  native/      原生桥接
  navigation/  导航与 Tab
  player/      统一播放器（core / chrome / resolve / session / store）
  screens/     页面（含 room/ 房间、watch/ 历史与稍后再看）
  services/    业务服务（成员库、未读、历史、设置、云信等）
  store/       全局状态（zustand）
  theme/       主题与设计 token
  utils/       纯函数与规则
```

## 技术栈

React Native 0.83.10 · Expo 55 · TypeScript 5.9 · zustand · react-native-video · react-native-reanimated 4 · @kesha-antonov/react-native-chat · react-native-webview · 自研 Kotlin 原生模块

## 已知限制

- B站直播间**没有实时在线人数**：`room/v1/Room/get_info` 的 `online` 恒为 0，`getInfoByRoom` 被风控拒绝，页面只能显示关注数
- 房间未读为**本地累计**方案，App 未运行期间的消息不计入
- 只维护 Android，不提供 v7a / universal 预编译包

## 反馈

- 问题与建议：[Issues](https://github.com/wildfffire/yaya_msg_mobileX/issues)
- 提交代码前请确保 `npm run typecheck` 与 `npm run test:core` 全绿

## 致谢

- [yk1z/yaya_msg](https://github.com/yk1z/yaya_msg)：项目最初的源头
- [Xenia0922/yaya_msg_mobile](https://github.com/Xenia0922/yaya_msg_mobile)：本项目的直接上游基础
- 以及所有开源依赖的作者

## 免责声明

本应用为**非官方第三方客户端**，与丝芭传媒（SNH48 Group）及口袋48 官方无任何关联，未获得其授权或认可，请以官方客户端为准。

- 应用展示的直播、视频、音乐、图片、文本等内容版权归原权利人所有
- 本项目仅用于个人技术学习与交流，不代表任何官方立场，不保证内容持续可用
- 请勿将本应用及其内容用于商业用途或任何盈利活动
- 使用本应用可能产生的风险（含账号安全风险）由使用者自行承担
- 如内容涉及侵权或您认为不妥，请联系仓库维护者处理

## 许可

[GPL-3.0](LICENSE)
