# Model Dock For Codex

> **ModelDock makes the AI tools you already own work together.**

Keep working in Codex. Use DeepSeek, Qwen, and the models you choose alongside
web search, image understanding, voice, memory, and video - without manually
moving prompts, files, or results between apps.

**Work in one place. Get things done everywhere.**

A thin local Responses bridge for OpenCode Go, DeepSeek, and local
engines - Ollama, llama.cpp, and vLLM are detected on loopback, and any other
OpenAI-compatible endpoint can be added by URL - with native GPT passthrough
and live token, latency, and trace observability.

ModelDock currently connects models and capabilities inside a Codex task. The
next step is Connectors: user-authorized local tools that run through their own
official CLIs, work in an isolated job, and return a result and reviewable diff
to the task. Connectors are planned; they are not part of the current release.

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
DeepSeek endpoint does). A Qwen or any other model you host yourself
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
DeepSeek, a custom Responses endpoint, or connect Ollama for local
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

**Add models** - open Settings and add the service or local engine you use.
ModelDock supports OpenCode Go, DeepSeek, Grok, custom Responses endpoints, and
local Ollama, llama.cpp, or vLLM. Pick the model in Codex; the dashboard shows
what is connected.

**Local models** - press **Rescan** to find an engine already running on your
machine. The drawer shows whether the model fits, recommends practical settings,
and can restart llama.cpp with the settings you choose.

**Tools** - web search, image understanding, image generation, memory, speech,
and video are available to the model when configured. For voice, turn TTS or
STT on in the dashboard. Choose a dedicated sub-agent model there when you want
one.

**Updates** - ModelDock starts at login by default and shows an **Update**
button when a new release is ready. Change autostart or interface language in
Settings.

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

## License

Apache-2.0. See [LICENSE](LICENSE).

## 中文

> **ModelDock 让你已经拥有的 AI 工具协同工作。**

继续在 Codex 里工作，把 DeepSeek、Qwen 和你选定的模型，与网络搜索、图像理解、语音、
记忆、视频搭配使用——无需在应用之间手动搬运 prompt、文件或结果。

**在一个地方工作，把事情办完。**

一个轻量本地 Responses 桥：连接 OpenCode Go、DeepSeek 官方 API 和本地引擎（自动探测
环回地址上的 Ollama、llama.cpp、vLLM，其它 OpenAI 兼容端点也可按 URL 添加），支持原生
GPT 透传，并带实时的 token、延迟与调用链路观测。

目前 ModelDock 在 Codex 任务内部连接模型与能力。下一步是 Connectors：用户授权的本地
工具，通过各自的官方 CLI 运行、在隔离的作业中执行，并把结果和可审查的 diff 返回任务。
Connectors 在规划中，不属于当前版本。

### 为什么选择 Model Dock For Codex

DeepSeek V4 Flash 又快又便宜，但看不见、说不了话、听不到声音，而且它所经过的 OpenCode
Go Responses 端点没有托管搜索（DeepSeek 官方端点有）。你自己托管的 Qwen 或其它模型
也有同样的短板。Model Dock For Codex 以工具的形式补全这些能力，而不改写对话历史：

- **看图** - 把图片粘贴进 Codex，请求会路由到你在设置中选择的视觉模型；也可以让模型
  对截图或文件调用 `vision_inspect`。
- **说话** - `speak` 工具把文本转成本地音频文件。
- **听写** - `hear` 工具把音频文件转写成文本。
- **搜索** - `web_search_exa` 工具通过 Exa 查询网络。
- **记住** - `store_memory`、`recall_memory` 和 `learn` 给模型轻量跨会话记忆：存储决策、
  之后检索，或批量导入笔记和文档。默认开启；在 `~/.modeldock/.env` 设置
  `MODELDOCK_MEMORY=0` 并重启即可关闭。
- **生成** - `image_gen` 工具通过 Codex 的 ChatGPT 后端创建 AI 图像（需要 Codex 已登录
  ChatGPT 账号）。
- **制作** - `content-to-video` 技能从一段 prompt 制作成品 MP4 视频——分镜、用 three.js /
  HTML 或 HyperFrames 搭建场景、ffmpeg 合成、逐帧质检。音频素材不随包提供；项目需要
  声音时，从 [video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft) 仓库
  下载。
