# Minipad Next

一个按热键就弹出来的悬浮多标签笔记本。使用体验参考 minipad2,代码是全新写的(没有用 minipad2 的源码),基于 [Tauri 2](https://tauri.app)。

---

## 一、使用说明

### 呼出和隐藏

| 操作 | 效果 |
| --- | --- |
| **Ctrl+M**(全局,任何程序里都能用) | 呼出窗口;窗口已经在前面时再按一次就隐藏 |
| **Esc** | 隐藏窗口(有搜索框或设置面板打开时先关掉它们) |
| 窗口右上角 ✕ | 隐藏到托盘,不会退出 |
| 左键点托盘图标 | 显示 / 隐藏 |
| 右键托盘图标 | 显示 / 隐藏、打开笔记文件夹、退出 |

热键可以在设置里改。如果 Ctrl+M 和你常用的软件冲突(比如 OneNote 里 Ctrl+M 是新窗口),换成 Ctrl+Alt+M 之类的组合即可。

### 贴边隐藏

把窗口拖到屏幕的**上边、左边或右边**贴住,鼠标离开窗口大约半秒后,窗口会缩到屏幕外面,只露出一条细边。鼠标碰到那条边,窗口会滑出来。

- 不想要这个功能,可以在设置里关掉“靠屏幕边缘时自动隐藏”。
- 窗口缩进去以后按 Ctrl+M,也能直接把它叫出来。

### 页面(标签页)

| 操作 | 效果 |
| --- | --- |
| **+** 按钮 或 **Ctrl+T** / **Ctrl+N** | 新建页面,建好后可以直接输入名字 |
| 双击标签 | 重命名 |
| 拖动标签 | 调整顺序 |
| 右键标签 | 重命名 / 删除 |
| **Ctrl+W** | 删除当前页面(会先确认) |
| **Ctrl+Tab** / **Ctrl+Shift+Tab** | 下一个 / 上一个页面 |
| **Ctrl+1 ~ Ctrl+8** | 跳到第 1~8 个页面 |
| **Ctrl+9** | 跳到最后一个页面 |
| 在标签栏上滚动鼠标滚轮 | 页面多的时候左右滚动标签 |

删除的页面不会真正删掉,而是移到笔记文件夹里的 `.trash` 文件夹,想找回的话把文件拖回笔记文件夹即可。

### 编辑和阅读

每个页面有两种模式,用 **Ctrl+E** 或顶栏的眼睛按钮切换,每个页面会记住自己的模式。

- **编辑模式**:纯文本编辑,Tab 键插入制表符。
- **阅读模式**:按 Markdown 渲染,支持标题、列表、表格、任务清单、引用、链接、图片等。
  - 代码块有语法高亮,右上角有 **“复制”** 按钮,点一下就把整段代码复制到剪贴板。
  - 点链接会用系统浏览器打开。
  - 在空白处双击可以回到编辑模式。

代码块的写法:

````
```python
print("hello")
```
````

### 搜索

**Ctrl+F** 搜索所有页面的内容和标题。用 ↑ ↓ 选择结果,按 Enter 或点击结果会跳到对应页面,并选中匹配的文字。

### 保存

- 输入时自动保存(停止输入约半秒后写入),切换窗口、隐藏窗口、退出时也会保存。**Ctrl+S** 可以立刻保存。
- 底部状态栏显示“保存中…”、“已保存”或保存失败的原因。
- 每个页面就是一个普通的 `页面名.md` 文件,可以用任何编辑器打开,也可以用网盘同步。
- 页面顺序、当前页面、每页的模式记录在笔记文件夹里的 `.minipad.json`。

默认位置:

| 内容 | 位置 |
| --- | --- |
| 笔记 | `%APPDATA%\com.minipadnext.app\notes\` |
| 设置(含窗口位置大小) | `%APPDATA%\com.minipadnext.app\settings.json` |

### 设置

点顶栏的齿轮按钮打开设置:

- **呼出热键**:点输入框,然后直接按下想要的组合键(需要包含 Ctrl / Alt / Shift / Win 之一,F1~F12 可以单独用)。
- **窗口总在最前**:顶栏的图钉按钮也能切换。
- **靠屏幕边缘时自动隐藏**
- **在任务栏显示**:默认不显示,只在托盘里。
- **开机启动**:开机后自动在托盘待命,不弹窗口。
- **外观**:跟随系统 / 浅色 / 深色。
- **字号**:也可以用 **Ctrl+加号** / **Ctrl+减号** 调整。
- **笔记文件夹**:可以改成网盘同步目录(比如 OneDrive 里的某个文件夹)。改了以后程序会读取新文件夹里的笔记,**旧笔记不会自动搬过去**,需要的话自己把 `.md` 文件复制过去。

### 快捷键总表

| 快捷键 | 作用 |
| --- | --- |
| Ctrl+M | 呼出 / 隐藏(全局,可改) |
| Esc | 隐藏窗口 |
| Ctrl+T / Ctrl+N | 新建页面 |
| Ctrl+W | 删除当前页面 |
| Ctrl+E | 编辑 / 阅读切换 |
| Ctrl+F | 搜索全部页面 |
| Ctrl+S | 立即保存 |
| Ctrl+Tab / Ctrl+Shift+Tab | 切换页面 |
| Ctrl+1 ~ 9 | 跳到第 N 个页面(9 = 最后一个) |
| Ctrl+加号 / Ctrl+减号 | 调整字号 |

---

## 二、在 Windows 上构建

### 1. 准备环境(只需要做一次)

1. **Microsoft C++ 生成工具**:下载 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/),安装时勾选 **“使用 C++ 的桌面开发”**。
2. **Rust**:从 [rustup.rs](https://rustup.rs) 下载 `rustup-init.exe` 并运行,一路默认即可。装完重新打开终端,运行 `rustc -V` 能看到版本号就说明装好了。
3. **Node.js**:安装 [Node.js](https://nodejs.org) 的 LTS 版本(18 或更新)。
4. **WebView2**:Windows 10/11 一般已经自带,不用管。

### 2. 构建

在项目根目录(就是这个 README 所在的文件夹)打开 PowerShell 或命令提示符:

```powershell
npm install
npm run build
```

第一次构建要下载并编译 Rust 依赖,会花几分钟,之后就快了。

`npm run build` 会自动做两件准备工作:把前端用到的第三方库复制到 `src/vendor/`,以及在没有图标时根据 `app-icon.svg` 生成 `src-tauri/icons/`。

### 3. 构建结果

| 文件 | 说明 |
| --- | --- |
| `src-tauri\target\release\bundle\nsis\Minipad Next_0.1.0_x64-setup.exe` | 安装程序 |
| `src-tauri\target\release\minipad-next.exe` | 程序本体,可以直接运行 |

### 开发调试

```powershell
npm run dev
```

会以调试模式启动程序,改了 `src/` 里的前端文件后,在窗口里按 **Ctrl+R** 刷新即可看到效果;改了 Rust 代码会自动重新编译。

也可以先运行一次 `npm run prepare-assets`,再直接用浏览器打开 `src/index.html` 看界面。浏览器里用的是模拟后端(数据存在浏览器的 localStorage),热键、托盘、贴边隐藏这些系统功能不会生效。

### 在 Linux 上交叉编译 Windows 版(可选)

```bash
sudo apt install mingw-w64 nsis libayatana-appindicator3-dev
rustup target add x86_64-pc-windows-gnu
npm install
npx tauri build --target x86_64-pc-windows-gnu
```

---

## 三、项目结构

```
minipad-next/
├─ README.md               本文档
├─ package.json            npm 脚本和前端依赖
├─ app-icon.svg            程序图标源文件
├─ scripts/prepare.mjs     构建前准备(复制第三方库、生成图标)
├─ src/                    前端界面(纯 HTML/CSS/JS,不需要打包器)
│  ├─ index.html
│  ├─ style.css
│  └─ app.js               标签、编辑、阅读、搜索、设置的全部逻辑
└─ src-tauri/              Rust 后端
   ├─ Cargo.toml
   ├─ tauri.conf.json      窗口、打包配置
   ├─ capabilities/        前端权限
   └─ src/
      ├─ main.rs
      └─ lib.rs            热键、托盘、贴边隐藏、笔记读写、设置
```

## 四、已知限制

- 程序没有数字签名,第一次运行时 Windows 可能提示“已保护你的电脑”,点“更多信息”再点“仍要运行”即可。
- 贴边隐藏是鼠标一离开就缩回去,正在打字时也一样。
- 程序运行时如果在外部修改了 `.md` 文件,程序不会自动重新读取,重启程序后才会看到变化。
