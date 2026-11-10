package com.yk1z.yayamsg

import android.graphics.Color
import android.os.Build
import android.util.TypedValue
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.Locale

/**
 * PiliPlus「动态取色」在本项目的等价桥：读取系统壁纸派生的强调色。
 *
 * - Android 12 (API 31)+：Material You 的 system_accent1_500，跟随壁纸变化；
 * - 更早版本：退回当前主题的 colorAccent（至少是厂商/系统强调色）；
 * - 都取不到：JS 侧会提示「设备可能不支持动态取色」并保持原主题色。
 *
 * 只返回 #RRGGBB 字符串，不做任何颜色算法 —— 算法统一在 src/theme/themeColors.ts。
 */
class SystemAccentModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

  override fun getName(): String = "SystemAccent"

  @ReactMethod
  fun getAccentColor(promise: Promise) {
    try {
      val colorInt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        context.getColor(android.R.color.system_accent1_500)
      } else {
        val typed = TypedValue()
        val resolved = context.theme.resolveAttribute(android.R.attr.colorAccent, typed, true)
        if (resolved) typed.data else Color.rgb(0xFF, 0x6F, 0x91)
      }
      promise.resolve(String.format(Locale.US, "#%06X", colorInt and 0xFFFFFF))
    } catch (e: Throwable) {
      promise.reject("E_SYSTEM_ACCENT", e.message ?: "unavailable", e)
    }
  }
}
