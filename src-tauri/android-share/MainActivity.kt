// 分享到 Minipad(0.5.5 起是文字,0.5.6 起还有图片和文件)。Android CI 用这个文件换掉 `tauri android init` 生成的 MainActivity
// (生成的只有 enableEdgeToEdge 那几行,这里照样留着)。
// 别的 App 里点「分享」选 Minipad 时(清单里的分享入口,见 share-target.xml),这里先记下分享的内容:文字直接记;
// 图片和文件的读取权限只在这时有效,所以马上在后台线程边读边写复制到 cache/share(不整个读进内存),按设置把 heic 转成 jpg、
// 把大图压小,复制完才算收到。网页用 MinipadShare.take() 拿走,让 Rust 把文件移进笔记本的 assets,写进设好的页面,
// 写完调 done() 提示一下,要回原来的 App 就退到后台。应用没开着时网页加载好了自己来拿;开着时这里叫它来拿。
// 页面里点附件链接时网页调 openFile(),这里用 FileProvider 交给手机里装的应用打开(只给笔记本 assets 里的文件)
package io.github.alstarknight.minipadnext

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import java.io.File
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

private const val MB = 1024L * 1024L
// 压缩图片时长边最多多少像素
private const val LONG_EDGE = 2048
// 能直接显示的图片和要转换的 heic(只用来在没有类型时认图片)
private val IMAGE_EXTS = setOf("jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "heic", "heif")
// 能压缩的(gif、svg 不压;avif 本来就小)
private val COMPRESSIBLE = setOf("image/jpeg", "image/png", "image/webp", "image/bmp")
// 分享入口(share-target.xml 里的 activity-alias),按 文字 1、图片 2、文件 4 加起来选一个,同时只开一个,
// 不然同一种内容的分享列表里会出现几个 Minipad
private val ALIASES = arrayOf(null, "ShareTarget", "ShareImages", "ShareTextImages", "ShareFiles", "ShareTextFiles", "ShareImagesFiles", "ShareAll")

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  // 还没交给网页的那次分享(JSON:text、title,带文件时还有 files、skipped)
  private var pending: String? = null
  // 复制分享来的文件:一次一个,不占界面线程
  private val worker = Executors.newSingleThreadExecutor()

  // 网页设的分享设置(记在手机上,应用没开着时收到分享也照着做)
  private class Options(json: JSONObject) {
    val text = json.optBoolean("text", true)
    val images = json.optBoolean("images", true)
    val files = json.optBoolean("files", true)
    val maxBytes = json.optLong("max_mb", 50).coerceIn(1, 200) * MB
    val maxCount = json.optInt("max_count", 20).coerceIn(1, 50)
    val heic = json.optBoolean("heic", true)
    val compress = json.optBoolean("compress", false)
  }

  // 分享来的一个文件:名字、类型、大小(不知道时是 -1)、是不是图片、读不了时的原因
  private class Item(val uri: Uri, val name: String, val mime: String, val size: Long, val image: Boolean, val error: String?)

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 系统回收后重建的,带的还是上次那次分享,不再记一遍
    if (savedInstanceState == null) receive(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    receive(intent)
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Bridge(), "MinipadShare")
  }

  private fun prefs() = getSharedPreferences("minipad-share", Context.MODE_PRIVATE)

  private fun options() = Options(try { JSONObject(prefs().getString("options", null) ?: "{}") } catch (e: Exception) { JSONObject() })

  private fun shareDir() = File(cacheDir, "share")

  private fun receive(intent: Intent?) {
    if (intent == null) return
    if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return
    // 从最近任务里再打开时,系统又送来当初那次分享
    if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
      ?: intent.getCharSequenceArrayListExtra(Intent.EXTRA_TEXT)?.joinToString("\n")
      ?: ""
    val title = (intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT) ?: intent.getCharSequenceExtra(Intent.EXTRA_TITLE))?.toString() ?: ""
    val streams = streams(intent)
    if (streams.isEmpty()) {
      if (intent.type?.startsWith("text/") == true) keep(JSONObject().put("text", text).put("title", title))
      return
    }
    val opts = options()
    val type = intent.type?.takeUnless { '*' in it }
    worker.execute { copyAll(streams, type, text, title, opts) }
  }

  // 分享来的文件(content:// 地址)。分享文字时 ClipData 里可能带着预览用的图片,那不是分享的内容,不要
  @Suppress("DEPRECATION")
  private fun streams(intent: Intent): List<Uri> {
    val out = mutableListOf<Uri>()
    if (intent.action == Intent.ACTION_SEND) intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { out.add(it) }
    else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { out.addAll(it) }
    val clip = intent.clipData
    if (out.isEmpty() && clip != null && intent.type?.startsWith("text/") != true) {
      for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { out.add(it) }
    }
    // 只收别的应用给的 content:// 地址:file:// 和指向 Minipad 自己的地址都不收(不能借分享把应用里的文件拿出来)
    return out.filter { it.scheme == "content" && it.authority?.startsWith(packageName) != true }.distinct()
  }

  private fun copyAll(uris: List<Uri>, type: String?, text: String, title: String, opts: Options) {
    val dir = shareDir()
    dir.mkdirs()
    // 以前没用上的(复制完应用就被关掉了之类)放了一天的删掉
    dir.listFiles()?.forEach { if (System.currentTimeMillis() - it.lastModified() > 24 * 3600 * 1000L) it.delete() }
    val files = JSONArray()
    val skipped = JSONArray()
    val skip = { name: String, reason: String -> skipped.put(JSONObject().put("name", name).put("reason", reason)) }
    val todo = mutableListOf<Item>()
    for (item in uris.map { describe(it, type) }) {
      val reason = when {
        todo.size >= opts.maxCount -> "一次最多 ${opts.maxCount} 个"
        item.image && !opts.images -> "接收图片已关闭"
        !item.image && !opts.files -> "接收文件已关闭"
        item.size > opts.maxBytes -> "超过 ${opts.maxBytes / MB} MB"
        else -> item.error
      }
      if (reason != null) skip(item.name, reason) else todo.add(item)
    }
    // 多个或者大的要复制一会儿,先说一声
    if (todo.size > 3 || todo.sumOf { maxOf(it.size, 0L) } > 8 * MB) {
      runOnUiThread { Toast.makeText(this, "正在保存……", Toast.LENGTH_SHORT).show() }
    }
    for (item in todo) {
      val temp = try { File.createTempFile("share-", ".tmp", dir) } catch (e: Exception) { skip(item.name, "读取失败"); continue }
      val error = copy(item.uri, temp, opts.maxBytes)
      if (error != null) {
        temp.delete()
        skip(item.name, error)
        continue
      }
      var file = temp
      var name = item.name
      var mime = item.mime
      if (item.image) convert(temp, name, mime, opts)?.let { (f, n, m) -> file = f; name = n; mime = m }
      files.put(JSONObject().put("path", file.absolutePath).put("name", name).put("mime", mime).put("size", file.length()))
    }
    keep(JSONObject().put("text", text).put("title", title).put("files", files).put("skipped", skipped))
  }

  private fun describe(uri: Uri, type: String?): Item {
    var name = ""
    var size = -1L
    var error: String? = null
    try {
      contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          val s = c.getColumnIndex(OpenableColumns.SIZE)
          if (n >= 0 && !c.isNull(n)) name = c.getString(n) ?: ""
          if (s >= 0 && !c.isNull(s)) size = c.getLong(s)
        }
      }
    } catch (e: SecurityException) {
      error = "没有读取权限"
    } catch (e: Exception) {
      // 有的应用不给名字和大小,复制时再看
    }
    name = name.substringAfterLast('/').trim().ifEmpty { uri.lastPathSegment?.substringAfterLast('/')?.trim() ?: "" }
    val ext = name.substringAfterLast('.', "").lowercase()
    val map = MimeTypeMap.getSingleton()
    var mime = (try { contentResolver.getType(uri) } catch (e: Exception) { null }) ?: type ?: ""
    if (mime.isEmpty() || mime == "application/octet-stream") mime = map.getMimeTypeFromExtension(ext) ?: mime
    // 名字没有扩展名时按类型补上(以后用手机里的应用打开时靠扩展名认类型)
    if (ext.isEmpty()) map.getExtensionFromMimeType(mime)?.let { name = name.ifEmpty { "附件" } + "." + it }
    val image = mime.startsWith("image/") || (mime.isEmpty() && ext in IMAGE_EXTS)
    return Item(uri, name.ifEmpty { "附件" }, mime, size, image, error)
  }

  // 边读边写复制到 to,超过上限就停;返回没复制成的原因
  private fun copy(uri: Uri, to: File, limit: Long): String? {
    try {
      val input = contentResolver.openInputStream(uri) ?: return "读取失败"
      input.use {
        to.outputStream().use { out ->
          val buf = ByteArray(64 * 1024)
          var total = 0L
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > limit) return "超过 ${limit / MB} MB"
            out.write(buf, 0, n)
          }
          out.fd.sync()
        }
      }
      return null
    } catch (e: SecurityException) {
      return "没有读取权限"
    } catch (e: Exception) {
      return "读取失败"
    }
  }

  // 按设置把 heic 转成 jpg、把长边超过 2048 的图压小(压完反而更大就用原图);用系统自带的解码(Android 9 起有)。
  // 不用转或者转不了(系统太老、解不开、内存不够)时是 null,原样存(没转的 heic 当文件存)。返回新的文件、名字和类型
  private fun convert(file: File, name: String, mime: String, opts: Options): Triple<File, String, String>? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return null
    val ext = name.substringAfterLast('.', "").lowercase()
    val heic = mime.startsWith("image/heic") || mime.startsWith("image/heif") || ext == "heic" || ext == "heif"
    if (heic && !opts.heic) return null
    if (!heic) {
      if (!opts.compress || mime !in COMPRESSIBLE) return null
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(file.path, bounds)
      if (maxOf(bounds.outWidth, bounds.outHeight) <= LONG_EDGE) return null
    }
    var out: File? = null
    try {
      val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { decoder, info, _ ->
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        val w = info.size.width
        val h = info.size.height
        val long = maxOf(w, h)
        if (opts.compress && long > LONG_EDGE) decoder.setTargetSize(maxOf(1, w * LONG_EDGE / long), maxOf(1, h * LONG_EDGE / long))
      }
      // 透明的图压成 png,别的压成 jpg
      val png = !heic && bitmap.hasAlpha()
      val made = File.createTempFile("share-", ".tmp", file.parentFile)
      out = made
      val ok = made.outputStream().use { stream ->
        bitmap.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, if (opts.compress) 85 else 90, stream).also { stream.fd.sync() }
      }
      bitmap.recycle()
      if (!ok || made.length() == 0L || (!heic && made.length() >= file.length())) {
        made.delete()
        return null
      }
      file.delete()
      val stem = if ('.' in name) name.substringBeforeLast('.') else name
      return Triple(made, stem.ifEmpty { "图片" } + (if (png) ".png" else ".jpg"), if (png) "image/png" else "image/jpeg")
    } catch (e: Throwable) {
      out?.delete()
      return null
    }
  }

  // 记下这次分享,叫网页来拿(网页还没加载好时,等它加载好了自己来拿)
  private fun keep(shared: JSONObject) {
    val old = synchronized(this) { pending.also { pending = shared.toString() } }
    // 上一次还没拿走就又分享了:上一次复制来的文件用不上了
    if (old != null) discardFiles(try { JSONObject(old).optJSONArray("files") } catch (e: Exception) { null })
    runOnUiThread { webView?.evaluateJavascript("window.__minipadShared && window.__minipadShared()", null) }
  }

  // 删掉复制来的文件(只删 cache/share 里的)
  private fun discardFiles(files: JSONArray?) {
    if (files == null) return
    val dir = try { shareDir().canonicalFile } catch (e: Exception) { return }
    for (i in 0 until files.length()) {
      try {
        val file = File(files.optJSONObject(i)?.optString("path") ?: continue).canonicalFile
        if (file.parentFile == dir) file.delete()
      } catch (e: Exception) {
        // 删不掉的一天后自己清掉
      }
    }
  }

  inner class Bridge {
    // 拿走还没写的那次分享,没有(或者文件还在复制)时是 null
    @JavascriptInterface
    fun take(): String? = synchronized(this@MainActivity) { pending.also { pending = null } }

    @JavascriptInterface
    fun done(message: String, back: Boolean) {
      runOnUiThread {
        Toast.makeText(this@MainActivity, message, Toast.LENGTH_SHORT).show()
        if (back) moveTaskToBack(true)
      }
    }

    // 网页的分享设置(JSON:text、images、files 三个开关,max_mb、max_count、heic、compress):记下来,
    // 再按三个开关只开对应的那个分享入口,关掉的那一类分享列表里就没有 Minipad 了
    @JavascriptInterface
    fun setOptions(json: String) {
      val saved = try { JSONObject(json) } catch (e: Exception) { return }
      prefs().edit().putString("options", saved.toString()).apply()
      val opts = Options(saved)
      val wanted = ALIASES[(if (opts.text) 1 else 0) or (if (opts.images) 2 else 0) or (if (opts.files) 4 else 0)]
      val base = MainActivity::class.java.name.substringBeforeLast('.')
      for (alias in ALIASES.filterNotNull()) {
        val target = ComponentName(this@MainActivity, "$base.$alias")
        val state = if (alias == wanted) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        if (packageManager.getComponentEnabledSetting(target) != state) {
          packageManager.setComponentEnabledSetting(target, state, PackageManager.DONT_KILL_APP)
        }
      }
    }

    // 网页用不上的那几个复制来的文件(分享关着、写页面之前就出错了):删掉。json 是 take() 给的 files
    @JavascriptInterface
    fun discard(json: String) {
      discardFiles(try { JSONArray(json) } catch (e: Exception) { null })
    }

    // 用手机里装的应用打开附件(path 是 Rust 找到的完整路径)。只给笔记本 assets 里的文件:
    // 笔记文件夹(notes)里、或者它下面一层的笔记本文件夹里的 assets,不给隐藏的。
    // 打开了是空字符串,没有能打开它的应用是 none,别的是出错的原因
    @JavascriptInterface
    fun openFile(path: String): String {
      val (file, notes) = try { File(path).canonicalFile to File(dataDir, "notes").canonicalFile } catch (e: Exception) { return "找不到这个附件" }
      val folder = file.parentFile
      val book = folder?.parentFile
      val inBook = book != null && (book == notes || (book.parentFile == notes && !book.name.startsWith(".")))
      if (!file.isFile || file.name.startsWith(".") || folder?.name != "assets" || !inBook) return "只能打开笔记本 assets 里的文件"
      return try {
        val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", file)
        val type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()) ?: "*/*"
        startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        ""
      } catch (e: ActivityNotFoundException) {
        "none"
      } catch (e: Exception) {
        e.message ?: e.toString()
      }
    }
  }
}
