package com.yk1z.yayamsg

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.text.Spannable
import android.text.SpannableString
import android.text.style.StyleSpan
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import android.widget.RemoteViews
import java.net.HttpURLConnection
import java.net.URL

/**
 * 「软件外通知」= 系统通知栏。用户 2026-11-09 要求补上消息通知。
 *
 * 为什么自己写而不引第三方库：
 *  - 只需要「发一条带标题/正文/点击深链的通知 + 撤销」，notifee 这类库会拖进一堆原生依赖；
 *  - 点击行为直接复用系统深链（`yayamsg://room/123`），与 App 的 Linking 监听天然打通。
 *
 * JS 侧入口：src/services/localNotify.ts（NativeModules.YayaNotify，缺模块时静默降级）。
 */
class YayaNotifyModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

  init { appContext = context }

  override fun getName(): String = "YayaNotify"

  private val manager: NotificationManagerCompat
    get() = NotificationManagerCompat.from(context)

  /** 通知渠道（Android 8+ 必须；重要性 DEFAULT = 有声音但不弹全屏） */
  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val existing = nm.getNotificationChannel(CHANNEL_ID)
    if (existing != null) {
      // ★ 用户在系统设置里把渠道关成「无」时，areNotificationsEnabled() 仍返回 true，
      //   notify() 会静默丢弃却 resolve(true) → JS 以为发出去了、游标推进、永不重试。
      //   删掉重建是唯一能恢复的办法（用户之后仍可再次手动关闭）。
      if (existing.importance == NotificationManager.IMPORTANCE_NONE) nm.deleteNotificationChannel(CHANNEL_ID)
      else return
    }
    val channel = NotificationChannel(CHANNEL_ID, "消息通知", NotificationManager.IMPORTANCE_DEFAULT).apply {
      description = "私信与关注房间的新消息"
      enableLights(true)
      enableVibration(true)
    }
    nm.createNotificationChannel(channel)
  }

  @ReactMethod
  fun show(id: Double, title: String, body: String, uri: String, avatarUrl: String, promise: Promise) {
    try {
      if (!manager.areNotificationsEnabled()) {
        promise.resolve(false)
        return
      }
      ensureChannel()
      val notifyId = id.toInt()
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri.ifBlank { "yayamsg://home" })).apply {
        setClass(context, MainActivity::class.java)
        addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      }
      val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      } else {
        PendingIntent.FLAG_UPDATE_CURRENT
      }
      val pending = PendingIntent.getActivity(context, notifyId, intent, flags)
      val ctx = context
      // 头像下载/解码必须离开主线程；下载失败只是没有大图，不影响通知本身
      Thread {
        val largeIcon = loadAvatar(avatarUrl)
        try {
          // 用户 2026-11-10：偶像名字加粗（系统通知只能通过 Spannable 实现）
          val boldTitle = SpannableString(title.ifBlank { "牙牙消息" }).apply {
            setSpan(StyleSpan(Typeface.BOLD), 0, length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
          }
          val builder = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(boldTitle)
            .setContentText(body)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(pending)
          if (largeIcon != null) {
            builder.setLargeIcon(largeIcon)
            /**
             * 用户 2026-11-10：通知里的偶像头像要大一点。
             * 折叠态的 largeIcon 尺寸由系统固定（约 48~64dp，改不了），
             * 所以展开态改用自定义布局：72dp 头像 + 加粗名字（浅/深色两套 XML）。
             */
            val nightMode = ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
            val isDark = nightMode == Configuration.UI_MODE_NIGHT_YES
            val remote = RemoteViews(
              ctx.packageName,
              if (isDark) R.layout.notification_message_dark else R.layout.notification_message_light,
            )
            // RemoteViews 有跨进程体积上限：先缩到 256px 再传
            remote.setImageViewBitmap(R.id.notify_avatar, fitBitmap(largeIcon, 256))
            remote.setTextViewText(R.id.notify_title, title.ifBlank { "牙牙消息" })
            remote.setTextViewText(R.id.notify_body, body)
            remote.setOnClickPendingIntent(R.id.notify_root, pending)
            builder.setStyle(NotificationCompat.DecoratedCustomViewStyle())
            builder.setCustomBigContentView(remote)
          } else {
            builder.setStyle(NotificationCompat.BigTextStyle().bigText(body))
          }
          NotificationManagerCompat.from(ctx).notify(notifyId, builder.build())
          promise.resolve(true)
        } catch (_: Throwable) {
          promise.resolve(false)
        }
      }.start()
    } catch (e: Throwable) {
      promise.reject("E_NOTIFY", e.message ?: "notify failed", e)
    }
  }

  /** 通知大图：房间列表里的偶像头像（公式照/自选由 JS 选好再传）。4s 超时，失败返回 null */
  private fun loadAvatar(url: String): Bitmap? {
    if (url.isBlank()) return null
    return try {
      val conn = URL(url).openConnection()
      conn.connectTimeout = 4000
      conn.readTimeout = 4000
      if (conn is HttpURLConnection) conn.instanceFollowRedirects = true
      conn.getInputStream().use { BitmapFactory.decodeStream(it) }
    } catch (_: Throwable) {
      null
    }
  }

  /** RemoteViews 有跨进程体积上限（约 1MB）：传之前等比缩到 maxPx 以内 */
  private fun fitBitmap(src: Bitmap, maxPx: Int): Bitmap {
    val w = src.width
    val h = src.height
    if (w <= 0 || h <= 0) return src
    if (w <= maxPx && h <= maxPx) return src
    val scale = maxPx.toFloat() / maxOf(w, h)
    return try {
      Bitmap.createScaledBitmap(
        src,
        (w * scale).toInt().coerceAtLeast(1),
        (h * scale).toInt().coerceAtLeast(1),
        true,
      )
    } catch (_: Throwable) {
      src
    }
  }

  @ReactMethod
  fun cancel(id: Double) {
    try {
      manager.cancel(id.toInt())
    } catch (_: Throwable) {
    }
  }

  @ReactMethod
  fun cancelAll() {
    try {
      manager.cancelAll()
    } catch (_: Throwable) {
    }
  }

  /** 通知权限是否已授予（系统总开关 + 渠道是否被降级为「无」） */
  @ReactMethod
  fun areEnabled(promise: Promise) {
    try {
      if (!manager.areNotificationsEnabled()) {
        promise.resolve(false)
        return
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val ch = nm.getNotificationChannel(CHANNEL_ID)
        if (ch != null && ch.importance == NotificationManager.IMPORTANCE_NONE) {
          promise.resolve(false)
          return
        }
      }
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.resolve(false)
    }
  }

  /**
   * 启动消息保活前台服务。
   * ★ 必须在 App 前台调用：Android 12+ 禁止后台 startForegroundService。
   *   服务只负责把进程提到前台优先级，JS 的 5s 轮询才会继续跑（真机实证后台会被整个冻结）。
   */
  @ReactMethod
  fun startKeepAlive(promise: Promise) {
    try {
      // 允许标记与 startForegroundService 同一次调用里写入，服务重建时自检得到的就是最新值
      context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit().putBoolean(KEY_KEEP_ALIVE, true).apply()
      val intent = Intent(context, MessageKeepAliveService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun stopKeepAlive() {
    // ★ 先落盘再停服务：用户关掉通知后，即便进程马上被杀、系统按 START_STICKY 重建服务，
    //   MessageKeepAliveService 也会读到 false 立刻自停，不会后台偷跑耗电。
    try {
      context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit().putBoolean(KEY_KEEP_ALIVE, false).apply()
    } catch (_: Throwable) {
    }
    try {
      context.stopService(Intent(context, MessageKeepAliveService::class.java))
    } catch (_: Throwable) {
    }
  }

  /**
   * 「允许后台运行」：优先直接申请忽略电池优化白名单。
   * 真机（华为/HarmonyOS）实测：即使有前台服务 + WakeLock，未加入白名单时后台网络请求
   * 仍会被系统挂起（Frameworks netpolicy 显示 rules=NONE，是 ROM 自己的后台管控）。
   * 这一步必须由用户点系统弹窗授权，代码无法代替。已在白名单则跳应用详情去开后台数据/自启动。
   */
  @ReactMethod
  fun openAppSettings() {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!pm.isIgnoringBatteryOptimizations(context.packageName)) {
          context.startActivity(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
              .setData(Uri.parse("package:" + context.packageName))
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          )
          return
        }
      }
    } catch (_: Throwable) {
    }
    try {
      context.startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
          .setData(Uri.parse("package:" + context.packageName))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
    } catch (_: Throwable) {
    }
  }

  /** 跳到本 App 的系统通知设置页（用户拒绝后不会反复弹权限框） */
  @ReactMethod
  fun openSettings() {
    try {
      val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
        putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
    } catch (_: Throwable) {
      try {
        context.startActivity(
          Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.parse("package:" + context.packageName))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
      } catch (_: Throwable) {
      }
    }
  }

  companion object {
    private const val CHANNEL_ID = "yaya_messages"
    /** 「关通知 = 关后台」的持久化标记：服务重建时自检，避免用户关了通知仍被系统拉起 */
    const val PREFS_NAME = "yaya_notify_prefs"
    const val KEY_KEEP_ALIVE = "keep_alive_allowed"
    const val EVENT_POLL_TICK = "yayaMessagePollTick"

    @Volatile
    private var appContext: ReactApplicationContext? = null

    /**
     * 原生心跳（MessageKeepAliveService 每 5s 调一次）。
     * ★ RN 的 JavaTimerManager.onHostPause() 会把 isPaused=true 并移除 Choreographer 回调，
     *   App 一退后台**所有 JS setInterval 全部停摆**（真机实测：前台 5s 一条日志、后台 35s 零日志）。
     *   只有进程活着没用，必须由原生定时器发事件把 JS 轮询拉起来。
     */
    fun emitPollTick() {
      val ctx = appContext ?: return
      try {
        // bridgeless 模式下 emitDeviceEvent 直接走 callFunctionOnModule('RCTDeviceEventEmitter','emit')
        if (ctx.hasActiveReactInstance()) ctx.emitDeviceEvent(EVENT_POLL_TICK, null)
      } catch (_: Throwable) {
      }
    }
  }
}
