# Model Dock For Codex

Keep everything in Codex - and add the models it does not ship with. Give
DeepSeek, Qwen, or a model running on your own machine eyes, ears, a voice, a
web search, and a memory, without leaving Codex.

A thin local Responses bridge for OpenCode Go, DeepSeek official, and local
engines - Ollama, llama.cpp, and vLLM are detected on loopback, and any other
OpenAI-compatible endpoint can be added by URL - with native GPT passthrough
and live token, latency, and trace observability.

<p align="center">
  English ·
  <a href="#中文">中文</a> ·
  <a href="#日本語">日本語</a>
</p>

<p align="center">
  <img src="assets/model-picker-banner.png" alt="Native GPT models + DeepSeek in the Codex model picker" width="70%" />
</p>

<p align="center">
  <img src="assets/dashboard-banner.png" alt="Vision, audio, video and memory - empower DeepSeek with full observability" width="70%" />
</p>

<p align="center">
  <img src="assets/memory-banner.png" alt="Three-tier memory: project, global, expert - reward 50% to 80%, time 4h15m to 2h24m" width="70%" />
</p>

## Why Model Dock For Codex

DeepSeek V4 Flash is fast and cheap, but it cannot see, speak, or listen, and
the OpenCode Go Responses endpoint it runs through has no hosted search (the
DeepSeek official endpoint does). A Qwen or any other model you host yourself
has the same gaps. Model Dock For Codex adds these as tools,
without rewriting the conversation history:

- **See** - paste an image into Codex and the request is routed to the vision
  model you chose in Settings, or let the model call `vision_inspect` on a
  screenshot or file.
- **Speak** - the `speak` tool turns text into a local audio file.
- **Hear** - the `hear` tool transcribes an audio file back to text.
- **Search** - the `web_search_exa` tool queries the web through Exa.
- **Remember** - `store_memory`, `recall_memory`, and `learn` give the model a
  lightweight cross-session memory: store decisions, recall them later, or
  bulk-ingest notes and docs. On by default; set `MODELDOCK_MEMORY=0` in
  `~/.modeldock/.env` and restart to disable it.
- **Generate** - the `image_gen` tool creates AI images through the Codex
  ChatGPT backend (requires a Codex account with ChatGPT sign-in).
- **Make** - the `content-to-video` skill produces finished MP4 videos from a
  prompt — storyboard, build scenes in three.js / HTML or HyperFrames, assemble
  with ffmpeg, and QA every frame. Audio assets are not bundled; download from
  the [video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft) repo
  when a project needs sound.
- **Run local** — Ollama and custom Responses endpoints connect your own models
  to Codex. Codex usage is automatically optimized to fit your local model's
  specifications — CPU compression mode activates as soon as a local model is
  detected.

The bridge is a thin local gateway: the Responses stream passes through
untouched, and multi-turn tool loops, streaming, and long-session compaction
keep working the way they do on the native channel.

## Install

Windows:

```
$installer = Join-Path $env:TEMP "modeldock-install.ps1"
Invoke-WebRequest -UseBasicParsing "https://github.com/architectds/modeldock/releases/latest/download/install.ps1" -OutFile $installer
powershell -NoProfile -ExecutionPolicy Bypass -File $installer
```

macOS:

```
curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
```

The installer checks Node.js >= 24, downloads Model Dock For Codex to
`~/.modeldock`, starts it in the background, and opens the dashboard. Add at
least one provider in Settings: [OpenCode Go](https://opencode.ai/auth),
DeepSeek official, a custom Responses endpoint, or connect Ollama for local
models. The `content-to-video` skill is not downloaded by the installer; copy
`skills/content-to-video` into Codex's skills directory manually when you want
the video capability.

## Connect Codex

1. The installer already opened **http://127.0.0.1:4097** (first run shows the
   Settings dialog for your token). If not, open it in your browser.
