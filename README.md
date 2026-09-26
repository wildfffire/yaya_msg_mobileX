<p align="center">
  <img src="assets/banner.svg" width="100%" alt="牙牙消息 X" />
</p>
<p align="center">
  <img src="assets/logo-rounded.png" width="96" alt="logo" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-ff6f91" alt="license" /></a>
  <a href="https://github.com/xuqinghhh/yaya_msg_mobile/releases"><img src="https://img.shields.io/badge/release-v2.7.5--x.1-ff6f91" alt="release" /></a>
  <img src="https://img.shields.io/badge/platform-Android-3DDC84?logo=android" alt="Android" />
</p>

# 牙牙消息 X

口袋48 第三方移动客户端（React Native）。

**牙牙消息 X** 是牙牙消息的独立衍生分支：上游为 [Xenia0922/yaya_msg_mobile](https://github.com/Xenia0922/yaya_msg_mobile)（源头 [yk1z/yaya_msg](https://github.com/yk1z/yaya_msg)），自 v2.7.5 起由 [@xuqinghhh](https://github.com/xuqinghhh) 独立维护，更新路线与上游分离。

> **⚠️ 重要：由于版本更新较大，建议每一位用户卸载后重新安装软件！**

## 牙牙消息 X 更新内容（相对上游 v2.7.5）

**横屏与播放器**
- 全局横屏支持：解除全应用竖屏锁，播放器横屏专用布局（顶栏 / 底栏 / 快捷栏重排）
- 弹幕改全屏飘屏覆盖层，可随时开关
- 直播公告：切换直播间不再串场；顶栏新增公告按钮，收起后可随时重看
- Android 12+ 画中画平滑进入（`setAutoEnterEnabled`）

**房间**
- 房间页大改版；新增成员回放面板与回放进度记忆
- 新增房间未读服务

**界面**
- 队伍标志改实底应援色徽章：应援色实底 + 自动黑/白字，预备生灰底白字
- B站直播 / 公演 / 登录 / 设置页适配更新

**性能**
- 直播/录播封面缩略图 700→400，滑动流量与解码开销显著下降
- 房间列表直播状态请求加 2.5 分钟节流
- 新增性能面板与性能调度服务

**构建与资源**
- 全套新图标 / 启动图 / logo，资源体积压缩约 60%
- Gradle 与构建脚本更新

## 功能

- 房间消息 / 私信 / 翻牌
- 口袋直播与回放
- 公演主播（B站直播）
- 官方音乐库
- 翻牌统计、成员数据库、鸡腿充值

## 安装
从 [Releases](https://github.com/xuqinghhh/yaya_msg_mobile/releases) 下载：

- `yaya-msg-x-universal.apk`：通用包（全 ABI，体积最大）
- `yaya-msg-x-x64.apk`：x86_64 模拟器专用
- `yaya-msg-x-v8a.apk` / `-v7a.apk`：真机包（**推荐真机使用**，比通用包小约 40%）

模拟器请用 x64 包，否则无法启动。App 内「检查更新」始终提供通用包直链，真机如需最小体积请在 Release 页面按架构下载。

## 构建

```sh
npm install --legacy-peer-deps
node scripts/build-apk.js
```

## 兼容

Android 8.0+（minSdk 26）。

## 已知问题

-

## 致谢

- [yk1z/yaya_msg](https://github.com/yk1z/yaya_msg)：本项目最初的源头，感谢原作者的开发与贡献；
- [Xenia0922/yaya_msg_mobile](https://github.com/Xenia0922/yaya_msg_mobile)：本项目的直接上游基础，感谢其二次开发工作。

本项目按 GPL-3.0 协议开源，在上述项目基础上继续开发。

## 免责声明

本应用为**非官方第三方客户端**，与丝芭传媒（SNH48 Group）及口袋48官方无任何关联，未获得其授权或认可，请以官方客户端为准。

- 应用展示的直播、视频、音乐、图片、文本等内容的版权归原权利人所有；
- 本应用仅为个人技术学习与交流目的开发，不代表任何官方立场，不保证内容持续可用；
- 请勿将本应用及其中内容用于商业用途或任何盈利活动；
- 使用本应用可能产生的任何风险（含账号安全风险）由使用者自行承担；
- 如内容涉及侵权或您认为不妥，请与仓库维护者联系处理。
