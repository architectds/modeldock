# Model Dock For Codex

Keep everything in Codex - and add DeepSeek. Give DeepSeek eyes, ears, a
voice, a web search, a memory, and the content-to-video skill. ModelDock
focuses on one thing: making DeepSeek work natively inside Codex.

A thin local Responses bridge for OpenCode Go and DeepSeek official, with
native GPT passthrough and live token, latency, and trace observability.

<p align="center">
  English ·
  <a href="#中文">中文</a> ·
  <a href="#日本語">日本語</a> ·
  <a href="#français">Français</a> ·
  <a href="#español">Español</a>
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
DeepSeek official endpoint does). Model Dock For Codex adds these as tools,
without rewriting the conversation history:

- **See** - paste an image into Codex and the request is routed to the vision
  model you chose in Settings, or let the model call `vision_inspect` on a
  screenshot or file.
- **Speak** - the `speak` tool turns text into a local audio file.
- **Hear** - the `hear` tool transcribes an audio file back to text.
- **Search** - the `web_search_exa` tool queries the web through Exa.
- **Remember** - `store_memory` and `recall_memory` give the model a lightweight
  cross-session memory, so decisions and baselines survive between sessions. It
  is on by default; set `MODELDOCK_MEMORY=0` in `~/.modeldock/.env` and restart
  to disable it.