2. Flip the "Use other APIs in Codex" switch on the page.
3. Fully quit and restart Codex, then confirm on the "I restarted Codex" banner.
4. Pick a Model Dock model in Codex's model picker (the default is already
   selected; native GPT models are listed too).

## Daily use

**Model picker** - switch the main model in Codex's own picker (bottom-right).
Model Dock shows the active provider and model read-only on the dashboard; it
does not change your Codex model.

**Vision model** - choose the vision model from the dashboard picker. It is
used for pasted images and for `vision_inspect` calls. The picker lists
vision-capable models from all enabled providers, so you can pair a DeepSeek
main model with a MiMo vision model, for example. Switching the main provider
preserves your current vision pick if it remains reachable. Providers with no
vision-capable model show `None`.

**Upstreams** - seven providers are supported:
- **OpenCode Go** — `OPENCODE_GO_TOKEN`; large catalog including free models.
- **DeepSeek official** — `DEEPSEEK_API_KEY`; has built-in web search.
- **xAI (Grok)** — sign in with a SuperGrok or X Premium account from Settings.
  Usage counts against that subscription rather than an API balance.
- **Custom** — any Responses-compatible endpoint, configured in Settings.
- **Ollama**, **llama.cpp**, **vLLM** — engines already running on this machine.
  Found by scanning rather than configured; see *Local models* below.

Every model id carries a provider suffix — for example
`deepseek-v4-flash@deepseek-official` — that selects the upstream and is
stripped before the request reaches the API. Native GPT models stay in the
Codex model picker; ModelDock never accesses, stores, copies, or replays
OpenAI credentials.

The setup guide accepts any configured provider token for ON mode. On a
DeepSeek-only install it selects `deepseek-v4-flash@deepseek-official` as the
main model and `None` for vision, and persists that route across restarts.

**Local models** - an engine already running on this machine is found rather
than configured. Press **Rescan** on the dashboard's local engines panel: the
scan reads the machine's listening sockets and the process behind each one, so
an engine is found on whatever port it was started with, not only the default.
On a reachable engine the label at the right of its row turns blue; pressing
the row opens that engine's drawer.

Ollama connects and there is nothing else to decide. A llama-server gets the
rest of the drawer, because its command line is what decides whether the model
fits on the card at all:

- **The memory bar** stacks weights, KV cache, a fixed overhead, and what is
  left over. The numbers come from the model file's own header, read once during
  the scan and cached — opening the drawer reads nothing, and the figures still
  answer after the engine stops, which is when you want them. A hybrid model
  keeps a growing cache on only some of its layers, so counting every layer
  overstates KV several times over; the reader counts the layers that actually
  pay. Card capacity comes from the driver rather than from `AdapterRAM`, which
  is 32-bit and reports every card above 4 GB as exactly 4 GB.
- **Total context** moves between fixed rungs. The recommendation keeps 2 GiB
  spare; the slider reaches further, down to 1.2 GiB, and the bar reports the
  band it has entered. Where a card cannot hold the model at all, the drawer
  says so instead of offering a window that cannot be allocated.
- **Concurrent sessions** are slots that each see the whole window rather than a
  reserved slice. The cap is the working room a session needs, not memory: below
  about 15K a session has nothing left after the per-turn overhead.
- **KV precision** is 4, 8 or 16. Stops that this card cannot be trusted with are
  greyed out, and refused when a restart is applied — a broken cache is wrong
  answers rather than slow ones.
- **Optimize** sets the three controls to what community sweeps recommend for
  this card. It is a recipe, not a benchmark run on your machine.
- **Restart with these** stops the engine and starts it again with what you
  chose, editing the command line it was already running instead of composing a
  fresh one, so a flag you needed and we did not think of is not dropped. The
  line shown above the button is exactly what will run. If the old process will
  not release its port, nothing is started.

