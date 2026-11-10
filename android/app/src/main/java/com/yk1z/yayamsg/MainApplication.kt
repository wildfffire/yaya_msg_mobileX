package com.yk1z.yayamsg

import android.app.Application
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.yayamsg.liquidglass.LiquidGlassPackage
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider

import okhttp3.Dns
import okhttp3.Interceptor

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ExpoReactHostFactory

import java.net.Inet6Address
import java.net.InetAddress

/** 与 src/api/bilibili.ts biliHeaders 一致的桌面 Chrome UA（B站风控按 UA 分端） */
private const val BILI_DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"

/**
 * DNS 结果「IPv6 优先」重排 —— 当前网络环境下 IPv4 出网链路被限速，IPv6 才通。
 *
 * ★ 为什么从「IPv4 优先」翻过来（2026-11-01 真机实测，同一台 DBY-W09 / Wi-Fi 402_5G）：
 *   · cdn.jsdelivr.net（成员库 1.06 MB）：
 *       `curl -6` 200 / **2.9s** 下完；`curl -4` 响应头 200 但 **15s 只收到 65 KB**（≈4 KB/s）。
 *   · pocketapi.48.cn：`curl -6` 403 / 0.17s，`curl -4` 403 / 0.16s —— **IPv6 出口现在是通的**。
 *   · data.gnz.hk：v6 15s 210 KB、v4 25s 450 KB，两条都慢（Cloudflare 大文件），但 v6 仍更快。
 *   直接后果：成员库同步在 App 内连续两次 15s 超时（Aborted）→ 退化到官方目录（无 channelId）
 *   → 房间映射错乱（部分房间 500「频道不存在」、小房间串台、袋王等不在官方目录的账号消失）。
 *
 * ⚠️ 2026-10-25 那次判断的是「IPv6 有地址但出口不通」（pocketapi 连 443 超时 19.8s），
 *    当时把 A 记录排前是对的；现在该前提已失效，IPv6 反而成为唯一可用的大文件通道。
 *
 * 为什么必须自己排序：RN 0.83 自带 OkHttp 4.9.2 没有 Happy Eyeballs（fastFallback 4.10 才有），
 * 且 RN 的 client connectTimeout=0（无限），只会按 DNS 顺序阻塞地连第一个地址 ——
 * 排在前面的那族如果不通/被限速，就是整站超时，不会自动回落。
 *
 * 只重排、不丢弃：纯 IPv6 或纯 IPv4 环境原样返回，能力不受损。
 */
private val ipv6FirstDns = object : Dns {
  override fun lookup(hostname: String): List<InetAddress> {
    val all = Dns.SYSTEM.lookup(hostname)
    if (all.size < 2) return all
    val v6 = all.filterIsInstance<Inet6Address>()
    if (v6.isEmpty()) return all
    return v6 + all.filterNot { it is Inet6Address }
  }
}

class MainApplication : Application(), ReactApplication {

  /** 手动注册的包（autolink 覆盖不到的）——reactNativeHost 与 reactHost 共用同一份 */
  private fun buildPackages(): List<ReactPackage> =
    PackageList(this).packages.apply {
      add(LiquidGlassPackage())
      // Packages that cannot be autolinked yet can be added manually here, for example:
      add(LivePlayerPackage())
      add(PipPackage())
      // PiliPlus 风格「动态取色」：读取 Android 12+ 系统壁纸强调色
      add(SystemAccentPackage())
      // 软件外通知（系统通知栏）：私信/房间新消息（用户 2026-11-09）
      add(YayaNotifyPackage())
      // 口袋48 云信消息通道（房间消息 = 云信圈组 QChat，仅原生 SDK 支持）
      add(PocketImPackage())
      // 云信 commonlink 协议（直播弹幕聊天室 + 成员房间 QChat）：登录包里包名由自己填
      // （com.seine48.app，白名单内）→ 过服务端客户端标识校验
      add(com.yk1z.yayamsg.nim.PocketNimChatroomPackage())
      // 自动链接漏掉 react-native-safe-area-context，这里补上（聊天库依赖其原生 Provider）
      add(com.th3rdwave.safeareacontext.SafeAreaContextPackage())
    }

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
          override fun getPackages(): List<ReactPackage> = buildPackages()

          override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

          override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
      }

  /**
   * Expo SDK 55 已移除 `ReactNativeHostWrapper`（RN 0.83 只支持新架构），改用 `ExpoReactHostFactory`。
   * 它内部会挂上 ExpoModulesPackage 的 host handlers（网络/生命周期链路），
   * Expo 各模块本身由 autolink 生成在 PackageList 里，这里整份传进去即可。
   */
  override val reactHost: ReactHost
    get() = ExpoReactHostFactory.getDefaultReactHost(applicationContext, buildPackages())

  override fun onCreate() {
    // 最先安装：RN 网络模块的 OkHttp 客户端在 JS 首次发请求时才经 createClient(context) 构建，
    // 若先有别的请求把默认 client 缓存进 OkHttpClientProvider 就来不及了。
    installNetworkClientFactory()
    super.onCreate()
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  /**
   * 统一定制 RN 网络模块的 OkHttpClient（JS 的 fetch 全走这里）。两件事：
   *
   * 1. DNS 结果 IPv6 优先（见 ipv6FirstDns）：当前网络下 IPv4 出网被限速（大文件 4 KB/s），
   *    IPv6 才是通的；排序决定成败，因为 OkHttp 4.9.2 没有 Happy Eyeballs 可回落。
   *
   * 2. B站登录拿不到 cookie 的根因修复：Android RN 的 JS fetch 无法可靠携带自定义 User-Agent 头
   *    （RN/OkHttp 路径会覆盖），B站 因此把扫码登录 poll 当移动端处理 → 不返回带 SESSDATA 的
   *    crossDomain url（桌面浏览器正常）。这里在 OkHttp 层对 *.bilibili.com 请求强制覆写桌面 UA。
   */
  private fun installNetworkClientFactory() {
    OkHttpClientProvider.setOkHttpClientFactory(
      OkHttpClientFactory {
        OkHttpClientProvider.createClientBuilder(applicationContext)
          .dns(ipv6FirstDns)
          .addInterceptor(
            Interceptor { chain ->
              val request = chain.request()
              val host = request.url.host
              val isBiliHost = host == "bilibili.com" || host.endsWith(".bilibili.com")
              if (isBiliHost && request.header("User-Agent") != BILI_DESKTOP_UA) {
                chain.proceed(request.newBuilder().header("User-Agent", BILI_DESKTOP_UA).build())
              } else {
                chain.proceed(request)
              }
            }
          )
          .build()
      }
    )
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