- **本地运行** — Ollama 和自定义 Responses 端点把本地模型接入 Codex。检测到本地模型后，
  Codex 的用量会自动优化以适配其规格——CPU 压缩模式在检测到本地模型时立即启用。

桥是轻量本地网关：Responses 流原样透传，多轮工具循环、流式输出和长会话压缩都与原生
通道一致。

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

安装程序会检查 Node.js >= 24，下载到 `~/.modeldock`，在后台启动并打开仪表盘。在设置中
至少添加一个 provider：[OpenCode Go](https://opencode.ai/auth)、DeepSeek 官方、自定义
Responses 端点，或连接 Ollama 使用本地模型。`content-to-video` 技能不会随安装器下载；
需要视频能力时，把 `skills/content-to-video` 手动复制到 Codex 的 skills 目录。

### 接入 Codex

1. 安装程序已打开 **http://127.0.0.1:4097**（首次运行会弹出设置对话框填写 token）；没有
   则请在浏览器中打开。
2. 打开页面上的「在 Codex 中使用其他 API」开关。
3. 完全退出并重启 Codex，然后确认「我已重启 Codex」横幅。
4. 在 Codex 的模型选择器里选一个 Model Dock 模型（默认已选中；原生 GPT 模型也会列出）。

### 日常使用

**模型选择** - 在 Codex 自带的模型选择器（右下角）切换主模型。仪表盘只读显示当前 provider
和模型，不会改动你的 Codex 模型。

**视觉模型** - 在仪表盘选择视觉模型，用于粘贴的图片和 `vision_inspect` 调用。选择器列出
所有已启用 provider 中支持视觉的模型，例如 DeepSeek 主模型搭配 MiMo 视觉模型。切换主
provider 时，只要当前视觉选择仍可达就会保留。没有视觉模型的 provider 显示 `None`。

**添加模型** - 打开设置添加你要用的服务或本地引擎。ModelDock 支持 OpenCode Go、DeepSeek、
Grok、自定义 Responses 端点，以及本地的 Ollama、llama.cpp 或 vLLM。在 Codex 里选模型；
仪表盘显示连接状态。

**本地模型** - 按 **Rescan** 查找本机已在运行的引擎。抽屉会显示模型是否装得下、推荐实用
参数，并可用你选的参数重启 llama.cpp。

**工具** - 配置后，模型即可使用网络搜索、图像理解、图像生成、记忆、语音和视频。语音需
在仪表盘打开 TTS 或 STT；需要时可在那里为子代理选一个专用模型。

**更新** - ModelDock 默认开机自启，有新版本时显示 **Update** 按钮。自启和界面语言在设置中
修改。

---

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

1. **重启 ModelDock 网关** - 只停止本安装拥有的网关，重新启动并等待 `/healthz`。
2. **恢复 Codex 原生路线** - 先请运行中的网关关闭其路线；网关已停止时，直接从最后验证的
   `config.toml` 备份还原，并标记 Codex 需要重启。替换前把当前配置保存为
   `.native-recovery-*.bak`。

任一路线变更后，请完全退出并重启 Codex。恢复菜单不会删除 ModelDock 或备份。

### 卸载

卸载保留数据：只停止本安装拥有的网关、移除登录自启项、清理安装状态（记忆库和 Codex
配置备份保留），并删除网关日志。

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.modeldock\scripts\uninstall.ps1"
```

macOS 或 Linux：

```sh
sh ~/.modeldock/scripts/uninstall.sh
```

### 免责声明

Model Dock For Codex 是独立、社区维护的项目，与 OpenAI、DeepSeek 或 opencode.ai 无隶属、
背书或赞助关系，也不是它们的官方产品。本仓库中出现的 "Codex"、"OpenAI"、"DeepSeek"、
"OpenCode" 等名称或标记归各自所有者所有，仅用于描述互操作性。

本软件按「原样」提供，不作任何明示或暗示的担保。作者在任何情况下均不对因使用本软件而
产生的任何索赔、损害或其它责任负责。本仓库中的任何内容均不构成法律、财务或专业建议。

---

## 日本語

> **ModelDock は、あなたがすでに所有している AI ツールを連携させます。**

Codex で作業を続けながら、DeepSeek・Qwen・選んだモデルを、ウェブ検索・画像理解・音声・
記憶・動画と一緒に使えます。プロンプト、ファイル、結果をアプリ間で手動で移動する
必要はありません。

**一つの場所で作業し、どこでも完了させる。**

OpenCode Go・DeepSeek 公式 API・ローカルエンジン（ループバック上の Ollama・llama.cpp・
vLLM を自動検出。その他の OpenAI 互換エンドポイントも URL で追加可能）をつなぐ薄い
ローカル Responses ブリッジ。ネイティブ GPT パススルーと、リアルタイムのトークン・
レイテンシー・トレース可観測性を備えています。

現在 ModelDock は Codex タスク内でモデルと機能を接続します。次のステップは Connectors
です。ユーザーが承認したローカルツールが、それぞれの公式 CLI を通じて隔離されたジョブで
実行され、結果とレビュー可能な diff をタスクに返します。Connectors は計画中であり、
現在のリリースには含まれません。

### Model Dock For Codex を選ぶ理由

DeepSeek V4 Flash は速くて安い一方、画像を見られず、話せず、聞けません。また、それが
経由する OpenCode Go の Responses エンドポイントにはホスト型検索がありません（DeepSeek
公式エンドポイントにはあります）。自分でホストする Qwen や他のモデルにも同じギャップ
があります。Model Dock For Codex はこれらをツールとして追加し、会話履歴は書き換えません：

- **見る** - 画像を Codex に貼り付けると、設定で選んだビジョンモデルにルーティング
  されます。スクリーンショットやファイルには `vision_inspect` を呼べます。
- **話す** - `speak` ツールがテキストをローカル音声ファイルに変換します。
- **聞く** - `hear` ツールが音声ファイルをテキストに書き起こします。
- **検索** - `web_search_exa` ツールが Exa 経由でウェブを検索します。
- **記憶** - `store_memory`・`recall_memory`・`learn` で軽量なクロスセッション記憶を
  提供します。決定を保存して後から呼び出したり、メモやドキュメントを一括取り込めます。
  デフォルトで有効です。無効にするには `~/.modeldock/.env` で `MODELDOCK_MEMORY=0` を
  設定して再起動します。
- **生成** - `image_gen` ツールが Codex の ChatGPT バックエンド経由で AI 画像を生成します
  （ChatGPT にサインインした Codex アカウントが必要です）。
- **制作** - `content-to-video` スキルがプロンプトから完成した MP4 動画を制作します。
  ストーリーボード、three.js / HTML / HyperFrames でのシーン構築、ffmpeg での組み立て、
  全フレームの QA。音声アセットは同梱されません。サウンドが必要なプロジェクトでは
  [video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft) リポジトリから
  ダウンロードしてください。
- **ローカル実行** — Ollama とカスタム Responses エンドポイントで自分のモデルを Codex に
  接続できます。ローカルモデルが検出されると、Codex の使用量はローカルモデルの仕様に
  合わせて自動的に最適化されます — CPU 圧縮モードはローカルモデル検出と同時に有効に
  なります。

ブリッジは薄いローカルゲートウェイです。Responses ストリームはそのまま透過し、マルチ
ターンのツールループ・ストリーミング・長いセッションの圧縮はネイティブチャネルと同様に
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

インストーラーは Node.js >= 24 を確認し、`~/.modeldock` にダウンロードしてバックグラウンド
で起動し、ダッシュボードを開きます。設定で少なくとも 1 つのプロバイダーを追加して
ください：[OpenCode Go](https://opencode.ai/auth)、DeepSeek 公式、カスタム Responses
エンドポイント、または Ollama（ローカルモデル）。`content-to-video` スキルはインストーラー
ではダウンロードされません。動画機能が必要な場合は、`skills/content-to-video` を Codex の
スキルディレクトリに手動でコピーしてください。

### Codex への接続

1. インストーラーが **http://127.0.0.1:4097** を開きます（初回はトークンを入力する設定
   ダイアログが出ます）。開かない場合はブラウザで開いてください。
2. ページの「Codex で他の API を使う」スイッチをオンにします。
3. Codex を完全に終了して再起動し、「Codex を再起動しました」バナーで確認します。
4. Codex のモデル選択で Model Dock モデルを選びます（既定モデルは選択済み。ネイティブ
   GPT モデルも表示されます）。

### 日常使い

**モデル選択** - メインモデルは Codex 側のモデル選択（右下）で切り替えます。ダッシュボード
は現在のプロバイダーとモデルを読み取り専用で表示し、Codex のモデルは変更しません。

**ビジョンモデル** - ダッシュボードでビジョンモデルを選択します。貼り付けた画像と
`vision_inspect` 呼び出しに使われます。ピッカーには有効なプロバイダーのビジョン対応モデル
がすべて並ぶため、DeepSeek メインモデルと MiMo ビジョンモデルの組み合わせなどが可能です。
メインプロバイダーを切り替えても、現在のビジョン選択がまだ到達可能なら保持されます。
ビジョン対応モデルのないプロバイダーは `None` と表示されます。

**モデルを追加** - 設定を開き、使うサービスやローカルエンジンを追加します。ModelDock は
OpenCode Go・DeepSeek・Grok・カスタム Responses エンドポイント、およびローカルの Ollama・
llama.cpp・vLLM に対応しています。Codex でモデルを選択し、ダッシュボードで接続状況を
確認します。

**ローカルモデル** - **Rescan** を押すと、マシン上で既に動いているエンジンが見つかります。
ドロワーはモデルが収まるかどうかを示し、実用的な設定を推奨し、選んだ設定で llama.cpp を
再起動できます。

**ツール** - 設定済みの場合、ウェブ検索・画像理解・画像生成・記憶・音声・動画がモデルから
利用できます。音声はダッシュボードで TTS または STT をオンにします。必要に応じて、そこから
サブエージェント専用モデルも選択できます。

**アップデート** - ModelDock はデフォルトでログイン時に起動し、新しいリリースがあると
**Update** ボタンを表示します。自動起動とインターフェース言語は設定で変更できます。

---

### 手動リカバリ

ゲートウェイに接続できない場合は、インストールに同梱の小さなリカバリメニューを使って
ください。操作は次の 2 つだけです：

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.modeldock\scripts\recover.ps1"
```

macOS / Linux：

```sh
sh ~/.modeldock/scripts/recover.sh
```

1. **ModelDock ゲートウェイを再起動** - このインストールが所有するゲートウェイだけを停止
   して再起動し、`/healthz` を待ちます。
2. **Codex ネイティブルートを復元** - まず実行中のゲートウェイにルートの無効化を依頼します。
   ゲートウェイが停止している場合は、最後に検証された `config.toml` バックアップから直接
   復元し、Codex の再起動をマークします。置き換え前に現在の設定は `.native-recovery-*.bak`
   として保存されます。

どちらの設定変更後も、Codex を完全に終了して再起動してください。リカバリメニューは
ModelDock やバックアップを削除しません。

### アンインストール

データを保持したまま ModelDock を削除します：このインストールが所有するゲートウェイだけを
停止し、ログイン時の自動起動エントリを削除し、インストール状態をクリアします（メモリ
ボールトと Codex 設定のバックアップは保持）。ゲートウェイのログも削除されます。

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.modeldock\scripts\uninstall.ps1"
```

macOS / Linux：

```sh
sh ~/.modeldock/scripts/uninstall.sh
```

### 免責事項

Model Dock For Codex は独立したコミュニティ保守プロジェクトです。OpenAI・DeepSeek・
opencode.ai との提携、承認、スポンサー関係はなく、いずれの公式製品でもありません。本
リポジトリで参照される "Codex"・"OpenAI"・"DeepSeek"・"OpenCode" などの名前や商標は
それぞれの所有者に帰属し、相互運用性の説明のみを目的として使用されています。

本ソフトウェアは「現状のまま」提供され、明示または黙示を問わずいかなる保証もありません。
著者は本ソフトウェアまたはその使用から生じるいかなる請求、損害、その他の責任についても
責任を負いません。本リポジトリの内容は法的、財務的、または専門的な助言を構成するものでは
ありません。
