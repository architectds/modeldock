// First-run setup wizard for the ModelDock dashboard.
//
// Self-contained on purpose: it owns its overlay DOM, injects its own styles and
// carries its own zh/en dictionary keyed off navigator.language, so it does not
// import app.js/i18n.js and never collides with the dashboard's own modules.
// The flow is the four-user decision table:
//   GPT subscription?  x  OpenCode/third-party account (none / free / paid)
//   -> recommended OFF / ON (+ nativeMerge persistence for subscribers).
// Everything it writes goes through the same APIs the dashboard uses:
//   GET  /api/onboarding          (prefill + first-run flag)
//   POST /api/config/mode         (apply mode + nativeMerge)
//   POST /api/onboarding/complete (persist the "done" marker)
(() => {
  "use strict";

  const OPENCODE_SIGNUP = "https://opencode.ai/go?ref=P2133HRY5J";
  const OPENCODE_LINK = "https://opencode.ai/go";

  // Translation resources are the one place non-ASCII text is expected (mirrors
  // i18n.js). Every other string in this file is ASCII.
  const I18N = {
    en: {
      "wizard.eyebrow": "FIRST-RUN SETUP",
      "wizard.title": "Welcome to Model Dock",
      "wizard.body": "Answer two short questions and ModelDock will configure the right mode for your accounts.",
      "wizard.currentMode": "Current mode",
      "wizard.factGo": "OpenCode Go",
      "wizard.factDs": "DeepSeek key",
      "wizard.factAutostart": "Start at login",
      "wizard.configured": "Configured",
      "wizard.missing": "Missing",
      "wizard.autostartOn": "On",
      "wizard.autostartOff": "Off",
      "wizard.autostartUnsupported": "Unsupported",
      "wizard.modeOff": "Off",
      "wizard.modeOn": "On",
      "wizard.start": "Get started",
      "wizard.skip": "Skip for now",
      "wizard.step1": "STEP 1 OF 3",
      "wizard.q1": "Do you have a ChatGPT (Codex) subscription?",
      "wizard.q1Yes": "Yes",
      "wizard.q1YesSub": "Keep native GPT models in the picker.",
      "wizard.q1No": "No",
      "wizard.q1NoSub": "Hide paid GPT models you cannot use.",
      "wizard.step2": "STEP 2 OF 3",
      "wizard.q2": "What about OpenCode, DeepSeek, or another third-party API?",
      "wizard.q2None": "No account",
      "wizard.q2NoneSub": "Use only what you already have - we will point you to free options.",
      "wizard.q2Free": "Free account",
      "wizard.q2FreeSub": "OpenCode free tier: DeepSeek V4 Flash Free + MiMo V2.5 Free, no card needed.",
      "wizard.q2Paid": "Paid plan",
      "wizard.q2PaidSub": "OpenCode Go or another paid third-party key unlocks the full catalog.",
      "wizard.step3": "STEP 3 OF 3",
      "wizard.back": "Back",
      "wizard.apply": "Apply and restart Codex",
      "wizard.applyBusy": "Applying...",
      "wizard.done": "Done",
      "wizard.closeAria": "Close setup guide",
      "wizard.settingsEntry": "Run setup guide again",
      "wizard.errorTitle": "Something went wrong",
      "reco.onMode": "Mode: ON",
      "reco.offMode": "Mode: OFF (unchanged)",
      "reco.catalogProvider": "Full catalog for the configured provider",
      "reco.nativeOn": "Native GPT models stay in the picker",
      "reco.nativeOff": "Native GPT models hidden (no subscription)",
      "reco.nativeKeep": "Codex keeps using your ChatGPT setup",
      "reco.dsAlt": "Tip: add a DeepSeek key in Settings to use DeepSeek models later",
      "reco.register": "Register OpenCode Go to unlock the free tier",
      "reco.rerun": "Then re-run this guide from Settings",
      "reco.providerGpt": "Configured API with native GPT models",
      "reco.providerNoGpt": "Configured API only (GPT models hidden)",
      "reco.offGpt": "Keep your ChatGPT setup (OFF)",
      "reco.guide": "No third-party account yet",
      "warn.noProviderToken": "No provider token detected.",
      "warn.noProviderTokenHint": "Add an OpenCode Go, DeepSeek, or custom provider key in Settings, then apply.",
      "warn.register": "Register OpenCode Go",
      "warn.openSettings": "Open Settings",
      "warn.applyDisabled": "Apply unlocks after a token is configured.",
      "done.applied": "Setup applied",
      "done.appliedBody": "ModelDock rewrote your Codex config. Fully restart Codex - quit completely, then reopen - before starting a new task.",
      "done.appliedNoRestart": "Setup applied",
      "done.appliedNoRestartBody": "Your Codex is already on the recommended setup. No restart needed.",
      "done.noChange": "No changes were needed",
      "done.noChangeBody": "Your Codex stays on its current setup.",
      "done.guideBody": "Register OpenCode Go to unlock the free tier, then re-run this guide from Settings.",
    },
    zh: {
      "wizard.eyebrow": "首次运行设置",
      "wizard.title": "欢迎使用 Model Dock",
      "wizard.body": "回答两个小问题，ModelDock 就会为你的账号配置合适的模式。",
      "wizard.currentMode": "当前模式",
      "wizard.factGo": "OpenCode Go",
      "wizard.factDs": "DeepSeek 密钥",
      "wizard.factAutostart": "开机自启",
      "wizard.configured": "已配置",
      "wizard.missing": "未配置",
      "wizard.autostartOn": "开启",
      "wizard.autostartOff": "关闭",
      "wizard.autostartUnsupported": "不支持",
      "wizard.modeOff": "关闭",
      "wizard.modeOn": "开启",
      "wizard.start": "开始设置",
      "wizard.skip": "暂时跳过",
      "wizard.step1": "第 1 步，共 3 步",
      "wizard.q1": "你有 ChatGPT（Codex）订阅吗？",
      "wizard.q1Yes": "是",
      "wizard.q1YesSub": "选择器中保留原生 GPT 模型。",
      "wizard.q1No": "否",
      "wizard.q1NoSub": "隐藏你无法使用的付费 GPT 模型。",
      "wizard.step2": "第 2 步，共 3 步",
      "wizard.q2": "OpenCode、DeepSeek 或其它第三方 API 呢？",
      "wizard.q2None": "没有账号",
      "wizard.q2NoneSub": "只用现有账号即可，我们会引导你使用免费选项。",
      "wizard.q2Free": "免费账号",
      "wizard.q2FreeSub": "OpenCode 免费档：DeepSeek V4 Flash Free + MiMo V2.5 Free，无需绑卡。",
      "wizard.q2Paid": "付费计划",
      "wizard.q2PaidSub": "OpenCode Go 或其它付费第三方密钥可解锁全量模型目录。",
      "wizard.step3": "第 3 步，共 3 步",
      "wizard.back": "返回",
      "wizard.apply": "应用并重启 Codex",
      "wizard.applyBusy": "正在应用...",
      "wizard.done": "完成",
      "wizard.closeAria": "关闭设置引导",
      "wizard.settingsEntry": "重新运行设置引导",
      "wizard.errorTitle": "出错了",
      "reco.onMode": "模式：开启",
      "reco.offMode": "模式：关闭（保持原样）",
      "reco.catalogProvider": "已配置提供商的全量模型目录",
      "reco.nativeOn": "选择器中保留原生 GPT 模型",
      "reco.nativeOff": "隐藏原生 GPT 模型（无订阅）",
      "reco.nativeKeep": "Codex 继续使用你的 ChatGPT 原生配置",
      "reco.dsAlt": "提示：之后可在设置中添加 DeepSeek 密钥使用 DeepSeek 模型",
      "reco.register": "注册 OpenCode Go 以解锁免费档",
      "reco.rerun": "之后从设置中重新运行本引导",
      "reco.providerGpt": "已配置 API + 原生 GPT 模型",
      "reco.providerNoGpt": "仅已配置 API（隐藏 GPT 模型）",
      "reco.offGpt": "保持 ChatGPT 原生配置（关闭）",
      "reco.guide": "还没有第三方账号",
      "warn.noProviderToken": "未检测到提供商令牌。",
      "warn.noProviderTokenHint": "请在设置中添加 OpenCode Go、DeepSeek 或自定义提供商密钥，然后应用。",
      "warn.register": "注册 OpenCode Go",
      "warn.openSettings": "打开设置",
      "warn.applyDisabled": "配置令牌后即可应用。",
      "done.applied": "设置已应用",
      "done.appliedBody": "ModelDock 已改写你的 Codex 配置。开始新任务前，请彻底重启 Codex（完全退出后重新打开）。",
      "done.appliedNoRestart": "设置已应用",
      "done.appliedNoRestartBody": "你的 Codex 已是推荐配置，无需重启。",
      "done.noChange": "无需更改",
      "done.noChangeBody": "Codex 保持当前配置不变。",
      "done.guideBody": "注册 OpenCode Go 解锁免费档后，从设置中重新运行本引导。",
    },
    ja: {
      "wizard.eyebrow": "初回セットアップ",
      "wizard.title": "Model Dock へようこそ",
      "wizard.body": "簡単な質問に答えると、ModelDock があなたのアカウントに合ったモードを設定します。",
      "wizard.currentMode": "現在のモード",
      "wizard.factGo": "OpenCode Go",
      "wizard.factDs": "DeepSeek キー",
      "wizard.factAutostart": "ログイン時に起動",
      "wizard.configured": "設定済み",
      "wizard.missing": "未設定",
      "wizard.autostartOn": "オン",
      "wizard.autostartOff": "オフ",
      "wizard.autostartUnsupported": "非対応",
      "wizard.modeOff": "オフ",
      "wizard.modeOn": "オン",
      "wizard.start": "はじめる",
      "wizard.skip": "あとで",
      "wizard.step1": "ステップ 1/3",
      "wizard.q1": "ChatGPT（Codex）のサブスクリプションをお持ちですか？",
      "wizard.q1Yes": "はい",
      "wizard.q1YesSub": "ネイティブ GPT モデルを選択肢に残します。",
      "wizard.q1No": "いいえ",
      "wizard.q1NoSub": "使えない有料 GPT モデルを非表示にします。",
      "wizard.step2": "ステップ 2/3",
      "wizard.q2": "OpenCode、DeepSeek、その他のサードパーティ API はどうしますか？",
      "wizard.q2None": "アカウントなし",
      "wizard.q2NoneSub": "既存のアカウントのみ使用します。無料オプションをご案内します。",
      "wizard.q2Free": "無料アカウント",
      "wizard.q2FreeSub": "OpenCode 無料枠：DeepSeek V4 Flash Free + MiMo V2.5 Free、カード不要。",
      "wizard.q2Paid": "有料プラン",
      "wizard.q2PaidSub": "OpenCode Go や他の有料サードパーティキーで全カタログが使えます。",
      "wizard.step3": "ステップ 3/3",
      "wizard.back": "戻る",
      "wizard.apply": "適用して Codex を再起動",
      "wizard.applyBusy": "適用中...",
      "wizard.done": "完了",
      "wizard.closeAria": "セットアップガイドを閉じる",
      "wizard.settingsEntry": "セットアップガイドを再実行",
      "wizard.errorTitle": "問題が発生しました",
      "reco.onMode": "モード：オン",
      "reco.offMode": "モード：オフ（変更なし）",
      "reco.catalogProvider": "設定済みプロバイダーの全カタログ",
      "reco.nativeOn": "ネイティブ GPT モデルを選択肢に保持",
      "reco.nativeOff": "ネイティブ GPT モデルを非表示（サブスクなし）",
      "reco.nativeKeep": "Codex は ChatGPT の設定を引き続き使用",
      "reco.dsAlt": "ヒント：後で設定で DeepSeek キーを追加すると DeepSeek モデルを使えます",
      "reco.register": "OpenCode Go に登録して無料枠を解放",
      "reco.rerun": "その後、設定からこのガイドを再実行",
      "reco.providerGpt": "設定済み API + ネイティブ GPT モデル",
      "reco.providerNoGpt": "設定済み API のみ（GPT モデル非表示）",
      "reco.offGpt": "ChatGPT の設定を維持（オフ）",
      "reco.guide": "サードパーティのアカウントがまだない",
      "warn.noProviderToken": "プロバイダーのトークンが見つかりません。",
      "warn.noProviderTokenHint": "設定で OpenCode Go、DeepSeek、またはカスタムプロバイダーのキーを追加してから適用してください。",
      "warn.register": "OpenCode Go に登録",
      "warn.openSettings": "設定を開く",
      "warn.applyDisabled": "トークンを設定すると適用できるようになります。",
      "done.applied": "セットアップを適用しました",
      "done.appliedBody": "ModelDock が Codex 設定を書き換えました。新しいタスクを始める前に、Codex を完全に再起動してください（完全に終了してから開き直す）。",
      "done.appliedNoRestart": "セットアップを適用しました",
      "done.appliedNoRestartBody": "Codex はすでに推奨設定です。再起動は不要です。",
      "done.noChange": "変更は不要でした",
      "done.noChangeBody": "Codex は現在の設定のままです。",
      "done.guideBody": "OpenCode Go に登録して無料枠を解放し、設定からこのガイドを再実行してください。",
    },
  };

  const SUPPORTED = ["en", "zh", "ja"];
  // The wizard follows the dashboard's interface language (i18n.js stores it in
  // localStorage["modeldock-lang"]), falling back to the browser preference the
  // same way i18n.js does, so switching the dashboard language switches the
  // guide too.
  function resolveLang() {
    let lang = null;
    try {
      lang = localStorage.getItem("modeldock-lang");
    } catch {}
    if (!SUPPORTED.includes(lang)) {
      const primary = (navigator.language || "en").toLowerCase().split("-")[0];
      lang = SUPPORTED.includes(primary) ? primary : "en";
    }
    return lang;
  }

  const state = {
    onboard: null,
    step: null,
    hasGpt: null,
    goTier: null,
    applying: false,
    applyResult: null,
    autoShown: false,
    // True while the settings dialog was opened on purpose from the guide's
    // own "Open Settings" button. The watchdog then leaves it alone, because
    // the settings modal must sit above the guide while a token is typed.
    settingsIntent: false,
    // Auto-open the settings dialog once per run after the guide finishes
    // without an OpenCode Go token, so the key can be added right away.
    promptedSettings: false,
  };
  let watchdog = null;

  const L = (key) => {
    const table = I18N[resolveLang()] || I18N.en;
    return table[key] ?? I18N.en[key] ?? key;
  };

  const CSS = `
  #modeldock-wizard, #modeldock-wizard * { box-sizing: border-box; }
  #modeldock-wizard { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center;
    margin: 0; padding: 24px; border: 0; width: 100%; height: 100%; max-width: none; max-height: none;
    background: rgba(5,10,16,.72); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); color: var(--text); }
  #modeldock-wizard[hidden] { display: none; }
  /* The guide is its own full-viewport overlay, so the native dialog backdrop
     must stay transparent or the dimming would be applied twice. */
  #modeldock-wizard::backdrop { background: transparent; }
  .wz-card { width: min(620px, calc(100vw - 40px)); max-height: min(720px, calc(100vh - 48px)); overflow: auto;
    border: 1px solid var(--line); border-radius: 18px; color: var(--text);
    background: linear-gradient(150deg, rgba(19,35,49,.98), rgba(11,21,30,.99));
    box-shadow: 0 30px 90px rgba(0,0,0,.55); padding: 26px 28px 24px;
    animation: wz-in .22s ease; }
  @keyframes wz-in { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
  .wz-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .wz-eyebrow { margin: 0 0 6px; color: var(--blue); font: 700 11px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace;
    letter-spacing: .18em; }
  .wz-title { margin: 0; font-size: 22px; letter-spacing: -.02em; line-height: 1.2; }
  .wz-close { appearance: none; display: grid; place-items: center; flex: 0 0 auto; width: 30px; height: 30px;
    border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--muted);
    font: 400 22px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer;
    transition: color .15s, border-color .15s, background .15s, transform .1s; }
  .wz-close:hover { color: var(--text); border-color: var(--blue); background: rgba(80,183,255,.08); }
  .wz-close:active { transform: scale(.96); }
  .wz-close:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  .wz-progress { display: flex; gap: 6px; margin: 18px 0 2px; }
  .wz-dot { width: 30px; height: 3px; border-radius: 99px; background: #22323f; transition: background .2s ease; }
  .wz-dot.active { background: var(--blue); }
  .wz-body { margin-top: 14px; }
  .wz-body p { color: var(--muted); font-size: 13px; line-height: 1.55; }
  .wz-facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 16px 0 2px; }
  .wz-fact { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: rgba(16,27,38,.6); }
  .wz-fact span { display: block; margin-bottom: 5px; color: var(--muted); font: 700 9px ui-monospace, monospace;
    text-transform: uppercase; letter-spacing: .08em; }
  .wz-fact b { font-size: 12px; font-weight: 600; }
  .wz-fact b.ok { color: var(--green); }
  .wz-fact b.warn { color: var(--amber); }
  .wz-question { margin: 4px 0 12px; font-size: 17px; line-height: 1.35; }
  .wz-options { display: grid; gap: 10px; }
  .wz-option { text-align: left; font: inherit; color: var(--text); border: 1px solid var(--line); border-radius: 12px;
    background: rgba(16,27,38,.7); padding: 13px 15px; cursor: pointer;
    transition: border-color .15s, background .15s, box-shadow .15s, transform .1s; }
  .wz-option:hover { border-color: #2a78a9; background: rgba(80,183,255,.07); }
  .wz-option:active { transform: scale(.99); }
  .wz-option.selected { border-color: var(--blue); background: rgba(80,183,255,.12); box-shadow: 0 0 0 1px var(--blue); }
  .wz-option:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  .wz-option strong { font-size: 14px; }
  .wz-option small { display: block; margin-top: 3px; color: var(--muted); font-size: 12px; line-height: 1.45; }
  .wz-reco { border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px;
    background: rgba(16,27,38,.8); }
  .wz-reco.on { border-color: rgba(72,214,160,.4); }
  .wz-reco.off { border-color: rgba(80,183,255,.35); }
  .wz-reco h3 { margin: 0 0 10px; font-size: 15px; line-height: 1.3; }
  .wz-reco h3::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    margin-right: 9px; background: var(--blue); }
  .wz-reco.on h3::before { background: var(--green); }
  .wz-reco.off h3::before { background: var(--blue); }
  .wz-reco ul { margin: 0; padding-left: 18px; display: grid; gap: 5px; color: var(--muted); font-size: 13px; line-height: 1.5; }
  .wz-warning { margin-top: 12px; border: 1px solid rgba(247,185,85,.45); border-radius: 10px; padding: 10px 12px;
    background: rgba(247,185,85,.08); color: #ffd9a0; font-size: 12px; line-height: 1.5; }
  .wz-warning strong { display: block; color: var(--amber); }
  .wz-warning .wz-warn-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
  .wz-link { color: var(--blue); text-decoration: none; font-weight: 600; }
  .wz-link:hover { text-decoration: underline; }
  .wz-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px; }
  .wz-actions .wz-right { display: flex; gap: 10px; }
  .wz-btn { appearance: none; border: 1px solid var(--line); border-radius: 10px; padding: 9px 16px;
    background: transparent; color: var(--text); font: 700 12px ui-monospace, SFMono-Regular, Consolas, monospace;
    cursor: pointer; transition: border-color .15s, background .15s, opacity .15s; }
  .wz-btn:hover { border-color: var(--blue); }
  .wz-btn.ghost { color: var(--muted); }
  .wz-btn.primary { border-color: var(--blue); background: var(--blue); color: #0b0e16; }
  .wz-btn.primary:hover { background: #6fc3ff; border-color: #6fc3ff; }
  .wz-btn.primary:disabled { opacity: .45; cursor: not-allowed; }
  .wz-btn:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  .wz-skip { margin-top: 12px; text-align: center; }
  .wz-skip button { appearance: none; border: 0; background: none; color: var(--muted); font-size: 11px;
    cursor: pointer; text-decoration: underline; padding: 4px 8px; }
  .wz-skip button:hover { color: var(--text); }
  .wz-error { margin-top: 10px; color: #ff7b7b; font-size: 12px; }
  .wz-hint { margin: 8px 0 0; color: var(--muted); font-size: 11px; text-align: right; }
  .settings-wizard-link { appearance: none; display: block; width: 100%; margin-top: 2px; border: 1px dashed
    var(--line, #2b2f3a); border-radius: 10px; padding: 8px 12px; background: transparent; color: var(--muted, #8b90a0);
    font: 600 11px ui-monospace, SFMono-Regular, Consolas, monospace; cursor: pointer;
    transition: color .15s, border-color .15s; }
  .settings-wizard-link:hover { color: var(--text, #ecf4f8); border-color: var(--blue, #4f8cff); }
  @media (max-width: 720px) { .wz-facts { grid-template-columns: 1fr; } }
  `;

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));

  function api(path, options = {}) {
    return fetch(path, {
      method: options.method || "GET",
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || `${path} ${response.status}`);
      return body;
    });
  }

  function card() {
    const node = document.createElement("div");
    node.className = "wz-card";
    return node;
  }

  function head(title) {
    const wrap = document.createElement("div");
    wrap.className = "wz-head";
    const text = document.createElement("div");
    const eyebrow = document.createElement("p");
    eyebrow.className = "wz-eyebrow";
    eyebrow.textContent = L("wizard.eyebrow");
    const h2 = document.createElement("h2");
    h2.className = "wz-title";
    h2.textContent = title;
    text.append(eyebrow, h2);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "wz-close";
    close.setAttribute("aria-label", L("wizard.closeAria"));
    close.title = L("wizard.closeAria");
    close.textContent = "\u00d7";
    close.addEventListener("click", hide);
    wrap.append(text, close);
    return wrap;
  }

  function progress(active) {
    const wrap = document.createElement("div");
    wrap.className = "wz-progress";
    for (let index = 1; index <= 3; index += 1) {
      const dot = document.createElement("i");
      dot.className = `wz-dot${index === active ? " active" : ""}`;
      wrap.append(dot);
    }
    return wrap;
  }

  function actions(primary, back) {
    const wrap = document.createElement("div");
    wrap.className = "wz-actions";
    const right = document.createElement("div");
    right.className = "wz-right";
    if (back) {
      const backBtn = document.createElement("button");
      backBtn.type = "button";
      backBtn.className = "wz-btn ghost";
      backBtn.textContent = L("wizard.back");
      backBtn.addEventListener("click", back);
      wrap.append(backBtn);
    }
    if (primary) right.append(primary);
    wrap.append(right);
    return wrap;
  }

  function primaryButton(label, onClick, disabled) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wz-btn primary";
    btn.textContent = label;
    btn.disabled = Boolean(disabled);
    btn.addEventListener("click", onClick);
    return btn;
  }

  function fact(label, value, tone) {
    const node = document.createElement("div");
    node.className = "wz-fact";
    const span = document.createElement("span");
    span.textContent = label;
    const b = document.createElement("b");
    b.className = tone || "";
    b.textContent = value;
    node.append(span, b);
    return node;
  }

  function optionCard(value, title, subtitle, selected, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `wz-option${selected ? " selected" : ""}`;
    const strong = document.createElement("strong");
    strong.textContent = title;
    btn.append(strong);
    if (subtitle) {
      const small = document.createElement("small");
      small.textContent = subtitle;
      btn.append(small);
    }
    btn.addEventListener("click", onClick);
    return btn;
  }

  function show() {
    const host = document.getElementById("modeldock-wizard");
    if (!host) return;
    // An auto-opened "missing token" prompt must never sit above the guide:
    // close it first so the wizard is the last element to enter the browser's
    // top layer (which beats any z-index) and therefore renders on top.
    if (!state.settingsIntent) closeSettingsDialog();
    host.hidden = false;
    if (typeof host.showModal === "function" && !host.open) host.showModal();
    armWatchdog();
  }

  function hide() {
    const host = document.getElementById("modeldock-wizard");
    if (!host) return;
    host.hidden = true;
    if (host.open && typeof host.close === "function") host.close();
    disarmWatchdog();
  }

  function armWatchdog() {
    if (watchdog) return;
    watchdog = setInterval(() => {
      const host = document.getElementById("modeldock-wizard");
      if (!host || host.hidden) {
        disarmWatchdog();
        return;
      }
      // Close the settings dialog while the guide is visible, but never undo
      // an intentional open from the guide's own "Open Settings" button.
      if (!state.settingsIntent) closeSettingsDialog();
    }, 250);
  }

  function disarmWatchdog() {
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
  }

  function closeSettingsDialog() {
    // Close unconditionally: a launch from the settings dialog must not leave
    // the modal open, because the browser top layer beats any z-index and would
    // cover the wizard while it is still hidden.
    const dialog = document.getElementById("settings-dialog");
    if (dialog && typeof dialog.close === "function") dialog.close();
    else if (dialog) dialog.removeAttribute("open");
  }

  function openSettings() {
    // The settings <dialog> renders in the browser top layer above the wizard
    // while a token is typed; mark the open as intentional so the watchdog
    // does not undo it, and refresh the summary from its close event.
    state.settingsIntent = true;
    const button = document.getElementById("settings-open");
    if (button) button.click();
  }

  function refreshOnboard() {
    return api("/api/onboarding").then((data) => {
      state.onboard = data;
      return data;
    });
  }

  function recommendationFor() {
    const goToken = Boolean(state.onboard?.tokenConfigured?.["opencode-go"]);
    // ON mode can be served by any provider token (the dashboard lets the user
    // pick which provider owns the main model); free zen models are ordinary
    // selectable entries that also route through ON once reachable.
    const anyToken = Boolean(state.onboard?.anyTokenConfigured);
    if (state.goTier === "paid") {
      return state.hasGpt
        ? {
          mode: "on", nativeMerge: true, tokenNeeded: !anyToken, variant: "on",
          title: L("reco.providerGpt"),
          bullets: [L("reco.onMode"), L("reco.catalogProvider"), L("reco.nativeOn")],
        }
        : {
          mode: "on", nativeMerge: false, tokenNeeded: !anyToken, variant: "on",
          title: L("reco.providerNoGpt"),
          bullets: [L("reco.onMode"), L("reco.catalogProvider"), L("reco.nativeOff")],
        };
    }
    if (state.goTier === "free") {
      return {
        mode: "on", nativeMerge: state.hasGpt, tokenNeeded: !goToken, variant: "on",
        title: L("reco.providerNoGpt"),
        bullets: [L("reco.onMode"), L("reco.catalogProvider"), L("reco.nativeOff")],
      };
    }
    return state.hasGpt
      ? {
        mode: "off", tokenNeeded: false, variant: "off",
        title: L("reco.offGpt"),
        bullets: [L("reco.offMode"), L("reco.nativeKeep"), L("reco.dsAlt")],
      }
      : {
        mode: null, tokenNeeded: false, variant: "off",
        title: L("reco.guide"),
        bullets: [L("reco.offMode"), L("reco.register"), L("reco.rerun")],
      };
  }

  function render() {
    const host = document.getElementById("modeldock-wizard");
    const root = card();

    if (state.step === "welcome") renderWelcome(root);
    else if (state.step === "q1") renderQ1(root);
    else if (state.step === "q2") renderQ2(root);
    else if (state.step === "summary") renderSummary(root);
    else if (state.step === "done") renderDone(root);
    else renderWelcome(root);

    host.replaceChildren(root);
  }

  function renderWelcome(root) {
    root.append(head(L("wizard.title")));
    const body = document.createElement("div");
    body.className = "wz-body";
    const p = document.createElement("p");
    p.textContent = L("wizard.body");
    body.append(p);

    const factsWrap = document.createElement("div");
    factsWrap.className = "wz-facts";
    const go = Boolean(state.onboard?.tokenConfigured?.["opencode-go"]);
    const ds = Boolean(state.onboard?.tokenConfigured?.["deepseek-official"]);
    const auto = state.onboard?.autostart || {};
    factsWrap.append(
      fact(L("wizard.factGo"), go ? L("wizard.configured") : L("wizard.missing"), go ? "ok" : "warn"),
      fact(L("wizard.factDs"), ds ? L("wizard.configured") : L("wizard.missing"), ds ? "ok" : "warn"),
      fact(
        L("wizard.factAutostart"),
        auto.supported === false ? L("wizard.autostartUnsupported") : auto.enabled ? L("wizard.autostartOn") : L("wizard.autostartOff"),
        auto.supported === false ? "warn" : auto.enabled ? "ok" : "",
      ),
    );
    body.append(factsWrap);

    const modeLabel = { off: L("wizard.modeOff"), on: L("wizard.modeOn") };
    const modeHint = document.createElement("p");
    modeHint.textContent = `${L("wizard.currentMode")}: ${modeLabel[state.onboard?.mode] || modeLabel.off}`;
    body.append(modeHint);
    root.append(body);

    const start = primaryButton(L("wizard.start"), () => { state.step = "q1"; render(); });
    const skipWrap = document.createElement("div");
    skipWrap.className = "wz-skip";
    const skip = document.createElement("button");
    skip.type = "button";
    skip.textContent = L("wizard.skip");
    skip.addEventListener("click", skipSetup);
    skipWrap.append(skip);
    const wrap = document.createElement("div");
    wrap.append(actions(start, null), skipWrap);
    root.append(wrap);
  }

  function renderQ1(root) {
    root.append(head(L("wizard.step1")), progress(1));
    const body = document.createElement("div");
    body.className = "wz-body";
    const h3 = document.createElement("h3");
    h3.className = "wz-question";
    h3.textContent = L("wizard.q1");
    const options = document.createElement("div");
    options.className = "wz-options";
    options.append(
      optionCard(true, L("wizard.q1Yes"), L("wizard.q1YesSub"), state.hasGpt === true, () => {
        state.hasGpt = true;
        state.step = "q2";
        render();
      }),
      optionCard(false, L("wizard.q1No"), L("wizard.q1NoSub"), state.hasGpt === false, () => {
        state.hasGpt = false;
        state.step = "q2";
        render();
      }),
    );
    body.append(h3, options);
    root.append(body);
    root.append(actions(null, () => { state.step = "welcome"; render(); }));
  }

  function renderQ2(root) {
    root.append(head(L("wizard.step2")), progress(2));
    const body = document.createElement("div");
    body.className = "wz-body";
    const h3 = document.createElement("h3");
    h3.className = "wz-question";
    h3.textContent = L("wizard.q2");
    const options = document.createElement("div");
    options.className = "wz-options";
    const pick = (tier) => {
      state.goTier = tier;
      state.step = "summary";
      render();
    };
    options.append(
      optionCard("none", L("wizard.q2None"), L("wizard.q2NoneSub"), state.goTier === "none", () => pick("none")),
      optionCard("free", L("wizard.q2Free"), L("wizard.q2FreeSub"), state.goTier === "free", () => pick("free")),
      optionCard("paid", L("wizard.q2Paid"), L("wizard.q2PaidSub"), state.goTier === "paid", () => pick("paid")),
    );
    body.append(h3, options);
    root.append(body);
    root.append(actions(null, () => { state.step = "q1"; render(); }));
  }

  function renderSummary(root) {
    const rec = recommendationFor();
    root.append(head(L("wizard.step3")), progress(3));
    const body = document.createElement("div");
    body.className = "wz-body";

    const reco = document.createElement("div");
    reco.className = `wz-reco ${rec.variant}`;
    const h3 = document.createElement("h3");
    h3.textContent = rec.title;
    const ul = document.createElement("ul");
    for (const bullet of rec.bullets) {
      const li = document.createElement("li");
      if (bullet === L("reco.register")) {
        // The register recommendation is the same referral link used everywhere
        // else in the guide and the settings dialog.
        const a = document.createElement("a");
        a.className = "wz-link";
        a.href = OPENCODE_SIGNUP;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = bullet;
        li.append(a);
      } else {
        li.textContent = bullet;
      }
      ul.append(li);
    }
    reco.append(h3, ul);
    body.append(reco);

    let applyDisabled = state.applying;
    if (rec.tokenNeeded) {
      const warning = document.createElement("div");
      warning.className = "wz-warning";
      const strong = document.createElement("strong");
      strong.textContent = L("warn.noProviderToken");
      const hint = document.createElement("span");
      hint.textContent = L("warn.noProviderTokenHint");
      const row = document.createElement("div");
      row.className = "wz-warn-row";
      const register = document.createElement("a");
      register.className = "wz-link";
      register.href = OPENCODE_SIGNUP;
      register.target = "_blank";
      register.rel = "noopener noreferrer";
      register.textContent = L("warn.register");
      const openSettingsBtn = document.createElement("button");
      openSettingsBtn.type = "button";
      openSettingsBtn.className = "wz-btn";
      openSettingsBtn.textContent = L("warn.openSettings");
      openSettingsBtn.addEventListener("click", openSettings);
      row.append(register, openSettingsBtn);
      warning.append(strong, hint, row);
      body.append(warning);
      applyDisabled = true;
    }
    root.append(body);

    const primary = rec.mode
      ? primaryButton(
        state.applying ? L("wizard.applyBusy") : L("wizard.apply"),
        apply,
        applyDisabled,
      )
      : primaryButton(L("wizard.done"), finishGuide, false);
    if (rec.tokenNeeded) {
      const hint = document.createElement("p");
      hint.className = "wz-hint";
      hint.textContent = L("warn.applyDisabled");
      root.append(actions(primary, () => { state.step = "q2"; render(); }), hint);
    } else {
      root.append(actions(primary, () => { state.step = "q2"; render(); }));
    }
  }

  function renderDone(root) {
    const applied = Boolean(state.applyResult?.modeChanged);
    const restart = Boolean(state.applyResult?.restartRequired);
    const guide = state.goTier === "none" && !state.hasGpt;
    const title = applied
      ? (restart ? L("done.applied") : L("done.appliedNoRestart"))
      : guide ? L("reco.guide") : L("done.noChange");
    const bodyText = applied
      ? (restart ? L("done.appliedBody") : L("done.appliedNoRestartBody"))
      : guide
        ? L("done.guideBody")
        : L("done.noChangeBody");
    root.append(head(title));
    const body = document.createElement("div");
    body.className = "wz-body";
    const p = document.createElement("p");
    p.textContent = bodyText;
    body.append(p);
    if (guide) {
      const link = document.createElement("p");
      const a = document.createElement("a");
      a.className = "wz-link";
      a.href = OPENCODE_LINK;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = OPENCODE_LINK;
      link.append(a);
      body.append(link);
    }
    root.append(body);
    root.append(actions(primaryButton(L("wizard.done"), finish, false), null));
  }

  async function apply() {
    const rec = recommendationFor();
    state.applying = true;
    render();
    try {
      const payload = { mode: rec.mode };
      if (rec.nativeMerge !== undefined) payload.nativeMerge = rec.nativeMerge;
      const result = await api("/api/config/mode", { method: "POST", body: payload });
      await api("/api/onboarding/complete", { method: "POST", body: {} });
      state.onboard = { ...state.onboard, onboarded: true };
      state.applyResult = { modeChanged: true, restartRequired: Boolean(result?.restartRequired) };
      state.applying = false;
      state.step = "done";
      render();
      promptSettingsIfNoToken();
    } catch (error) {
      state.applyResult = null;
      state.applying = false;
      render();
      const host = document.getElementById("modeldock-wizard");
      const errorNode = document.createElement("p");
      errorNode.className = "wz-error";
      errorNode.textContent = `${L("wizard.errorTitle")}: ${error.message}`;
      host.querySelector(".wz-body")?.append(errorNode);
    }
  }

  async function finishGuide() {
    try {
      await api("/api/onboarding/complete", { method: "POST", body: {} });
    } catch {
      // The guide changes nothing; a failed marker write must not block dismissal.
    }
    state.onboard = { ...state.onboard, onboarded: true };
    hide();
  }

  async function skipSetup() {
    try {
      await api("/api/onboarding/complete", { method: "POST", body: {} });
    } catch {
      // Same as finishGuide: dismissal is more important than the marker write.
    }
    state.onboard = { ...state.onboard, onboarded: true };
    hide();
  }

  function finish() {
    const reload = Boolean(state.applyResult?.modeChanged);
    hide();
    if (reload) setTimeout(() => window.location.reload(), 500);
  }

  // The done screen tells the user to fully restart Codex; when the guide
  // completed without an OpenCode Go token, surface the settings dialog (which
  // shows above the guide in the browser top layer) so the key can be entered
  // in the same sitting. settingsIntent keeps the watchdog from closing it.
  function promptSettingsIfNoToken() {
    if (state.promptedSettings) return;
    if (state.onboard?.anyTokenConfigured) return;
    state.promptedSettings = true;
    setTimeout(() => {
      openSettings();
      setTimeout(() => document.getElementById("settings-go-token")?.focus(), 350);
    }, 500);
  }

  function mount() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);

    // A native <dialog> puts the guide in the browser's top layer, above the
    // settings dialog (which is already a <dialog> and can never be beaten by
    // a plain z-index). Esc maps to the same dismissal as the X button.
    const host = document.createElement("dialog");
    host.id = "modeldock-wizard";
    host.hidden = true;
    document.body.append(host);
    host.addEventListener("cancel", (event) => {
      event.preventDefault();
      hide();
    });

    const dialog = document.getElementById("settings-dialog");
    if (dialog) {
      dialog.addEventListener("close", () => {
        state.settingsIntent = false;
        const host = document.getElementById("modeldock-wizard");
        if (!host || host.hidden) return;
        refreshOnboard().then(render).catch(() => {});
      });
    }

    const settingsEntry = document.getElementById("settings-wizard");
    if (settingsEntry) {
      settingsEntry.textContent = L("wizard.settingsEntry");
      settingsEntry.addEventListener("click", () => {
        closeSettingsDialog();
        start(true);
      });
    }
    // Follow dashboard language changes (i18n.js setLang dispatches this
    // event): refresh the settings entry label and any visible wizard copy.
    window.addEventListener("modeldock:langchange", () => {
      if (settingsEntry) settingsEntry.textContent = L("wizard.settingsEntry");
      const wizardHost = document.getElementById("modeldock-wizard");
      if (wizardHost && !wizardHost.hidden && state.step) render();
    });
  }

  async function start(force) {
    try {
      if (force || !state.onboard) state.onboard = await refreshOnboard();
      if (!force && state.onboard.onboarded) return;
      state.promptedSettings = false;
      state.step = "welcome";
      render();
      show();
    } catch {
      // Gateway may still be booting on first open; retry once shortly after.
      setTimeout(() => {
        refreshOnboard()
          .then((data) => {
            state.onboard = data;
            if (data.onboarded) return;
            state.step = "welcome";
            render();
            show();
          })
          .catch(() => {});
      }, 4000);
    }
  }

  window.modeldockWizard = { start: () => start(true) };
  mount();
  start(false);
})();