Warnings above the drawer name settings that are on and doing nothing —
`--context-shift` on a model whose state cannot be shifted, a quantized KV cache
on a card that does not do it reliably, prediction blocks the backend ignores.
Nothing is broken when one appears; the configuration is saying something that
is not true.

**Sub-agent** - choose a dedicated model for the sub-agent role from the
dashboard. The picker includes models from all enabled providers plus native
GPT models from your signed-in Codex account.

**Speech** - open the TTS / STT tile on the dashboard and toggle TTS or STT on.
The `speak` and `hear` tools become available to the model.

**MCP tools** - web search, vision, image generation, speech, and memory reach
Codex as tools that survive gateway restarts. The connection Codex opens to
them goes stale on a restart and the client never re-establishes it, so a tool
that starts failing with a connection error (`fetch failed`, `ECONNREFUSED`,
`unsupported call`) will not heal on its own. Call the tools directly from the
shell — `search`, `vision`, `image`, `speak`, `hear`, `recall`, `store` — for
example:
`node scripts/mcp-call.mjs search "..."` or
`node scripts/mcp-call.mjs vision <path> <question>`.
On Linux/macOS installs where `node` is not on PATH, use the bundled-runtime
wrapper: `sh scripts/mcp-call.sh <command> <args>`. The injected base
instructions already tell the model to switch to the shell fallback when an MCP
call fails, so you normally do not have to repeat it.

**Language** - the dashboard speaks English, 简体中文, and 日本語. Change it
anytime under Settings -> Interface language.

**Autostart & updates** - Model Dock starts hidden at every login by default;
flip the Autostart toggle in Settings to change that. A green Update button
appears when a new release is ready - one click moves directly to the latest
release, migrates the managed Node runtime when needed, restarts, and reloads.

If the version in the header does not change after an update, the download
succeeded and only the restart did not: the new files are already installed and
just are not running yet. Run `scripts/restart.ps1` (Windows) or
`scripts/restart.sh` (macOS/Linux) once from your install directory.

---

## Manual recovery

If the gateway is not reachable, use the small recovery menu shipped with the
installation. It has exactly two actions:

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.modeldock\scripts\recover.ps1"
```

macOS or Linux:

```sh
sh ~/.modeldock/scripts/recover.sh
```

1. **Restart ModelDock gateway** stops only the gateway owned by this
   installation, starts it again, and waits for `/healthz`.
2. **Restore Codex native route** first asks the running gateway to disable its
   route. If the gateway is down, it restores the last verified
   `config.toml` backup directly and marks Codex for restart. The current
   config is saved as a `.native-recovery-*.bak` file before replacement.

After either configuration change, fully quit and restart Codex. The recovery
menu does not remove ModelDock or delete the backup.

## Uninstall

Removes ModelDock while keeping your data: stops only the gateway owned by this
installation, drops the login autostart entry, clears the install state (the
memory vault and the Codex config backups are kept), and removes the gateway
log.

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.modeldock\scripts\uninstall.ps1"
```

macOS or Linux:

```sh
sh ~/.modeldock/scripts/uninstall.sh
```

## Disclaimer

Model Dock For Codex is an independent, community-maintained project. It is
not affiliated with, endorsed by, or sponsored by OpenAI, DeepSeek, or
opencode.ai, and it is not an official product of any of them. "Codex",
"OpenAI", "DeepSeek", "OpenCode", and any other names or marks referenced in
this repository are trademarks or registered trademarks of their respective
owners and are used here only to describe interoperability.

The software is provided "as is", without warranty of any kind, express or
implied, including but not limited to the warranties of merchantability,
fitness for a particular purpose, and non-infringement. In no event shall the
authors be liable for any claim, damages, or other liability arising from or in
connection with the software or its use. Nothing in this repository constitutes
legal, financial, or professional advice.

## 中文