- **Make** - the `content-to-video` skill lets the model produce finished MP4
  videos end-to-end: classify content, storyboard per-shot tech stacks, narrate
  with measured durations, build three.js / HTML or HyperFrames scenes, assemble
  with ffmpeg, and QA every frame. Audio assets (BGM / SFX) are not bundled to
  keep the skill small - download the library from the
  [video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft) repo
  (sparse-checkout `assets/audio`) when a project needs sound.

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
least one provider token in Settings: [OpenCode Go](https://opencode.ai/auth),
DeepSeek official, or a configured custom Responses endpoint.
It also installs the `content-to-video` skill into Codex's skills directory
(`~/.codex/skills/content-to-video`), so the video capability is available as
soon as Codex restarts.

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
used for pasted images and for `vision_inspect` calls. Providers without a
vision-capable model show `None` instead of advertising an unusable route.

**Upstreams** - OpenCode Go and DeepSeek official are both supported. The
owner suffix in the model id (for example `deepseek-v4-flash@deepseek-official`)
selects the upstream; plain ids resolve to OpenCode Go. Native GPT
models stay in the Codex model picker. Codex's own authenticated requests
are passed through unchanged to OpenAI. ModelDock never accesses, stores,
copies, or replays OpenAI credentials.

The setup guide accepts any configured provider token for ON mode. On a
DeepSeek-only install it selects `deepseek-v4-flash@deepseek-official` as the
main model and `None` for vision, and persists that route across restarts.

**Speech** - open the TTS / STT tile on the dashboard and toggle TTS or STT on.
The `speak` and `hear` tools become available to the model.

**MCP tools** - web search, vision, and speech reach Codex as tools that
survive gateway restarts. The connection Codex opens to them goes stale on a
restart and the client never re-establishes it, so a tool that starts failing
with a connection error (`fetch failed`, `ECONNREFUSED`, `unsupported call`)
will not heal on its own. Call the tools directly from the shell instead of
restarting Codex:
`node scripts/mcp-call.mjs search "..."` or
`node scripts/mcp-call.mjs vision <path> <question>`.
On Linux/macOS installs where `node` is not on PATH, use the bundled-runtime
wrapper: `sh scripts/mcp-call.sh search "..."`. The injected base instructions
already tell the model to switch to the shell fallback when an MCP call fails,
so you normally do not have to repeat it.

**Language** - the dashboard speaks English, 简体中文, 日本語, Français,
Español. Change it anytime under Settings -> Interface language.

**Autostart & updates** - Model Dock starts hidden at every login by default;
flip the Autostart toggle in Settings to change that. A green Update button
appears when a new release is ready - one click moves directly to the latest
release, migrates the managed Node runtime when needed, restarts, and reloads.

If the version in the header does not change after an update, the download
succeeded and only the restart did not: the new files are already installed and
just are not running yet. Run `scripts/restart.ps1` (Windows) or
`scripts/restart.sh` (macOS/Linux) once from your install directory. Versions up
to 0.3.6 relaunch using their own code, so this can happen on the first upgrade
away from them; later upgrades restart on their own.

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

在 Codex 里给 DeepSeek 装上眼睛、耳朵、声音、网络搜索和记忆——通过一个
轻量本地 Responses 桥接层连接 OpenCode Go 与 DeepSeek 官方 API，支持原生
GPT 透传，并带实时 token、延迟与调用链路观测。

DeepSeek V4 Flash 又快又便宜，但它看不见、听不到、不会说话，Responses
端点也没有内置搜索——确切地说，它所经过的 OpenCode Go Responses 端点没有
内置搜索（DeepSeek 官方端点有）。Model Dock For Codex 以工具的形式补全这些能力，并附带轻量跨会话记忆，
且不改写对话历史：

- **看图** - 把图片粘贴进 Codex，请求会自动路由到你在设置中选择的视觉模型；
  也可以让模型对截图或文件调用 `vision_inspect`。
- **说话** - `speak` 工具把文本合成本地音频文件。
- **听写** - `hear` 工具把音频文件转写成文本。
- **搜索** - `web_search_exa` 工具通过 Exa 查询网络。
- **记住** - `store_memory` 和 `recall_memory` 给模型一份轻量跨会话记忆，决策和基线在会话之间也能保留。此功能默认开启；如需关闭，在 `~/.modeldock/.env` 中设置 `MODELDOCK_MEMORY=0` 并重启即可。

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
`~/.modeldock`，在后台启动并打开仪表盘。在弹出的设置对话框中粘贴你的
[opencode.ai](https://opencode.ai/auth) token。

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
调用。

**上游** - 同时支持 OpenCode Go 和 DeepSeek 官方。模型 id 中的 owner 后缀
（例如 `deepseek-v4-flash@deepseek-official`）选择上游；不带后缀的 id 走
OpenCode Go。原生 GPT 模型保留在 Codex 的模型选单中。Codex 自身已认证的请
求会原样透传给 OpenAI。ModelDock 从不访问、存储、复制或回放 OpenAI 凭证。

**语音** - 打开仪表盘的 TTS / STT 磁贴并启用 TTS 或 STT，`speak` 和 `hear`
工具即可供模型使用。

**界面语言** - 仪表盘支持 English、简体中文、日本語、Français、Español，
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

DeepSeek に目、耳、声、そしてウェブ検索を - 薄い Responses ブリッジ経由で
OpenCode Go と DeepSeek 公式 API をつなぎます。

DeepSeek V4 Flash は速くて安い一方、画像を見られず、話せず、聞けず、
それが経由する OpenCode Go の Responses エンドポイントには検索機能も
ありません（DeepSeek 公式エンドポイントにはあります）。Model Dock For
Codex はこれら 5 つをツールとして追加し、会話履歴は書き換えません：

- **見る** - 画像を Codex に貼り付けると、リクエストは設定で選択した
  ビジョンモデルにルーティングされます。スクリーンショットや
  ファイルには `vision_inspect` を呼べます。
- **話す** - `speak` ツールがテキストをローカル音声ファイルに変換します。
- **聞く** - `hear` ツールが音声ファイルをテキストに書き起こします。
- **検索** - `web_search_exa` ツールが Exa 経由でウェブ検索します。
- **記憶** - `store_memory` と `recall_memory` で軽量なクロスセッション記憶を
  提供します。デフォルトで有効です；無効にするには `~/.modeldock/.env` で
  `MODELDOCK_MEMORY=0` を設定して再起動してください。

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
を開きます。表示された設定ダイアログに [opencode.ai](https://opencode.ai/auth)
のトークンを貼り付けます。

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
た画像と `vision_inspect` 呼び出しに使われます。

**上流** - OpenCode Go と DeepSeek 公式の両方をサポートします。モデル ID の
owner サフィックス（例 `deepseek-v4-flash@deepseek-official`）で上流を選択。
サフィックスなしは OpenCode Go になります。ネイティブ GPT モデルは Codex の
モデルピッカーに残ります。Codex 自身の認証済みリクエストは変更されずに
OpenAI へ転送されます。ModelDock は OpenAI の認証情報にアクセスせず、保存・
コピー・再生もしません。

**音声** - ダッシュボードの TTS / STT タイルで有効にすると、`speak` と
`hear` ツールがモデルから使えます。

**言語** - ダッシュボードは English、简体中文、日本語、Français、Español
に対応。設定 -> インターフェース言語でいつでも変更できます。

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

---

## Français

Donnez à DeepSeek des yeux, des oreilles, une voix et un accès au web - via un
mince pont Responses vers OpenCode Go et l'API officielle DeepSeek.

DeepSeek V4 Flash est rapide et économique, mais il ne voit pas, ne parle pas,
n'écoute pas, et l'endpoint Responses d'OpenCode Go par lequel il passe n'a pas
de recherche intégrée (l'endpoint officiel DeepSeek en a une). Model Dock For
Codex ajoute ces cinq capacités comme outils, sans réécrire l'historique de
conversation :

- **Voir** - collez une image dans Codex et la requête est routée vers le modèle
  de vision choisi dans les réglages, ou laissez le modèle appeler
  `vision_inspect` sur une capture ou un fichier.
- **Parler** - l'outil `speak` transforme un texte en fichier audio local.
- **Écouter** - l'outil `hear` transcrit un fichier audio en texte.
- **Chercher** - l'outil `web_search_exa` interroge le web via Exa.
- **Se souvenir** - `store_memory` et `recall_memory` offrent au modèle une
  mémoire légère entre sessions. C'est activé par défaut : définissez
  `MODELDOCK_MEMORY=0` dans `~/.modeldock/.env` et redémarrez pour le désactiver.

Le pont relaie le flux Responses sans bufferiser ni resynthétiser le SSE. Ses
seules réécritures sont chirurgicales et documentées : les lignes d'outils
orphelines coupées par une compaction sont supprimées ou ré-appariées, et la
compaction distante est synthétisée pour les modèles routés qui ne parlent pas
le protocole natif. Les boucles d'outils multi-tours, le streaming et la
compaction fonctionnent comme sur le canal natif.

### Installation

Windows :

```
$installer = Join-Path $env:TEMP "modeldock-install.ps1"
Invoke-WebRequest -UseBasicParsing "https://github.com/architectds/modeldock/releases/latest/download/install.ps1" -OutFile $installer
powershell -NoProfile -ExecutionPolicy Bypass -File $installer
```

macOS :

```
curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
```

L'installeur vérifie Node.js >= 24, télécharge Model Dock For Codex dans
`~/.modeldock`, le démarre en arrière-plan et ouvre le tableau de bord. Collez
votre jeton [opencode.ai](https://opencode.ai/auth) dans la boîte de dialogue.

### Connecter Codex

1. L'installeur a déjà ouvert **http://127.0.0.1:4097** (au premier lancement,
   la boîte de dialogue des réglages s'affiche pour coller votre jeton). Sinon,
   ouvrez cette adresse dans votre navigateur.
2. Activez l'interrupteur « Utiliser d'autres API dans Codex » sur la page.
3. Quittez et redémarrez complètement Codex, puis confirmez sur la bannière
   « J'ai redémarré Codex ».
4. Choisissez un modèle Model Dock dans le sélecteur de Codex (le modèle par
   défaut est déjà sélectionné ; les modèles GPT natifs sont aussi listés).

### Usage quotidien

**Sélecteur de modèle** - changez le modèle principal dans le sélecteur de Codex
(en bas à droite). Model Dock affiche le fournisseur et le modèle actifs en
lecture seule sur le tableau de bord.

**Modèle de vision** - choisissez le modèle de vision sur le tableau de bord. Il
est utilisé pour les images collées et les appels `vision_inspect`.

**Amonts** - OpenCode Go et DeepSeek officiel sont pris en charge. Le suffixe
owner dans l'id du modèle (par exemple
`deepseek-v4-flash@deepseek-official`) sélectionne l'amont ; les ids simples
passent par OpenCode Go. Les modèles GPT natifs restent dans le sélecteur de
modèles de Codex. Les requêtes authentifiées de Codex sont transmises telles
quelles à OpenAI. ModelDock n'accède jamais aux identifiants OpenAI, ne les
stocke pas, ne les copie pas et ne les rejoue pas.

**Parole** - ouvrez la tuile TTS / STT sur le tableau de bord et activez TTS ou
STT. Les outils `speak` et `hear` deviennent disponibles.

**Langue** - le tableau de bord parle English, 简体中文, 日本語, Français,
Español. Changez-la dans Réglages -> Langue de l'interface.

**Démarrage auto & mises à jour** - Model Dock démarre en caché à chaque
connexion par défaut ; le commutateur Autostart se trouve dans Réglages.
Un bouton vert apparaît quand une nouvelle version est prête - un clic
télécharge, redémarre et recharge.

### Récupération manuelle

Si la passerelle est injoignable, utilisez le petit menu de récupération fourni
avec l'installation. Il propose exactement deux actions :

Windows :

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.modeldock\scripts\recover.ps1"
```

macOS ou Linux :

```sh
sh ~/.modeldock/scripts/recover.sh
```

1. **Redémarrer la passerelle ModelDock** arrête uniquement la passerelle
   appartenant à cette installation, la redémarre et attend `/healthz`.
2. **Restaurer la route native Codex** demande d'abord à la passerelle
   d'arrêter sa route. Si la passerelle est arrêtée, il restaure directement la
   dernière sauvegarde vérifiée de `config.toml` et marque Codex pour
   redémarrage. La configuration actuelle est enregistrée sous
   `.native-recovery-*.bak` avant le remplacement.

Après toute modification de configuration, quittez complètement Codex et
redémarrez-le. Le menu de récupération ne supprime ni ModelDock ni les
sauvegardes.

### Désinstallation

Supprime ModelDock en conservant vos données : arrête uniquement la passerelle
appartenant à cette installation, retire l'entrée de démarrage automatique,
efface l'état d'installation (la mémoire et les sauvegardes de configuration
Codex sont conservées) et supprime le journal de la passerelle.

Windows :

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.modeldock\scripts\uninstall.ps1"
```

macOS ou Linux :

```sh
sh ~/.modeldock/scripts/uninstall.sh
```

---

## Español

Dale a DeepSeek ojos, oídos, voz y acceso a la web - mediante un puente fino de
Responses hacia OpenCode Go y la API oficial de DeepSeek.

DeepSeek V4 Flash es rápido y barato, pero no ve, no habla, no escucha y el
endpoint Responses de OpenCode Go por el que pasa no tiene búsqueda integrada
(el endpoint oficial de DeepSeek sí la tiene). Model Dock For Codex añade estas
cinco capacidades como herramientas, sin reescribir el historial de la
conversación:

- **Ver** - pega una imagen en Codex y la solicitud se enruta al modelo de
  visión que elegiste en Ajustes, o deja que el modelo llame a
  `vision_inspect` sobre una captura o archivo.
- **Hablar** - la herramienta `speak` convierte texto en un archivo de audio
  local.
- **Escuchar** - la herramienta `hear` transcribe un archivo de audio a texto.
- **Buscar** - la herramienta `web_search_exa` consulta la web mediante Exa.
- **Recordar** - `store_memory` y `recall_memory` dan al modelo una memoria
  ligera entre sesiones. Está activada por defecto: define `MODELDOCK_MEMORY=0` en
  `~/.modeldock/.env` y reinicia para desactivarla.

El puente retransmite el flujo Responses sin almacenar ni resintetizar SSE. Sus
únicas reescrituras son quirúrgicas y documentadas: las filas de herramientas
huérfanas que una compactación puede separar se eliminan o se vuelven a
emparejar, y la compactación remota se sintetiza para los modelos enrutados que
no hablan el protocolo nativo. Los bucles de herramientas multi-turno, el
streaming y la compactación funcionan como en el canal nativo.

### Instalación

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

El instalador verifica Node.js >= 24, descarga Model Dock For Codex en
`~/.modeldock`, lo inicia en segundo plano y abre el panel. Pega tu token de
[opencode.ai](https://opencode.ai/auth) en el diálogo de configuración.

### Conectar Codex

1. El instalador ya abrió **http://127.0.0.1:4097** (en el primer arranque
   aparece el diálogo de Ajustes para pegar tu token). Si no, ábrelo en tu
   navegador.
2. Activa el interruptor «Usar otras API en Codex» de la página.
3. Cierra y reinicia Codex por completo y confirma en el aviso
   «He reiniciado Codex».
4. Elige un modelo Model Dock en el selector de Codex (el modelo predeterminado
   ya está seleccionado; los modelos GPT nativos también aparecen).

### Uso diario

**Selector de modelo** - cambia el modelo principal en el selector de Codex
(abajo a la derecha). Model Dock muestra el proveedor y el modelo activos en
solo lectura en el panel.

**Modelo de visión** - elige el modelo de visión en el panel. Se usa para
imágenes pegadas y llamadas `vision_inspect`.

**Upstreams** - se admiten OpenCode Go y DeepSeek oficial. El sufijo owner en el
id del modelo (por ejemplo `deepseek-v4-flash@deepseek-official`) selecciona el
upstream; los ids simples usan OpenCode Go. Los modelos GPT nativos permanecen
en el selector de modelos de Codex. Las solicitudes autenticadas de Codex se
reenvían sin cambios a OpenAI. ModelDock nunca accede, almacena, copia ni
reproduce las credenciales de OpenAI.

**Voz** - abre la tarjeta TTS / STT en el panel y activa TTS o STT. Las
herramientas `speak` y `hear` quedan disponibles.

**Idioma** - el panel habla English, 简体中文, 日本語, Français, Español.
Cámbialo en Ajustes -> Idioma de la interfaz.

**Autostart y actualizaciones** - Model Dock se inicia oculto en cada inicio de
sesión por defecto; el interruptor Autostart está en Ajustes. Aparece un botón
verde cuando hay una nueva versión - un clic descarga, reinicia y recarga.

### Recuperación manual

Si la puerta de enlace no es accesible, usa el pequeño menú de recuperación
incluido en la instalación. Tiene exactamente dos acciones:

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.modeldock\scripts\recover.ps1"
```

macOS o Linux:

```sh
sh ~/.modeldock/scripts/recover.sh
```

1. **Reiniciar la puerta de enlace de ModelDock** detiene solo la puerta de
   enlace de esta instalación, la reinicia y espera a `/healthz`.
2. **Restaurar la ruta nativa de Codex** primero pide a la puerta de enlace
   que desactive su ruta. Si está detenida, restaura directamente la última
   copia de seguridad verificada de `config.toml` y marca Codex para reinicio.
   La configuración actual se guarda como `.native-recovery-*.bak` antes del
   reemplazo.

Tras cualquier cambio de configuración, sal por completo de Codex y reinícialo.
El menú de recuperación no elimina ModelDock ni las copias de seguridad.

### Desinstalación

Elimina ModelDock conservando tus datos: detiene solo la puerta de enlace que
pertenece a esta instalación, quita la entrada de inicio automático, limpia el
estado de instalación (se conservan la memoria y las copias de seguridad de la
configuración de Codex) y elimina el registro de la puerta de enlace.

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.modeldock\scripts\uninstall.ps1"
```

macOS o Linux:

```sh
sh ~/.modeldock/scripts/uninstall.sh
```
