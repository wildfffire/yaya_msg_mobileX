package com.yk1z.yayamsg

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * 消息保活前台服务（2026-11-10 真机实证）。
 *
 * ★ 真正的根因：RN 的 `JavaTimerManager.onHostPause()` 会置 isPaused=true 并移除
 *   Choreographer 回调 —— App 一切后台，**所有 JS setInterval 全部停摆**。真机实测：
 *   前台每 5s 一条 `[room] 本轮`，切后台 35s 零 JS 日志；进程没被杀、也不是 Doze，
 *   单靠「前台服务让进程活着」根本救不回 JS 定时器。
 *   所以这个服务既把进程提到前台优先级，又用**原生 Handler 每 5s 发一个事件**
 *   （YayaNotifyModule.emitPollTick）把 JS 轮询拉起来；JS 侧只在非前台时响应，避免双倍请求。
 *
 * 服务本身不联网：只发心跳 + 持一条 IMPORTANCE_MIN 的静默常驻通知 + 可续期 PARTIAL_WAKE_LOCK。
 *
 * ★「关通知 = 关后台」：JS 关闭软件外通知时会把允许标记写成 false 并 stopService，
 *   这里 onCreate / onStartCommand 各自再自检一次；onDestroy 移除心跳并释放 WakeLock ——
 *   系统按 START_STICKY 重建服务时也绝不会在用户已关通知的情况下偷偷复活耗电。
 */
class MessageKeepAliveService : Service() {

  private val handler = Handler(Looper.getMainLooper())
  private var wakeLock: PowerManager.WakeLock? = null

  private fun keepAliveAllowed(): Boolean =
    getSharedPreferences(YayaNotifyModule.PREFS_NAME, Context.MODE_PRIVATE)
      .getBoolean(YayaNotifyModule.KEY_KEEP_ALIVE, false)

  /** 每次心跳续 10 分钟：即便服务异常退出，系统也会自动释放，绝不永久占着 CPU */
  private fun acquireWakeLock() {
    try {
      val wl = wakeLock ?: (getSystemService(Context.POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "yayamsg:MessagePoll")
        .apply { setReferenceCounted(false) }
        .also { wakeLock = it }
      wl.acquire(WAKE_LOCK_TIMEOUT_MS)
    } catch (_: Throwable) {
    }
  }

  private val tick = object : Runnable {
    override fun run() {
      if (!keepAliveAllowed()) {
        stopSelf()
        return
      }
      acquireWakeLock()
      YayaNotifyModule.emitPollTick()
      handler.postDelayed(this, POLL_TICK_MS)
    }
  }

  override fun onCreate() {
    super.onCreate()
    if (!keepAliveAllowed()) {
      stopSelf()
      return
    }
    ensureChannel()
    try {
      val notification = buildNotification()
      if (Build.VERSION.SDK_INT >= 34) {
        // Android 14+（targetSdk 36）必须显式给 FGS type，且与 manifest 的 specialUse 一致
        startForeground(KEEPALIVE_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
      } else {
        startForeground(KEEPALIVE_NOTIFICATION_ID, notification)
      }
      acquireWakeLock()
      handler.removeCallbacks(tick)
      handler.postDelayed(tick, POLL_TICK_MS)
    } catch (e: Throwable) {
      // 个别 ROM 会拒绝 startForeground：保活失败不能把整个进程带崩
      android.util.Log.w("YayaKeepAlive", "startForeground failed: " + (e.message ?: ""))
      stopSelf()
    }
  }

  override fun onDestroy() {
    handler.removeCallbacks(tick)
    try {
      if (wakeLock?.isHeld == true) wakeLock?.release()
    } catch (_: Throwable) {
    }
    wakeLock = null
    super.onDestroy()
  }

  /** 系统回收后尽量重建，但用户关了通知就不再粘住（不耗电） */
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!keepAliveAllowed()) {
      stopSelf()
      return START_NOT_STICKY
    }
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CHANNEL_ID) != null) return
    // IMPORTANCE_MIN：静默、不响铃、不震动、不弹横幅，只作为前台服务的凭证
    val channel = NotificationChannel(CHANNEL_ID, "后台消息接收", NotificationManager.IMPORTANCE_MIN).apply {
      description = "保持后台接收私信与房间新消息"
      setSound(null, null)
      enableVibration(false)
      setShowBadge(false)
    }
    nm.createNotificationChannel(channel)
  }

  private fun buildNotification(): Notification {
    val intent = Intent(this, MainActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    } else {
      PendingIntent.FLAG_UPDATE_CURRENT
    }
    val pending = PendingIntent.getActivity(this, 0, intent, flags)
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      // 用户 2026-11-10：不要「消息接收中」这种常驻提示。Android 要求前台服务必须有通知，
      // 已改成只在后台出现 + 最低优先级静默；文案也降到最中性。
      .setContentTitle("牙牙消息")
      .setContentText("保持后台接收新消息")
      .setContentIntent(pending)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setShowWhen(false)
      .build()
  }

  companion object {
    const val CHANNEL_ID = "yaya_keepalive"
    /** 避开消息通知 id（notifyStableId 最大约 2_000_001_000） */
    private const val KEEPALIVE_NOTIFICATION_ID = 2147483640
    /** 与 JS 侧 5s 轮询同频；RN 后台会暂停 JS setInterval，这里由原生 Handler 顶上 */
    private const val POLL_TICK_MS = 5_000L
    private const val WAKE_LOCK_TIMEOUT_MS = 10 * 60 * 1000L
  }
}