在 Codex 里给 DeepSeek、Qwen 以及跑在你自己机器上的模型装上眼睛、耳朵、
声音、网络搜索和记忆——通过一个轻量本地 Responses 桥接层连接 OpenCode Go、
DeepSeek 官方 API 和本地引擎（自动探测环回地址上的 Ollama、llama.cpp、
vLLM，其它 OpenAI 兼容端点也可按 URL 添加），支持原生 GPT 透传，并带实时
token、延迟与调用链路观测。

DeepSeek V4 Flash 又快又便宜，但它看不见、听不到、不会说话，Responses
端点也没有内置搜索——确切地说，它所经过的 OpenCode Go Responses 端点没有
内置搜索（DeepSeek 官方端点有）。自己部署的 Qwen 或其它本地模型同样如此。Model Dock For Codex 以工具的形式补全这些能力，并附带轻量跨会话记忆，
且不改写对话历史：

- **看图** - 把图片粘贴进 Codex，请求会自动路由到你在设置中选择的视觉模型；
  也可以让模型对截图或文件调用 `vision_inspect`。
- **说话** - `speak` 工具把文本合成本地音频文件。
- **听写** - `hear` 工具把音频文件转写成文本。
- **搜索** - `web_search_exa` 工具通过 Exa 查询网络。
- **记住** - `store_memory`、`recall_memory` 和 `learn` 给模型一份轻量跨会话记忆：存储决策、随时检索，或批量导入笔记和文档。此功能默认开启；如需关闭，在 `~/.modeldock/.env` 中设置 `MODELDOCK_MEMORY=0` 并重启即可。
- **生成图片** - `image_gen` 工具通过 Codex 的 ChatGPT 后端创建 AI 图像（需要 Codex 绑定 ChatGPT 账号）。
- **本地运行** — Ollama 和自定义 Responses 端点将你的本地模型接入 Codex。检测到
  本地模型后，Codex 的用量会自动适配其规格，CPU 压缩模式同步开启。

桥接层是轻量本地网关：Responses 流原样透传，多轮工具循环、流式输出和长会话压缩都与原生通道一致。

### 安装

Windows：

```
$installer = Join-Path $env:TEMP "modeldock-install.ps1"
Invoke-WebRequest -UseBasicParsing "https://github.com/architectds/modeldock/releases/latest/download/install.ps1" -OutFile $installer
powershell -NoProfile -ExecutionPolicy Bypass -File $installer
```

macOS：

```
curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
```

