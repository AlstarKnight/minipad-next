// 分享到 Minipad(0.5.5)。Android CI 用这个文件换掉 `tauri android init` 生成的 MainActivity
// (生成的只有 enableEdgeToEdge 那几行,这里照样留着)。
// 别的 App 里点「分享」选 Minipad 时(清单里的 .ShareTarget,见 share-target.xml),这里先记下分享的文字;
// 网页那边用 MinipadShare.take() 拿走,写进设好的页面,写完调 done() 提示一下,要回原来的 App 就退到后台。
// 应用没开着时网页加载好了自己来拿;开着时这里叫它来拿
package io.github.alstarknight.minipadnext

import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  // 还没写进页面的那次分享(JSON:text、title)
  private var pending: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 系统回收后重建的,带的还是上次那次分享,不再记一遍
    if (savedInstanceState == null) keep(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    if (keep(intent)) webView?.evaluateJavascript("window.__minipadShared && window.__minipadShared()", null)
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Bridge(), "MinipadShare")
  }

  private fun keep(intent: Intent?): Boolean {
    if (intent == null || intent.action != Intent.ACTION_SEND || intent.type?.startsWith("text/") != true) return false
    // 从最近任务里再打开时,系统又送来当初那次分享
    if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return false
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: ""
    val title = (intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT) ?: intent.getCharSequenceExtra(Intent.EXTRA_TITLE))?.toString() ?: ""
    synchronized(this) { pending = JSONObject().put("text", text).put("title", title).toString() }
    return true
  }

  inner class Bridge {
    // 拿走还没写的那次分享,没有时是 null
    @JavascriptInterface
    fun take(): String? = synchronized(this@MainActivity) { pending.also { pending = null } }

    @JavascriptInterface
    fun done(message: String, back: Boolean) {
      runOnUiThread {
        Toast.makeText(this@MainActivity, message, Toast.LENGTH_SHORT).show()
        if (back) moveTaskToBack(true)
      }
    }

    // 「分享」的总开关:关掉时停用 .ShareTarget,分享列表里就没有 Minipad 了
    @JavascriptInterface
    fun setEnabled(on: Boolean) {
      val target = ComponentName(this@MainActivity, "${MainActivity::class.java.name.substringBeforeLast('.')}.ShareTarget")
      val state = if (on) PackageManager.COMPONENT_ENABLED_STATE_DEFAULT else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
      if (packageManager.getComponentEnabledSetting(target) != state) {
        packageManager.setComponentEnabledSetting(target, state, PackageManager.DONT_KILL_APP)
      }
    }
  }
}