安装程序会检查 Node.js >= 24，把 Model Dock For Codex 下载到
`~/.modeldock`，在后台启动并打开仪表盘。在弹出的设置对话框中添加至少一个
provider：[OpenCode Go](https://opencode.ai/auth)、DeepSeek 官方、自定义
Responses 端点，或连接 Ollama 使用本地模型。

### 接入 Codex

1. 安装程序已经自动打开 **http://127.0.0.1:4097**（首次运行会弹出设置对话框
   让你粘贴 token）；如果没有，请在浏览器中打开。
2. 打开页面上的「在 Codex 中使用其他 API」开关。
3. 完全退出并重启 Codex，然后在「我已重启 Codex」横幅上确认。
4. 在 Codex 的模型菜单里选择 Model Dock 模型（默认模型已选中；原生 GPT 模型
   也会列出）。

### 日常使用

**模型选择** - 在 Codex 自带的模型选择器（右下角）切换主模型。仪表盘只读
显示当前 provider 和模型，不会改动你的 Codex 模型。

**视觉模型** - 在仪表盘选择视觉模型，用于粘贴的图片和 `vision_inspect`
调用。选择器会列出所有已启用 provider 中支持视觉的模型，可以将 DeepSeek
主模型与 MiMo 视觉模型配对使用。切换主 provider 时，只要当前视觉模型仍然
可达，选择会自动保留。

**上游** - 支持七个 provider：**OpenCode Go**（`OPENCODE_GO_TOKEN`，包含免费模型）、
**DeepSeek 官方**（`DEEPSEEK_API_KEY`，自带网络搜索）、**xAI（Grok）**（用
SuperGrok 或 X Premium 账号在设置中登录，用量计入该订阅而非 API 余额）、
**自定义**（任意兼容 Responses 接口的端点，在设置中配置），以及
**Ollama**、**llama.cpp**、**vLLM**（本机上已经在跑的引擎，靠扫描发现而不是手工
配置，见下面的「本地模型」）。
每个模型 id 都带有 provider 后缀（例如 `deepseek-v4-flash@deepseek-official`），
用于选择上游，请求到达 API 前后缀会自动去除。原生 GPT 模型保留在 Codex 的模型
选单中；ModelDock 从不访问、存储、复制或回放 OpenAI 凭证。

**本地模型** - 本机上已经在跑的引擎是被「找到」的，不是被配置的。在面板的本地引擎
区域按 **Rescan**：扫描读取本机的监听端口和每个端口背后的进程，所以引擎用哪个端口
启动就能在哪个端口被找到，不限于默认端口。可达的引擎，行右侧的标签会变蓝；
点这一行就打开该引擎的抽屉。

Ollama 连上就没有别的可调了。llama-server 会得到抽屉的其余部分，因为它的命令行
才是决定这个模型能不能装进显卡的东西：

- **显存条** 依次堆叠权重、KV 缓存、固定开销和剩余量。这些数字来自模型文件自己的
  头部，在扫描时读一次并缓存 —— 打开抽屉不读任何文件，而且引擎停掉之后数字依然
  能回答，那正是你需要它的时候。混合架构的模型只有一部分层保有会增长的缓存，按
  所有层去算会把 KV 高估好几倍；读取器只数真正付出代价的那些层。显卡容量取自驱动
  而不是 `AdapterRAM` —— 后者是 32 位的，任何 4 GB 以上的卡都会报成正好 4 GB。
- **总上下文** 在固定档位之间移动。推荐值保留 2 GiB 余量；滑杆可以往前拖到只剩
  1.2 GiB，显存条会报告它进入了哪一段。如果这张卡根本装不下这个模型，抽屉会直说，
  而不是给出一个分配不出来的窗口。
- **并行会话** 是若干个槽位，每个槽位看到的是**整个**窗口而不是切走的一片。上限由
  一个会话需要的工作空间决定，不是由显存决定：低于约 15K，一个会话在付完每轮的
  固定开销后就没有余地了。
- **KV 精度** 是 4、8、16 三档。这张卡上不可信的档位会灰掉，并且在重启时被拒绝 ——
  坏掉的缓存给出的是错的答案，不是慢的答案。
- **Optimize** 把三个控件设成社区实测推荐的值。那是一份配方，不是在你机器上跑出来
  的基准测试。
- **用这些参数重启** 会停掉引擎再用你选的参数启动，做法是**编辑它原本就在跑的那条
  命令行**而不是重新拼一条，所以你需要、而我们没想到的旗标不会被丢掉。按钮上方
  显示的那一行就是将要执行的那一行。如果旧进程不肯释放端口，则什么都不会启动。

抽屉上方的警告会点名那些「开着但不起作用」的设置 —— 对状态无法滑动的模型设了
`--context-shift`、在做不可靠的卡上设了 KV 量化、权重里带着后端会忽略的预测层。
出现警告不代表现在坏了；它代表这份配置在说一件不真的事。

**子代理** - 在仪表盘为子代理角色单独选择一个模型。选择器包含所有已启用
provider 的模型以及你 Codex 账号中的原生 GPT 模型。

**语音** - 打开仪表盘的 TTS / STT 磁贴并启用 TTS 或 STT，`speak` 和 `hear`
工具即可供模型使用。

**界面语言** - 仪表盘支持 English、简体中文、日本語，
可在设置 -> 界面语言中随时切换。

**开机自启与更新** - Model Dock 默认在每次登录时隐藏启动；可在设置中
切换 Autostart 开关。有新版本时出现绿色更新按钮，一键下载、重启并刷新。

### 手动恢复

如果网关无法访问，使用安装附带的小型恢复菜单，它只有两个操作：

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.modeldock\scripts\recover.ps1"
```

macOS 或 Linux：

```sh
sh ~/.modeldock/scripts/recover.sh
```

1. **重启 ModelDock 网关** - 只停止本安装拥有的网关，重新启动并等待
   `/healthz`。
2. **恢复 Codex 原生路线** - 先请运行中的网关关闭其路线；如果网关已停止，
   则直接从最后验证的 `config.toml` 备份还原，并标记 Codex 需要重启。
   替换前会把当前配置保存为 `.native-recovery-*.bak` 文件。

任一路线变更后，请完全退出并重启 Codex。恢复菜单不会删除 ModelDock 或备份。

### 卸载

卸载会保留你的数据：只停止本安装拥有的网关、移除登录自启动项、清理安装状态
（记忆库和 Codex 配置备份会保留），并删除网关日志。

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.modeldock\scripts\uninstall.ps1"
```

macOS 或 Linux：

```sh
sh ~/.modeldock/scripts/uninstall.sh
```

---

## 日本語

DeepSeek・Qwen・手元のマシンで動くモデルに目、耳、声、そしてウェブ検索を -
薄い Responses ブリッジ経由で OpenCode Go、DeepSeek 公式 API、そしてローカル
エンジン（ループバック上の Ollama・llama.cpp・vLLM を自動検出、他の
OpenAI 互換エンドポイントも URL で追加可能）をつなぎます。

DeepSeek V4 Flash は速くて安い一方、画像を見られず、話せず、聞けず、
それが経由する OpenCode Go の Responses エンドポイントには検索機能も
ありません（DeepSeek 公式エンドポイントにはあります）。自分で動かす Qwen
などのローカルモデルも同じです。Model Dock For
Codex はこれら 5 つをツールとして追加し、会話履歴は書き換えません：

- **見る** - 画像を Codex に貼り付けると、リクエストは設定で選択した
  ビジョンモデルにルーティングされます。スクリーンショットや
  ファイルには `vision_inspect` を呼べます。
- **話す** - `speak` ツールがテキストをローカル音声ファイルに変換します。
- **聞く** - `hear` ツールが音声ファイルをテキストに書き起こします。
- **検索** - `web_search_exa` ツールが Exa 経由でウェブ検索します。
- **記憶** - `store_memory`、`recall_memory`、`learn` で軽量なクロスセッション記憶を
  提供します。決定事項を保存し、後から検索したり、メモやドキュメントを一括取り込むことができます。
  デフォルトで有効です；無効にするには `~/.modeldock/.env` で
  `MODELDOCK_MEMORY=0` を設定して再起動してください。
- **生成** - `image_gen` ツールが Codex の ChatGPT バックエンド経由で AI 画像を
  生成します（Codex の ChatGPT サインインが必要です）。
- **ローカル実行** — Ollama とカスタム Responses エンドポイントで自分のモデルを
  Codex に接続できます。ローカルモデルが検出されると、Codex の使用量がモデルの仕様に
  合わせて自動的に最適化され、CPU 圧縮モードが有効になります。

ブリッジは Responses ストリームをバッファリングも再合成もせずそのまま転送
します。書き換えは文書化された最小限のものだけです：コンパクトタスクが
切り離した孤立ツール行は削除・再ペアリングされ、ネイティブのコンパクト
プロトコルを話さないルーティングモデルにはリモートコンパクションが合成され
ます。マルチターンのツールループ、ストリーミング、圧縮はネイティブ同様に
動作します。

### インストール

Windows：

```
$installer = Join-Path $env:TEMP "modeldock-install.ps1"
Invoke-WebRequest -UseBasicParsing "https://github.com/architectds/modeldock/releases/latest/download/install.ps1" -OutFile $installer
powershell -NoProfile -ExecutionPolicy Bypass -File $installer
```

macOS：

```
curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
```

インストーラーは Node.js >= 24 を確認し、Model Dock For Codex を
`~/.modeldock` にダウンロードしてバックグラウンドで起動し、ダッシュボード
を開きます。設定ダイアログで少なくとも1つのプロバイダーを追加してください：
[OpenCode Go](https://opencode.ai/auth)、DeepSeek 公式、カスタム Responses
エンドポイント、または Ollama（ローカルモデル）。

### Codex への接続

1. インストーラーが **http://127.0.0.1:4097** を自動で開きます（初回は
   トークンを貼り付ける設定ダイアログが出ます）。開かない場合はブラウザで
   開いてください。
2. ページの「Codex で他の API を使う」スイッチをオンにします。
3. Codex を完全に終了して再起動し、ページの「Codex を再起動しました」バナー
   で確認します。
4. Codex のモデル選択で Model Dock モデルを選びます（既定モデルは選択済み。
   ネイティブ GPT モデルも表示されます）。

### 日常使い

**モデル選択** - メインモデルは Codex 側のモデル選択（右下）で切り替えます。
ダッシュボードは現在のプロバイダーとモデルを読み取り専用で表示し、Codex の
モデルは変更しません。

**ビジョンモデル** - ダッシュボードでビジョンモデルを選択します。貼り付け
た画像と `vision_inspect` 呼び出しに使われます。ピッカーはすべての有効な
プロバイダーのビジョン対応モデルを一覧表示するため、DeepSeek のメインモデル
と MiMo のビジョンモデルを組み合わせることができます。メインプロバイダーを
切り替えても、現在のビジョン選択がまだ到達可能であれば保持されます。

**上流** - 7つのプロバイダーをサポートします：**OpenCode Go**（`OPENCODE_GO_TOKEN`、
無料モデルを含む）、**DeepSeek 公式**（`DEEPSEEK_API_KEY`、ウェブ検索内蔵）、
**xAI（Grok）**（SuperGrok または X Premium アカウントで設定画面からサインイン。
使用量は API 残高ではなくそのサブスクリプションに計上されます）、
**カスタム**（Responses 互換エンドポイント、設定画面で設定）、そして
**Ollama**・**llama.cpp**・**vLLM**（このマシンで既に動いているエンジン。設定では
なくスキャンで見つかります。下の「ローカルモデル」を参照）。すべてのモデル ID はプロバイダーサフィックスを持ちます（例：
`deepseek-v4-flash@deepseek-official`）。ネイティブ GPT モデルは Codex の
モデルピッカーに残ります。ModelDock は OpenAI の認証情報にアクセスしません。

**ローカルモデル** - このマシンで既に動いているエンジンは、設定するものではなく
「見つかる」ものです。ダッシュボードのローカルエンジン欄で **Rescan** を押すと、
待ち受けソケットとその背後のプロセスを読み取るため、既定のポートに限らず起動時に
指定したポートで見つかります。到達可能なエンジンは行右端のラベルが青くなり、
行を押すとそのエンジンのドロワーが開きます。

Ollama は接続すればそれ以上決めることはありません。llama-server にはドロワーの
残りが用意されています。そのコマンドラインこそが、モデルがカードに収まるかどうかを
決めているからです：

- **メモリバー** は重み・KV キャッシュ・固定オーバーヘッド・残量を積み上げます。
  数値はモデルファイル自身のヘッダーから、スキャン時に一度だけ読んでキャッシュ
  されます。ドロワーを開いてもファイルは読まれず、エンジンを止めた後でも数値は
  答えられます — 必要になるのはまさにその時です。ハイブリッドなモデルは一部の層
  だけが増え続けるキャッシュを持つため、全層で数えると KV を数倍に見積もって
  しまいます。読み取り側は実際に費用を払う層だけを数えます。カード容量は
  `AdapterRAM` ではなくドライバーから取得します — 前者は 32 ビットで、4 GB を
  超えるカードはすべて正確に 4 GB と報告されるためです。
- **総コンテキスト** は固定の段の間を動きます。推奨値は 2 GiB の余裕を残し、
  スライダーはさらに 1.2 GiB まで進めます。バーはどの帯域に入ったかを示します。
  カードがそのモデルを収められない場合、確保できないウィンドウを提示せず、
  そう明言します。
- **同時セッション** は、それぞれがウィンドウ全体を見るスロットです。上限はメモリ
  ではなく一つのセッションに必要な作業領域で決まります。約 15K を下回ると、
  1ターンあたりの固定オーバーヘッドを払った後に何も残りません。
- **KV 精度** は 4・8・16 です。このカードで信頼できない段はグレーアウトされ、
  再起動時にも拒否されます — 壊れたキャッシュは遅い答えではなく誤った答えを
  返します。
- **最適化** は 3 つのコントロールをコミュニティ推奨値に設定します。これはレシピ
  であり、あなたのマシンで実行したベンチマークではありません。
- **この設定で再起動** はエンジンを停止し、選んだ設定で起動し直します。新しい
  コマンドラインを組み立てるのではなく、既に動いていたコマンドラインを編集する
  ため、あなたに必要でこちらが思い至らなかったフラグが落ちることはありません。
  ボタンの上に表示される行が、実際に実行される行そのものです。古いプロセスが
  ポートを解放しない場合、何も起動されません。

ドロワー上部の警告は「有効だが何もしていない」設定を名指しします — 状態を
シフトできないモデルへの `--context-shift`、確実に動作しないカードでの KV 量子化、
バックエンドが無視する予測ブロックなど。警告が出ても今壊れているわけではなく、
設定が事実でないことを述べている、という意味です。

**サブエージェント** - ダッシュボードでサブエージェント専用モデルを選択できます。
すべての有効なプロバイダーのモデルと、Codex アカウントのネイティブ GPT モデルが
表示されます。

**音声** - ダッシュボードの TTS / STT タイルで有効にすると、`speak` と
`hear` ツールがモデルから使えます。

**言語** - ダッシュボードは English、简体中文、日本語 に対応。設定 -> インターフェース言語でいつでも変更できます。

**自動起動と更新** - Model Dock はデフォルトでログイン時に隠れて起動します。
設定の Autostart スイッチで変更できます。新バージョンがあると緑の更新
ボタンが現れ、ワンクリックでダウンロード、再起動、リロードします。

### 手動リカバリ

ゲートウェイに接続できない場合は、インストールに同梱されている小さな
リカバリメニューを使ってください。操作は次の2つだけです：

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.modeldock\scripts\recover.ps1"
```

macOS / Linux：

```sh
sh ~/.modeldock/scripts/recover.sh
```

1. **ModelDock ゲートウェイを再起動** - このインストールが所有するゲートウェイ
   だけを停止して再起動し、`/healthz` を待ちます。
2. **Codex ネイティブルートを復元** - まず実行中のゲートウェイにルートの無効化を
   依頼します。ゲートウェイが停止している場合は、最後に検証された `config.toml`
   バックアップから直接復元し、Codex の再起動をマークします。置き換え前に現在の
   設定は `.native-recovery-*.bak` として保存されます。

どちらの設定変更後も、Codex を完全に終了して再起動してください。リカバリメニューは
ModelDock やバックアップを削除しません。

### アンインストール

ModelDock を削除しますが、データは保持します：このインストールが所有する
ゲートウェイだけを停止し、ログイン時の自動起動エントリを削除し、インストール
状態をクリアします（メモリボールトと Codex 設定のバックアップは保持）。
ゲートウェイのログも削除されます。

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.modeldock\scripts\uninstall.ps1"
```

macOS / Linux：

```sh
sh ~/.modeldock/scripts/uninstall.sh
```
