
import { customEndpointFor } from "./custom-endpoint-routing.mjs";
import { isLoopbackHost } from "./loopback.mjs";
import { NATIVE_PROVIDER_ID } from "./native-provider.mjs";
import {
  codexSlugFor,
  modelAddressFor,
  modelRefParts,
} from "./model-ref.mjs";

// The context window we declare for relayed models. DeepSeek V4 (flash and pro)
// advertise a 1M window natively and the OpenCode endpoint held 911k in a live
// needle test, so those entries report their self-declared 1M instead of a
// gate-imposed cap. CONTEXT_WINDOW remains the conservative fallback for the rest
// of the catalog whose real window we have not measured.
const CONTEXT_WINDOW = Number(process.env.MODELDOCK_CONTEXT_WINDOW || 250_000);
const DEEPSEEK_CONTEXT_WINDOW = 1_000_000;
const AUTO_COMPACT_PERCENT = 0.8;
const AUTO_COMPACT_TOKEN_LIMIT = Math.floor(CONTEXT_WINDOW * AUTO_COMPACT_PERCENT);

export { CONTEXT_WINDOW, AUTO_COMPACT_PERCENT, AUTO_COMPACT_TOKEN_LIMIT };

// Measured 2026-08-19 by sending an unknown effort and reading the enum the
// upstream names back: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`,
// `max`. Identical on both endpoints - OpenCode Go proxies the same provider
// and returns the same error ("Error from provider (Console Go)"), so the Go
// copies of these models carry the same ladder rather than the general tier.
// ultra is refused by both.
const DEEPSEEK_REASONING_LEVELS = [
  { effort: "none", description: "No reasoning; direct responses only" },
  { effort: "minimal", description: "Barely any reasoning; fastest replies" },
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balanced reasoning for typical work" },
  { effort: "high", description: "Deeper reasoning for complex work" },
  { effort: "xhigh", description: "Extra-deep reasoning for hard problems" },
  { effort: "max", description: "Maximum reasoning depth" },
];

// llama.cpp chat template accepts exactly these reasoning efforts
// (verified in the GGUF template: 'xhigh', 'medium', 'low'; "high" raises).
// Advertised for Custom and Local backends so the Codex picker only offers
// values the template accepts.
// The ladder a model gets when nothing better is known. Not a measurement -
// no upstream publishes its accepted efforts (OpenCode Go's /v1/models returns
// id, object, created and owned_by, nothing more), and an unsupported effort is
// usually ignored rather than refused, so probing proves little. Four rungs is
// the shape almost every model actually offers; a model whose real ladder is
// known states it on its own entry and never reaches this.
const GENERAL_REASONING_LEVELS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balanced reasoning for typical work" },
  { effort: "high", description: "Deeper reasoning for complex work" },
  { effort: "xhigh", description: "Extra-deep reasoning for hard problems" },
];

const LOCAL_REASONING_LEVELS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balanced reasoning for typical work" },
  { effort: "xhigh", description: "Extra-deep reasoning for hard problems" },
];

// OpenCode Go's public OpenAI-compatible surface accepts most models on
// Responses, while its Qwen and MiniMax families use Chat Completions. This is
// provider contract metadata, not a runtime test made during discovery.
export function openCodeTransportForModel(modelId) {
  return /^(hy4-preview|minimax-m2\.5|minimax-m3|qwen)/.test(String(modelId || "")) ? "chat" : "responses";
}

// V4.1 Flash and the bare Flash alias used to be known only through a special case
// here, which granted them a vision flag while leaving everything else to discovery.
// They are declared in both providers' availableModels now, so no exception is needed:
// a declaration is what makes the row survive a restart and carries the real contract.

// Codex estimates the session history with its own (GPT) tokenizer, which runs
// ~25-30% under what qwen's tokenizer actually produces. For small local
// backends (<= LOCAL_CONTEXT_MAX) the advertised window is scaled by
// LOCAL_CONTEXT_COMPENSATION so Codex's auto-compact fires BEFORE the real
// model hits its hard limit. Bigger backends (OpenAI/OpenRouter custom) keep
// their real window - their headroom makes the estimate mismatch harmless.
const LOCAL_CONTEXT_MAX = 40_000;
const LOCAL_CONTEXT_COMPENSATION = 0.8;
function localContextWindow(actual) {
  if (!(actual > 0)) return actual;
  return actual <= LOCAL_CONTEXT_MAX ? Math.floor(actual * LOCAL_CONTEXT_COMPENSATION) : actual;
}

// Feature flags Codex reads from the model catalog to decide which client-side plugin
// machinery to expose (verified in the Codex binary's ModelInfo vocabulary):
// `artifact` = artifact-tool plugins (presentations / spreadsheets / documents / pdf),
// `tool_call_mcp_elicitation` = let the model request MCP tool schemas it does not have,
// `workspace_dependencies` = codex_app.load_workspace_dependencies,
// `computer_use` = desktop screen control, `browser_use` = Chrome control.
const EXPERIMENTAL_SUPPORTED_TOOLS = ["artifact", "tool_call_mcp_elicitation", "workspace_dependencies", "computer_use", "browser_use"];

// One catalog entry. Codex's model picker lists whatever the active provider returns
// from /v1/models, so emitting an entry per available model is what makes them all
// selectable at runtime - no config rewrite, no restart.
// applyPatchToolType decides the wire shape Codex uses for apply_patch:
// "freeform" makes it a `custom` tool carrying a grammar, "function" makes it
// an ordinary function tool. Freeform is the better shape and stays the
// default; an upstream with no `custom` variant in its tool enum takes the
// other one, because there the freeform tool is not a worse patch tool, it is
// a 422 that ends the turn.
function catalogEntry({ slug, displayName, description, compHash, inputModalities, supportsSearchTool, baseInstructions, defaultReasoningLevel, supportedReasoningLevels, priority, contextWindow = CONTEXT_WINDOW, autoCompactTokenLimit = 0, applyPatchToolType = "freeform" }) {
  const compactLimit = Number.isSafeInteger(autoCompactTokenLimit) && autoCompactTokenLimit > 0
    ? Math.min(autoCompactTokenLimit, contextWindow)
    : Math.floor(contextWindow * AUTO_COMPACT_PERCENT);
  return {
        slug,
        display_name: displayName,
        description,
        prefer_websockets: false,
        support_verbosity: true,
        default_verbosity: "low",
        apply_patch_tool_type: applyPatchToolType,
        web_search_tool_type: "text",
        input_modalities: inputModalities,
        supports_image_detail_original: false,
        truncation_policy: { mode: "tokens", limit: 10_000 },
        supports_parallel_tool_calls: false,
        tool_mode: null,
        multi_agent_version: "v2",
        use_responses_lite: false,
        include_skills_usage_instructions: false,
        auto_review_model_override: null,
        context_window: contextWindow,
        max_context_window: contextWindow,
        effective_context_window_percent: 95,
        auto_compact_token_limit: compactLimit,
        comp_hash: compHash,
        reasoning_summary_format: "experimental",
        default_reasoning_summary: "none",
        default_reasoning_level: defaultReasoningLevel,
        supported_reasoning_levels: supportedReasoningLevels,
        shell_type: "shell_command",
        visibility: "list",
        minimal_client_version: "0.144.0",
        supported_in_api: true,
        availability_nux: null,
        upgrade: null,
        priority,
        experimental_supported_tools: EXPERIMENTAL_SUPPORTED_TOOLS,
        supports_search_tool: supportsSearchTool,
        default_service_tier: null,
        supports_reasoning_summaries: true,
        base_instructions: baseInstructions,
        model_messages: {
          instructions_template: baseInstructions,
          instructions_variables: {
            personality_default: "",
            personality_friendly: "",
            personality_pragmatic: "",
          },
        },
  };
}

function modelCatalogDefaults({ profileId, mainModel, displayName, description, compHash, inputModalities, supportsSearchTool, baseInstructions, defaultReasoningLevel = "high", supportedReasoningLevels = GENERAL_REASONING_LEVELS, availableModels = [], applyPatchToolType = "freeform" }) {
  // ModelDock keeps a readable owner-qualified address internally. The Codex
  // catalog is a separate wire boundary: it gets the reversible metric-safe
  // spelling so the client's telemetry never sees the internal '@' delimiter.
  const mainReference = modelRefParts(mainModel);
  const qualifiedMain = mainReference.qualified
    ? codexSlugFor(mainReference.provider, mainReference.model)
    : codexSlugFor(profileId, mainModel);
  const base = { compHash, supportsSearchTool, baseInstructions, defaultReasoningLevel, supportedReasoningLevels, applyPatchToolType };
  // The patch-tool shape belongs to whoever will receive the request, and this
  // catalog is cross-provider, so it is resolved per entry from the slug's
  // owner rather than taken from whichever profile is writing the file.
  const patchToolTypeFor = (slug) => {
    const reference = modelRefParts(slug);
    if (!reference.qualified) return applyPatchToolType;
    return profileById(reference.provider)?.applyPatchToolType || applyPatchToolType;
  };
  // The selected main model may belong to a provider other than the active
  // profile (e.g. a dashboard-added custom endpoint set as main). Label its
  // catalog entry "Provider - Model" like every other entry; the caller's
  // displayName stays the fallback for bare ids owned by the active profile.
  const ownerQualifiedDisplayName = (id) => {
    const reference = modelRefParts(id);
    if (!reference.qualified) return null;
    const profile = profileById(reference.provider);
    if (!profile?.label) return null;
    const modelLabel = modelEntryFor(null, id)?.label || reference.model;
    // An entry labeled with its provider's own name is already fully described;
    // joining both would duplicate the same label.
    return modelLabel === profile.label ? profile.label : `${profile.label} - ${modelLabel}`;
  };
  // The main model may be the published slug (gpt-5.6-luna@opencode-go); the profile
  // catalog stores bare ids, so resolve through bareModelId. A main model owned by
  // another provider (Custom or Local) reads its window and vision capability
  // from that provider's catalog entry instead of the active profile's list.
  const mainEntry = modelEntryFor(null, qualifiedMain)
    || availableModels.find((model) => model.id === bareModelId(qualifiedMain));
  const mainModalities = mainEntry?.supportsVision ? ["text", "image"] : ["text"];
  // Every provider's models in one list, each labelled with its source, so the picker
  // can switch upstream as well as model. The bare id stays with the default profile so
  // existing Codex configs keep resolving; another provider's copy of the same id is
  // published under an explicit owner suffix.
  const rest = [];
  for (const item of routedModelInventory()) {
    const { model } = item;
    if (model.status === "unavailable") continue;
    if (item.codexSlug === qualifiedMain || rest.some((entry) => entry.slug === item.codexSlug)) continue;
    rest.push({
        slug: item.codexSlug,
        displayName: (model.label || model.id) === item.providerLabel
          ? item.providerLabel
          : `${item.providerLabel} - ${model.label || model.id}`,
        supportsVision: Boolean(model.supportsVision),
        providerLabel: item.providerLabel,
        contextWindow: model.contextWindow || CONTEXT_WINDOW,
        // Carried, not defaulted: a model that states its own rungs has
        // them measured or published, and the active profile's ladder is
        // not a fact about somebody else's model.
        supportedReasoningLevels: model.supportedReasoningLevels,
        defaultReasoningLevel: model.defaultReasoningLevel,
        reasoningSource: model.reasoningSource || "",
    });
  }
  return {
    models: [
      catalogEntry({
        ...base,
        slug: qualifiedMain,
        applyPatchToolType: patchToolTypeFor(qualifiedMain),
        displayName: ownerQualifiedDisplayName(qualifiedMain) || displayName,
        description,
        inputModalities: mainModalities,
        priority: 1,
        supportedReasoningLevels:
          mainEntry?.supportedReasoningLevels || base.supportedReasoningLevels,
        defaultReasoningLevel:
          mainEntry?.defaultReasoningLevel || base.defaultReasoningLevel,
        contextWindow: mainEntry?.contextWindow || CONTEXT_WINDOW,
        autoCompactTokenLimit: mainEntry?.autoCompactTokenLimit,
      }),
      ...rest.map((model, index) => catalogEntry({
        ...base,
        slug: model.slug,
        applyPatchToolType: patchToolTypeFor(model.slug),
        displayName: model.displayName,
        description: `${model.providerLabel} through the local ModelDock gate.`,
        // Codex sends images only to models that declare the modality; the gate still
        // reroutes visual turns to the vision model for the text-only ones.
        inputModalities: model.supportsVision ? ["text", "image"] : ["text"],
        supportedReasoningLevels: model.supportedReasoningLevels || base.supportedReasoningLevels,
        defaultReasoningLevel: model.defaultReasoningLevel || base.defaultReasoningLevel,
        contextWindow: model.contextWindow,
        autoCompactTokenLimit: model.autoCompactTokenLimit,
        // 1 is the selected main model; the rest follow in provider order.
        priority: index + 2,
      })),
    ],
  };
}

const OPENCODE_GO_PROFILE = {
  id: "opencode-go",
  label: "OpenCode Go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  tokenEnvName: "OPENCODE_GO_TOKEN",
  settingsField: "opencodeGoToken",
  settingsErrorCode: "invalid_opencode_go_token",
  settingsInvalidMessage: "A valid OpenCode Go token is required.",
  modelDiscovery: true,
  discoveryTransports: new Set(["responses", "chat"]),
  discoveryTransportFor: openCodeTransportForModel,

  blockedToolTypes: new Set(["tool_search", "web_search"]),
  // inputNormalizer names a per-model input adaptation the gateway keeps in
  // its INPUT_NORMALIZERS registry. The route code asks the profile instead
  // of matching model/provider ids, so adding a provider (or moving a model)
  // never means editing the relay paths - the same reasoning that moved tool
  // policy onto the profile. Unmarked models take the generic path.
  availableModels: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", endpoint: "responses", inputNormalizer: "opencode-flash", supportsVision: false, acceptsImagesViaGateway: true, contextWindow: DEEPSEEK_CONTEXT_WINDOW, contextSource: "measured", supportedReasoningLevels: DEEPSEEK_REASONING_LEVELS, defaultReasoningLevel: "medium", reasoningSource: "measured", status: "available" },
    { id: "deepseek-v4-flash-vision-exp", label: "DeepSeek V4 Flash Vision Exp", endpoint: "responses", supportsVision: true, contextWindow: DEEPSEEK_CONTEXT_WINDOW, contextSource: "vendor", supportedReasoningLevels: DEEPSEEK_REASONING_LEVELS, defaultReasoningLevel: "medium", status: "available" },
    // Zen free tier: same OpenCode token, but the upstream is zen/v1 not zen/go/v1.
    // deepseek-v4-flash-free is available but frequently returns 503 when the free
    // quota is exhausted; the upstream surfaces it per request.
    { id: "deepseek-v4-flash-free", label: "DeepSeek V4 Flash Free", endpoint: "responses", zen: true, free: true, supportsVision: false, quota5h: 100000, contextWindow: 1000000, contextSource: "vendor", status: "available" },
    { id: "nemotron-3-ultra-free", label: "Nemotron 3 Ultra Free", endpoint: "responses", zen: true, free: true, supportsVision: false, contextWindow: 262144, contextSource: "vendor", status: "available" },
    { id: "laguna-s-2.1-free", label: "Laguna S 2.1 Free", endpoint: "responses", zen: true, free: true, supportsVision: false, contextWindow: 1000000, contextSource: "vendor", status: "available" },
    { id: "longcat-2.0-free", label: "Longcat 2.0 Free", endpoint: "responses", zen: true, free: true, supportsVision: false, contextWindow: 1000000, contextSource: "vendor", status: "available" },
    { id: "longcat-2.0", label: "Longcat 2.0", endpoint: "chat", supportsVision: false, contextWindow: 1048756, contextSource: "vendor", status: "available" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", endpoint: "responses", inputNormalizer: "opencode-pro", supportsVision: false, acceptsImagesViaGateway: true, contextWindow: DEEPSEEK_CONTEXT_WINDOW, contextSource: "measured", supportedReasoningLevels: DEEPSEEK_REASONING_LEVELS, defaultReasoningLevel: "medium", reasoningSource: "measured", status: "available" },
    // Declared, not discovered. A discovered row lives only in memory: it carries no
    // window, no input normalizer and no ladder, and it is absent until a refresh
    // succeeds. This gateway logged 157 discovery timeouts and a boot refresh of
    // `discovered=0`, while the persisted Codex catalog kept advertising the model, so
    // Codex offered an address the running process did not know and every request got
    // the 503 "endpoint was removed" from relayResponses' addressed-provider guard. The
    // symptom was intermittent for exactly that reason: it reappeared on the next
    // successful refresh.
    //
    // The normalizer is the same one V4 Flash needs on this provider (replayed reasoning
    // items must reach it as concrete reasoning_text); applying it to a model that did
    // not need it is inert, so this is the safe side of the inference. The window is the
    // vendor's figure, not a measurement, and the ladder is V4 Flash's on DeepSeek's own
    // "on par" claim - neither is marked as measured. Vision is documented for this model
    // (https://www.deepseek.com/en/news/deepseek-v4-1-flash/).
    { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", endpoint: "responses", inputNormalizer: "opencode-flash", supportsVision: true, acceptsImagesViaGateway: true, contextWindow: DEEPSEEK_CONTEXT_WINDOW, contextSource: "vendor", supportedReasoningLevels: DEEPSEEK_REASONING_LEVELS, defaultReasoningLevel: "medium", status: "available" },
    { id: "deepseek-flash", label: "DeepSeek Flash", endpoint: "responses", inputNormalizer: "opencode-flash", supportsVision: true, acceptsImagesViaGateway: true, contextWindow: DEEPSEEK_CONTEXT_WINDOW, contextSource: "vendor", supportedReasoningLevels: DEEPSEEK_REASONING_LEVELS, defaultReasoningLevel: "medium", status: "available" },
    { id: "glm-5", label: "GLM 5", endpoint: "responses", supportsVision: false, contextWindow: 200000, contextSource: "vendor", status: "available" },
    { id: "glm-5.1", label: "GLM 5.1", endpoint: "responses", supportsVision: false, contextWindow: 200000, contextSource: "vendor", status: "available" },
    { id: "glm-5.2", label: "GLM 5.2", endpoint: "responses", supportsVision: false, contextWindow: 1000000, contextSource: "vendor", status: "available" },
    // OpenCode's live /models response names these models but does not expose a
    // window. Publish the explicit conservative fallback, never a guessed one.
    { id: "glm-5.3-flash", label: "GLM 5.3 Flash", endpoint: "chat", supportsVision: false, contextWindow: CONTEXT_WINDOW, contextSource: "fallback", status: "available" },
    { id: "glm-5.3", label: "GLM 5.3", endpoint: "chat", supportsVision: false, contextWindow: CONTEXT_WINDOW, contextSource: "fallback", status: "available" },
    // The bare id gpt-5.6-luna is also a native GPT picker slot, so our Luna is
    // published under the @opencode-go suffix and the bare id stays reserved for
    // the native backend's GPT-5.6-Luna.
    { id: "gpt-5.6-luna", label: "Luna", endpoint: "responses", supportsVision: true, visionScore: 7, visionMaxScore: 9, visionTier: "medium", quota5h: 2050, speedTier: "fast", ownerQualified: true, contextWindow: 272000, contextSource: "vendor", status: "available" },
    { id: "grok-4.5", label: "Grok 4.5", endpoint: "responses", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 120, speedTier: "fast", contextWindow: 500000, contextSource: "vendor", status: "available" },
    // Console Go's Grok leg accepts ordinary function descriptors, not Codex's
    // custom or namespace wrappers. Reuse the reversible conversion already
    // used by the direct xAI route, but keep the original qualified names: the
    // complete current Codex package passes without short aliases.
    { id: "grok-4.6", label: "Grok 4.6", endpoint: "responses", inputNormalizer: "opencode-flash", supportsVision: true, imageTransportMaxWireBytes: 320 * 1024, blockedToolTypes: new Set(["custom"]), customToolsAsFunctions: new Set(["apply_patch"]), flattenAllNamespaces: true, contextWindow: CONTEXT_WINDOW, contextSource: "fallback", status: "available" },
    { id: "hy3", label: "Hy3", endpoint: "responses", supportsVision: false, contextWindow: 262144, contextSource: "vendor", status: "available" },
    { id: "hy3-preview", label: "Hy3 Preview", endpoint: "responses", supportsVision: false, status: "unavailable" },
    // The authenticated OpenCode Go directory first advertised this exact id on
    // 2026-08-28. Its sparse /models entry carries no context or modality
    // metadata. Its Responses route returned 500 for a complete current Codex
    // package; Chat accepted the same package, called a namespace tool, and
    // correctly read a controlled image after the continuation. Publish those
    // measured transport and vision capabilities, but retain the conservative
    // catalog window rather than inheriting HY3's unreported context claim.
    { id: "hy4-preview", label: "HY4 Preview", endpoint: "chat", supportsVision: true, contextWindow: CONTEXT_WINDOW, contextSource: "fallback", status: "available" },
    { id: "kimi-k2.5", label: "Kimi K2.5", endpoint: "responses", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 1150, speedTier: "fast", contextWindow: 262144, contextSource: "vendor", status: "available" },
    { id: "kimi-k2.6", label: "Kimi K2.6", endpoint: "responses", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 1150, speedTier: "fast", contextWindow: 262144, contextSource: "vendor", status: "available" },
    { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", endpoint: "responses", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 1350, speedTier: "fast", contextWindow: 262144, contextSource: "vendor", status: "available" },
    { id: "kimi-k3", label: "Kimi K3", endpoint: "responses", supportsVision: false, contextWindow: 1048576, contextSource: "vendor", status: "available" },
    { id: "mimo-v2.5", label: "MiMo V2.5", endpoint: "responses", imageUrlShape: "object", supportsVision: true, visionScore: 6, visionMaxScore: 9, visionTier: "medium", quota5h: 30100, speedTier: "medium", contextWindow: 1000000, contextSource: "vendor", status: "available" },
    { id: "mimo-v2.5-free", label: "MiMo V2.5 Free", endpoint: "responses", zen: true, imageUrlShape: "object", supportsVision: true, visionScore: 6, visionMaxScore: 9, visionTier: "medium", quota5h: 100000, speedTier: "fast", free: true, contextWindow: 1000000, contextSource: "vendor", status: "available" },
    { id: "mimo-v2.5-pro", label: "MiMo V2.5 Pro", endpoint: "responses", supportsVision: false, contextWindow: 1000000, contextSource: "vendor", status: "available" },
    { id: "mimo-v2-omni", label: "MiMo V2 Omni", endpoint: "responses", supportsVision: false, status: "unavailable" },
    { id: "mimo-v2-pro", label: "MiMo V2 Pro", endpoint: "responses", supportsVision: false, status: "unavailable" },
    // These older Chat candidates have not completed the same full-wire checks
    // as the available Chat entries, so they remain hidden for now.
    { id: "minimax-m2.5", label: "MiniMax M2.5", endpoint: "chat", supportsVision: false, status: "unavailable" },
    { id: "minimax-m2.7", label: "MiniMax M2.7", endpoint: "responses", supportsVision: false, contextWindow: 204800, contextSource: "vendor", status: "available" },
    { id: "minimax-m3", label: "MiniMax M3", endpoint: "chat", supportsVision: true, visionScore: 8, visionMaxScore: 9, visionTier: "strong", quota5h: 3200, speedTier: "fast", status: "unavailable" },
    { id: "qwen3.5-plus", label: "Qwen 3.5 Plus", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 3300, speedTier: "medium", status: "unavailable" },
    { id: "qwen3.6-plus", label: "Qwen 3.6 Plus", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 3300, speedTier: "slow", status: "unavailable" },
    { id: "qwen3.7-max", label: "Qwen 3.7 Max", endpoint: "chat", supportsVision: false, status: "unavailable" },
    { id: "qwen3.7-plus", label: "Qwen 3.7 Plus", endpoint: "chat", supportsVision: true, visionScore: 8, visionMaxScore: 9, visionTier: "strong", quota5h: 4300, speedTier: "medium", status: "unavailable" },
    { id: "qwen3.8-max", label: "Qwen 3.8 Max", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 160, speedTier: "medium", status: "unavailable" },
    // Console Go rejects a single oversized visual input above 983,616 bytes.
    // Keep the complete Codex/tool envelope below that measured cliff by
    // budgeting current-turn transport images to 320 KiB total. Canonical
    // originals remain in MediaStore; only the provider copy is reduced.
    { id: "qwen3.8-flash", label: "Qwen 3.8 Flash", endpoint: "chat", supportsVision: true, imageTransportMaxWireBytes: 320 * 1024, contextWindow: CONTEXT_WINDOW, contextSource: "fallback", status: "available" },
  ],

  modelCatalog({ mainModel, visionModel, baseInstructions }) {
    return modelCatalogDefaults({
      profileId: OPENCODE_GO_PROFILE.id,
      mainModel,
      // The same "Provider - Model" label the rest of the catalog uses, so the
      // main entry does not render differently in the App picker.
      displayName: `${OPENCODE_GO_PROFILE.label} - ${OPENCODE_GO_PROFILE.availableModels.find((m) => m.id === bareModelId(mainModel))?.label || mainModel}`,
      description: "OpenCode Go through the local ModelDock Responses gate.",
      compHash: "modeldock-opencode-go-v1",
      inputModalities: ["text", "image"],
      supportsSearchTool: false,
      baseInstructions,
      // Publish the whole curated catalog so every model is selectable from Codex's
      // own picker, not just the one the dashboard has selected.
      availableModels: OPENCODE_GO_PROFILE.availableModels,
    });
  },
};

const DEEPSEEK_OFFICIAL_PROFILE = {
  id: "deepseek-official",
  label: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  tokenEnvName: "DEEPSEEK_API_KEY",
  settingsField: "deepseekApiKey",
  settingsErrorCode: "invalid_deepseek_api_key",
  settingsInvalidMessage: "A valid DeepSeek API key is required.",
  modelDiscovery: true,
  discoveryTransports: new Set(["responses"]),

  blockedToolTypes: new Set([]),
  // The official DeepSeek API accepts every Codex local tool as type "function", so
  // forward all except tools useless to a text-only model: view_image (native "vision"
  // helper) is hidden because the model cannot interpret images - vision_inspect is the
  // gateway's text-model path for visuals. Native web_search stays (provider supports it).
  hiddenToolNames: new Set(["view_image"]),
  // Verified live (2026-08-04) against the real Codex tool set: the official Responses
  // API accepts every Codex local tool as long as it is declared type "function"
  // (shell_command, update_plan, mcp resources, request_user_input, view_image) and
  // namespaces natively - only the "custom" tool type is restricted to apply_patch
  // ("Unsupported custom tool: 'shell_command'. Only 'apply_patch' is supported.").
  // Hosted web_search is native too (echoed in the response tools list); tool_search is
  // silently ignored. So the same allowlist as opencode-go works, and nothing is blocked.
  availableModels: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", endpoint: "responses", supportsVision: false, acceptsImagesViaGateway: true, contextWindow: DEEPSEEK_CONTEXT_WINDOW, contextSource: "measured", supportedReasoningLevels: DEEPSEEK_REASONING_LEVELS, defaultReasoningLevel: "medium", reasoningSource: "measured", status: "available" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", endpoint: "responses", supportsVision: false, acceptsImagesViaGateway: true, contextWindow: DEEPSEEK_CONTEXT_WINDOW, contextSource: "measured", supportedReasoningLevels: DEEPSEEK_REASONING_LEVELS, defaultReasoningLevel: "medium", reasoningSource: "measured", status: "available" },
    // Declared so the row survives a restart: a discovered row is memory-only, so these
    // two disappeared on every boot until a refresh happened to add them back, and the
    // addressed-provider guard then answered 503 "endpoint was removed". No input
    // normalizer, because the official API takes replayed reasoning items as they are
    // (its measured V4 siblings carry none either).
    //
    // Not published as vision-capable even though DeepSeek documents it: this provider
    // already has a dedicated vision entry (deepseek-v4-flash-vision-exp below), and
    // declaring an unmeasured model as vision-capable would move the gateway's automatic
    // vision route without anyone asking. Vision for this slug stays unmeasured here.
    { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", endpoint: "responses", supportsVision: false, contextWindow: DEEPSEEK_CONTEXT_WINDOW, contextSource: "vendor", supportedReasoningLevels: DEEPSEEK_REASONING_LEVELS, defaultReasoningLevel: "medium", status: "available" },
    { id: "deepseek-flash", label: "DeepSeek Flash", endpoint: "responses", supportsVision: false, contextWindow: DEEPSEEK_CONTEXT_WINDOW, contextSource: "vendor", supportedReasoningLevels: DEEPSEEK_REASONING_LEVELS, defaultReasoningLevel: "medium", status: "available" },
    // DeepSeek's first vision model, announced 2026-08-21 and experimental by
    // its own name. It reads images through the same Responses endpoint the
    // other two use, so it needs no route of its own - only a published entry
    // that says it takes images.
    //
    // The window is the vendor's figure rather than ours: the pricing page
    // lists 1M for all three, and nothing here has measured this one. No
    // vision score either - that comes from running the evaluation, and an
    // invented number would rank it against models that earned theirs. Its
    // reasoning ladder is its sibling's, on the strength of DeepSeek saying
    // its text capabilities are on par with V4-Flash, which is a claim rather
    // than a measurement and is not marked as one.
    { id: "deepseek-v4-flash-vision-exp", label: "DeepSeek V4 Flash Vision Exp", endpoint: "responses", supportsVision: true, contextWindow: DEEPSEEK_CONTEXT_WINDOW, contextSource: "vendor", supportedReasoningLevels: DEEPSEEK_REASONING_LEVELS, defaultReasoningLevel: "medium", status: "available" },
  ],

  modelCatalog({ mainModel, baseInstructions }) {
    return modelCatalogDefaults({
      profileId: DEEPSEEK_OFFICIAL_PROFILE.id,
      mainModel,
      displayName: "DeepSeek",
      description: "DeepSeek Responses endpoint through ModelDock.",
      compHash: "modeldock-deepseek-official-v1",
      inputModalities: ["text"],
      supportsSearchTool: false,
      // Verified live (2026-08-04): the official API accepts reasoning effort in
      // { none, minimal, low, medium, high, xhigh, max } with thinking on by default
      // (effort null). The Go camp's low/high/max triple does not fit it.
      defaultReasoningLevel: "medium",
      supportedReasoningLevels: DEEPSEEK_REASONING_LEVELS,
      availableModels: DEEPSEEK_OFFICIAL_PROFILE.availableModels,
      baseInstructions,
    });
  },
};

// The user-configured endpoint profile (dashboard "Custom model" section). Empty
// until the Add flow writes MODELDOCK_CUSTOM_* into .env; applyCustomProfile()
// fills it at config load, so catalog building and per-model routing see the
// same model without any compile-time knowledge of the endpoint.
const CUSTOM_PROFILE = {
  id: "custom",
  label: "Custom",
  baseUrl: "",
  tokenEnvName: "MODELDOCK_CUSTOM_API_KEY",
  blockedToolTypes: new Set([]),
  hiddenToolNames: new Set([]),
  availableModels: [],
  modelCatalog({ mainModel, baseInstructions }) {
    return modelCatalogDefaults({
      profileId: CUSTOM_PROFILE.id,
      mainModel,
      displayName: "Custom endpoint",
      description: "User-configured custom Responses endpoint through ModelDock.",
      compHash: "modeldock-custom-v1",
      inputModalities: ["text", "image"],
      supportsSearchTool: false,
      baseInstructions,
      availableModels: CUSTOM_PROFILE.availableModels,
    });
  },
};

// The generic Local provider. Every keyless OpenAI-compatible origin the user
// attaches through the Local scan publishes one identity here, spelled
// "<provider>/<model>@local", so the picker carries a single Local group rather
// than one group per engine. Engine-specific profiles never enter the catalog.
//
// Routing is per model, like Custom: each custom-endpoints.json entry flagged
// local:true owns its host, dialect, real upstream id and optional key, and a
// request is matched to its entry by the published bare id.
const LOCAL_PROFILE = {
  id: "local",
  label: "Local",
  baseUrl: "",
  tokenEnvName: "",
  blockedToolTypes: new Set([]),
  hiddenToolNames: new Set([]),
  transport: "chat",
  availableModels: [],
  modelCatalog({ mainModel, baseInstructions }) {
    return modelCatalogDefaults({
      profileId: LOCAL_PROFILE.id,
      mainModel,
      displayName: "Local",
      description: "Local keyless OpenAI-compatible models through the ModelDock gate.",
      compHash: "modeldock-local-v1",
      inputModalities: ["text", "image"],
      supportsSearchTool: false,
      baseInstructions,
      availableModels: LOCAL_PROFILE.availableModels,
    });
  },
};

// The one lookup that owns "which endpoint serves this local model". Local
// entries share a file with the remote Custom ones, so the flag - not the file -
// decides the owner, and the profile's routing and its per-model target both
// read it here instead of filtering the list again.
function isLocalEndpoint(entry) {
  if (entry?.local !== true) return false;
  try { return isLoopbackHost(new URL(entry.baseUrl).hostname); }
  catch { return false; }
}

function localEndpointFor(config, model) {
  const bare = bareModelId(model);
  if (!bare) return null;
  return (config?.customEndpoints || [])
    .find((entry) => isLocalEndpoint(entry) && entry.modelId === bare) || null;
}

// Remote entries only. A local endpoint belongs to the Local profile, so Custom
// must not also answer for it - two providers publishing one address is the
// duplication this split removes.
export function remoteEndpoints(config) {
  return (config?.customEndpoints || []).filter((entry) => entry.local !== true);
}

// Grok through a Grok subscription rather than through metered API credits.
//
// It looks like a keyed provider from here - a bearer token on every request -
// but the token is minted by an OAuth device grant and expires in hours, so it
// lives in the auth snapshot and is refreshed onto config.tokens.xai. Nothing
// downstream needs to know the difference, which is the point of asking the
// profile rather than branching on the provider.
const XAI_PROFILE = {
  id: "xai",
  label: "xAI (Grok)",
  baseUrl: "https://api.x.ai/v1",
  modelDiscovery: true,
  discoveryTransports: new Set(["responses"]),
  // No environment variable: this credential cannot be pasted, only signed in
  // for, so an .env entry would be a place for a stale token to hide.
  tokenEnvName: "",
  // Codex only loads the catalog when apply_patch_tool_type is "freeform", but
  // xAI rejects the corresponding `custom` declaration. The gateway converts
  // that one declaration to a function for xAI and converts its calls back to
  // custom_tool_call before returning them to Codex, retaining apply_patch on
  // both sides of the bridge.
  blockedToolTypes: new Set(["custom"]),
  customToolsAsFunctions: new Set(["apply_patch"]),
  // Codex also emits generic namespace declarations (not only MCP ones).
  // xAI rejects the wrapper type, so flatten every child to a safe function
  // name and restore the original namespace on the response path.
  flattenAllNamespaces: true,
  safeNamespaceFunctionNames: true,
  // Grok runs these itself. Measured the same day: a request carrying
  // { type: "web_search" } and one carrying { type: "x_search" } both return
  // 200. The gate strips hosted tools by default because most upstreams have
  // none, and stripping these threw away search the subscription already pays
  // for and then paid Exa to do again.
  // Images use the explicit grok_image_gen connector. Do not leave a second,
  // implicit image-generation route in every Grok Responses request: it costs
  // tool context and makes the rendering provider ambiguous to the agent.
  hostedToolTypes: new Set(["web_search", "x_search"]),
  hiddenToolNames: new Set([]),
  // Every xAI model shares the same wire quirks, so the normalizers hang on
  // the profile rather than per model: names resolved against the gateway's
  // INPUT_NORMALIZERS / PAYLOAD_NORMALIZERS registries. The relay paths ask
  // the profile - they no longer match `provider === "xai"` by hand.
  inputNormalizer: "xai",
  payloadNormalizer: "xai",
  discoveryModel(id) {
    if (!xaiResponsesModel(id)) return null;
    return {
      id,
      label: id,
      endpoint: "responses",
      supportsVision: xaiModelSeesImages(id),
      ownerQualified: true,
      status: "available",
    };
  },
  availableModels: [],
  modelCatalog({ mainModel, baseInstructions }) {
    return modelCatalogDefaults({
      profileId: "xai",
      mainModel,
      displayName: "xAI (Grok)",
      description: "Grok models through a SuperGrok or X Premium subscription.",
      compHash: "modeldock-xai-v1",
      inputModalities: ["text", "image"],
      supportsSearchTool: true,
      baseInstructions,
      availableModels: XAI_PROFILE.availableModels,
    });
  },
};

// Command Code is a hosted, keyed provider in the same family as OpenCode Go:
// one Bearer credential, an OpenAI-shaped GET /models directory, and Chat
// Completions inference, which the existing Responses-to-Chat bridge already
// speaks. No new protocol work.
//
// Its directory deliberately mixes two dialects, and this is the measured
// boundary (2026-08-31): a Claude model on /chat/completions is refused with
// "Model \"claude-sonnet-5\" must be called via /provider/v1/messages (Anthropic
// Messages shape)." while deepseek/, Qwen/, xai/, google/ and the bare gpt-5.6
// ids all answer 200 with well-formed tool calls. Publishing the Claude half would
// ship the picker a model whose every request is a guaranteed 400, so the
// discovery filter leaves it out rather than inventing a Messages dialect we do
// not implement.
const COMMAND_CODE_MESSAGES_PREFIX = "claude-";
// Command Code's directory does not publish modalities, so discovery joins each
// id to a provider-specific capability ledger. Keep this exact rather than using
// a broad vendor regex: one family can expose visual and text-only routes side by
// side (DeepSeek Flash versus Vision Exp, Qwen 3.7 Plus versus Max, MiMo versus
// MiMo Pro). On 2026-08-31 the reachable entries were sent the same four-quadrant
// PNG through Command Code Chat. A positive entry either read those pixels,
// showed pixel evidence on an image-accepting route, or is a plan-gated sibling
// with the same published multimodal contract. Explicit image rejections stay
// out. New ids default to text-only until they have equivalent evidence.
const COMMAND_CODE_VISION_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "deepseek/deepseek-v4-flash-vision-exp",
  "deepseek/deepseek-v4.1-flash",
  "moonshotai/Kimi-K3",
  "moonshotai/Kimi-K2.7-Code",
  "moonshotai/Kimi-K2.7-Code-Highspeed",
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.5",
  "z-ai/glm-5.3-flash",
  "zai-org/GLM-5.2",
  "zai-org/GLM-5.2-Fast",
  "MiniMaxAI/MiniMax-M3",
  "xiaomi/mimo-v2.5",
  "Qwen/Qwen3.8-Max",
  "Qwen/Qwen3.8-27B",
  "Qwen/Qwen3.8-Flash",
  "Qwen/Qwen3.7-Plus",
  "Qwen/Qwen3.7-Flash",
  "Qwen/Qwen3.6-Max-Preview",
  "Qwen/Qwen3.6-Plus",
  "google/gemini-3.7-flash",
  "google/gemini-3.6-flash",
  "google/gemini-3.5-flash",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.1-flash-lite",
  "thinkingmachines/inkling",
  "thinkingmachines/inkling-small",
  "xai/grok-4.5",
  "xai/grok-4.6",
]);

function commandCodeModelSeesImages(id) {
  return COMMAND_CODE_VISION_MODELS.has(String(id || ""));
}

const COMMAND_CODE_PROFILE = {
  id: "commandcode",
  label: "Command Code",
  baseUrl: "https://api.commandcode.ai/provider/v1",
  tokenEnvName: "COMMANDCODE_API_KEY",
  settingsField: "commandcodeApiKey",
  settingsErrorCode: "invalid_commandcode_api_key",
  settingsInvalidMessage: "A valid Command Code API key is required.",
  modelDiscovery: true,
  // Chat only: Messages-dialect models are filtered out of discovery below.
  discoveryTransports: new Set(["chat"]),
  discoveryModel(id, entry) {
    const claude = String(id).startsWith(COMMAND_CODE_MESSAGES_PREFIX);
    // The directory publishes context_length per model. Use the vendor's own
    // number where it gives one, and fall back to the shared conservative window
    // where it does not - never a guessed larger value, because the window is
    // what Codex sizes its compaction threshold from.
    const published = Number(entry?.context_length) || 0;
    const supportsVision = commandCodeModelSeesImages(id);
    return {
      id,
      label: String(entry?.name || id),
      endpoint: claude ? "messages" : "chat",
      supportsVision,
      contextWindow: published || CONTEXT_WINDOW,
      contextSource: published ? "vendor" : "fallback",
      status: "available",
    };
  },
  availableModels: [],
  modelCatalog({ mainModel, baseInstructions }) {
    return modelCatalogDefaults({
      profileId: "commandcode",
      mainModel,
      displayName: "Command Code",
      description: "Command Code Provider API through ModelDock.",
      compHash: "modeldock-commandcode-v1",
      inputModalities: ["text"],
      supportsSearchTool: false,
      availableModels: COMMAND_CODE_PROFILE.availableModels,
      baseInstructions,
    });
  },
};

const PROFILES = Object.fromEntries([
  OPENCODE_GO_PROFILE,
  DEEPSEEK_OFFICIAL_PROFILE,
  CUSTOM_PROFILE,
  XAI_PROFILE,
  COMMAND_CODE_PROFILE,
  LOCAL_PROFILE,
].map((profile) => [profile.id, profile]));

// Everything a provider needs to answer about itself lives on the provider.
//
// This used to be five separate if-chains - in upstreamTargetFor, in
// upstreamBaseForModel, in visionEndpointFor, and in two probe helpers - each
// naming providers by hand. They disagreed: three of them had no case for a
// local endpoint, so a Local model resolved to opencode.ai, and a local vision
// model sent its image there. The table below is the only
// registry; a provider that is in it is reachable by construction, and adding
// one is adding an entry rather than remembering five call sites.
const trimBase = (value) => String(value || "").replace(/\/+$/, "");

// Defaults that fit a plain keyed HTTPS provider. A profile overrides only
// what genuinely differs for it, so the difference is what you read.
function defineRouting(profile, overrides = {}) {
  profile.keyless = Boolean(overrides.keyless);
  profile.local = Boolean(overrides.local);
  // An OpenAI-compatible server that did not write the Responses spec: llama.cpp,
  // vLLM, Ollama, and whatever a user points a custom endpoint at. They reject
  // payload shapes the first-party endpoints accept, so the relay normalises
  // before sending. Declared rather than inferred, because a hosted provider
  // could need it too and a local one might not.
  profile.normalizesPayload = Boolean(overrides.normalizesPayload);
  // The shape a provider's own keys take, checked at the write boundary so a
  // malformed key cannot reach the .env and resurface as a 401 wall after a
  // restart. Absent means the provider publishes no documented shape.
  profile.tokenPattern = overrides.tokenPattern || null;
  profile.tokenHint = overrides.tokenHint || "";
  profile.baseUrlFor = overrides.baseUrlFor
    || ((config) => trimBase(config?.[`${profile.id}BaseUrl`] || profile.baseUrl));
  profile.target = overrides.target
    || ((config, model) => ({
      provider: profile.id,
      model: bareModelId(model),
      url: `${profile.baseUrlFor(config, model)}/responses`,
      token: profile.keyless ? "" : (config?.tokens?.[profile.id] || ""),
      // A keyless provider must not be 503'd by the tokenless gate: it has no
      // credential to present, which is a property of the provider and not a
      // configuration mistake.
      ...(profile.keyless ? { tokenRequired: false } : {}),
    }));
  return profile;
}

defineRouting(OPENCODE_GO_PROFILE, {
  // Zen free-tier models are served by a different host than the paid Go
  // endpoint, under the same account and the same token.
  baseUrlFor(config, model) {
    const goBase = trimBase(config?.opencodeBaseUrl || OPENCODE_GO_PROFILE.baseUrl);
    // Directory discovery has no model. Only model-specific requests can
    // select the alternate Zen host; the provider directory belongs to Go.
    if (model == null) return goBase;
    const entry = modelEntryFor(config, bareModelId(model));
    // The name test is a fallback for a Zen model that is not in the catalog:
    // big-pickle is reachable but unregistered, so entry is undefined for it.
    const upstream = bareModelId(model);
    const zen = entry?.zen || upstream.endsWith("-free") || upstream === "big-pickle";
    return zen
      ? trimBase(config?.zenBaseUrl || "https://opencode.ai/zen/v1")
      : goBase;
  },
  target(config, model) {
    const upstream = bareModelId(model);
    const entry = modelEntryFor(config, upstream);
    const transport = entry?.endpoint === "chat" ? "chat" : "responses";
    return {
      provider: OPENCODE_GO_PROFILE.id,
      model: upstream,
      url: `${OPENCODE_GO_PROFILE.baseUrlFor(config, model)}/${transport === "chat" ? "chat/completions" : "responses"}`,
      transport,
      token: config?.tokens?.[OPENCODE_GO_PROFILE.id] || "",
      // Zen free tier: failure copy should carry free-tier guidance instead of
      // the generic hint (see error-translation.mjs FREE_HINTS).
      free: Boolean(entry?.free),
    };
  },
});

defineRouting(XAI_PROFILE, {
  baseUrlFor: () => trimBase(XAI_PROFILE.baseUrl),
});

// Every Command Code model is a Chat Completions model: declaring the transport
// here is what makes the relay take the existing Responses-to-Chat bridge instead
// of sending Responses at an endpoint that only answers chat. The base URL comes
// from defineRouting's default, so a test or a redirected install can still move
// it through config without a second env knob being invented for it.
defineRouting(COMMAND_CODE_PROFILE, {
  tokenPattern: /^user_/,
  tokenHint: "A Command Code Provider API key must start with user_ (create one at https://commandcode.ai/provider).",
  target: (config, model) => ({
    provider: COMMAND_CODE_PROFILE.id,
    model: bareModelId(model),
    url: `${COMMAND_CODE_PROFILE.baseUrlFor(config, model)}/chat/completions`,
    transport: "chat",
    token: config?.tokens?.[COMMAND_CODE_PROFILE.id] || "",
  }),
});

defineRouting(DEEPSEEK_OFFICIAL_PROFILE, {
  tokenPattern: /^sk-/,
  tokenHint: "A DeepSeek API key must start with sk- (create one at https://platform.deepseek.com/api_keys).",
  baseUrlFor: (config) => trimBase(config?.deepseekBaseUrl || DEEPSEEK_OFFICIAL_PROFILE.baseUrl),
  target: (config, model) => ({
    provider: DEEPSEEK_OFFICIAL_PROFILE.id,
    model: bareModelId(model),
    url: `${DEEPSEEK_OFFICIAL_PROFILE.baseUrlFor(config)}/responses`,
    token: config?.tokens?.[DEEPSEEK_OFFICIAL_PROFILE.id] || "",
  }),
});

function customWireTarget(config, model) {
  const endpoint = customEndpointFor(remoteEndpoints(config), model);
  const transport = endpoint?.transport === "chat" ? "chat" : "responses";
  const baseUrl = trimBase(endpoint?.baseUrl || "");
  return {
    provider: CUSTOM_PROFILE.id,
    model: endpoint?.upstreamId || bareModelId(model),
    url: `${baseUrl}/${transport === "chat" ? "chat/completions" : "responses"}`,
    transport,
    token: endpoint?.apiKey || "",
  };
}

defineRouting(CUSTOM_PROFILE, {
  normalizesPayload: true,
  // One profile, many endpoints: each model can sit on a different host with
  // its own key, so the lookup is per model rather than per provider. Nothing
  // outside this profile needs to know that.
  baseUrlFor: (config, model) => trimBase(customEndpointFor(remoteEndpoints(config), model)?.baseUrl || ""),
  target: (config, model) => customWireTarget(config, model),
});

// Scan-attached Local endpoints keep the host, dialect and real upstream id per
// model, exactly as Custom does. `cachePrompt` follows the dialect:
// llama.cpp's chat template keeps a prompt-cache prefix per conversation, and
// the Responses path has no equivalent field to set.
defineRouting(LOCAL_PROFILE, {
  keyless: true,
  local: true,
  normalizesPayload: true,
  baseUrlFor: (config, model) => trimBase(localEndpointFor(config, model)?.baseUrl || ""),
  target: (config, model) => {
    const entry = localEndpointFor(config, model);
    const transport = entry?.transport === "chat" ? "chat" : "responses";
    return {
      provider: LOCAL_PROFILE.id,
      // The published id is "<provider>/<model>"; the endpoint answers to the
      // id it advertised, which the attach flow persisted separately.
      model: entry?.upstreamId || bareModelId(model),
      url: `${trimBase(entry?.baseUrl || "")}/${transport === "chat" ? "chat/completions" : "responses"}`,
      transport,
      token: entry?.apiKey || "",
      tokenRequired: false,
      cachePrompt: transport === "chat",
      completeOnFinishReason: entry?.completeOnFinishReason === true,
      toolArgumentsAsObjects: Boolean(entry?.chatTemplateSupportsObjectArguments),
      mediaMarker: typeof entry?.mediaMarker === "string" ? entry.mediaMarker : "",
    };
  },
});

export function profileById(id) {
  return PROFILES[id] || null;
}

// Resolve the complete provider-owned request target once. Every caller - main
// relay, compaction, and delegated vision - consumes this same projection.
export function upstreamTargetFor(config, model) {
  const provider = providerForModel(config, model);
  const profile = profileById(provider);
  if (profile) {
    return {
      baseUrl: profile.baseUrlFor?.(config, model) || "",
      ...profile.target(config, model),
    };
  }
  return {
    provider,
    model: bareModelId(model),
    baseUrl: "",
    url: "",
    transport: "responses",
    token: "",
    tokenRequired: true,
  };
}

// Every registered profile, for passes that have to touch all of them
// (the context-window overrides) rather than one by id.
export function allProfiles() {
  return Object.values(PROFILES);
}

export function profileOptions() {
  return Object.values(PROFILES).map((profile) => ({ id: profile.id, label: profile.label }));
}

export function credentialProfiles() {
  return allProfiles().filter((profile) => profile.tokenEnvName && profile.settingsField);
}

export function routedModelInventory() {
  const inventory = [];
  for (const profile of Object.values(PROFILES)) {
    for (const model of profile.availableModels || []) {
      if (!model?.id) continue;
      inventory.push({
        id: modelAddressFor(profile.id, model),
        codexSlug: codexSlugFor(profile.id, model),
        provider: profile.id,
        providerLabel: profile.label,
        model,
      });
    }
  }
  return inventory;
}

// Provider availability is a registry fact. Catalog, pickers and routing
// controls must ask this one function rather than inferring keyless operation
// from unrelated metadata such as an empty tokenEnvName.
export function providerRouteConfigured(config, providerId) {
  const profile = PROFILES[providerId];
  if (!profile?.availableModels?.length) return false;
  if (profile.keyless) return true;
  return profile.availableModels.some((model) => {
    const target = upstreamTargetFor(config, modelAddressFor(providerId, model.id));
    return Boolean(target.token) || target.tokenRequired === false;
  });
}

export function enabledProviderOptions(config) {
  // The active profile is not itself proof of availability. OpenCode Go's
  // Codex-config fallback is already resolved into config.tokens during load;
  // publishing an unconfigured active profile kept disconnected static models
  // routable after its credential had been removed.
  return profileOptions().filter((entry) => providerRouteConfigured(config, entry.id));
}

// Remote entries in the endpoint file belong to Custom. Local entries in that
// same file belong to Local. Each profile is a one-way projection of the same
// persisted list, so the catalog and routing cannot disagree about ownership.
export function applyCustomProfile(config) {
  const endpoints = remoteEndpoints(config);
  CUSTOM_PROFILE.baseUrl = endpoints[0]?.baseUrl || "";
  CUSTOM_PROFILE.availableModels = endpoints.map((entry) => {
    const advertised = localContextWindow(entry.contextWindow || undefined);
    return {
      id: entry.modelId,
      label: entry.modelId,
      endpoint: entry.transport === "chat" ? "chat" : "responses",
      supportsVision: Boolean(entry.supportsVision),
      ...(advertised ? { contextWindow: advertised } : {}),
      ...(entry.contextWindow ? { contextSource: "vendor" } : {}),
      supportedReasoningLevels: LOCAL_REASONING_LEVELS,
      defaultReasoningLevel: "xhigh",
      reasoningSource: "measured",
      ownerQualified: true,
      status: "available",
    };
  });
  return CUSTOM_PROFILE;
}

// Populate the Local profile from the scan-attached endpoints. Applied at config
// load and after every attach so the catalog, the picker and per-model routing
// see one Local group across restarts without re-probing a machine that may be
// offline now. Empty list clears the profile, which is what makes an install
// with no scanned endpoint behave exactly as it did before the profile existed.
export function applyLocalProfile(config) {
  const endpoints = (config?.customEndpoints || []).filter(isLocalEndpoint);
  LOCAL_PROFILE.availableModels = endpoints.filter((entry) => entry.modelId).map((entry) => {
    const advertised = localContextWindow(entry.contextWindow || undefined);
    return {
      id: entry.modelId,
      // The friendly "provider / model" label the attach flow persisted; the
      // published id stays the machine-safe "<provider>/<model>".
      label: entry.label || entry.modelId,
      endpoint: entry.transport === "chat" ? "chat" : "responses",
      supportsVision: Boolean(entry.supportsVision),
      ...(advertised ? { contextWindow: advertised } : {}),
      ...(entry.contextWindow ? { contextSource: "vendor" } : {}),
      supportedReasoningLevels: LOCAL_REASONING_LEVELS,
      defaultReasoningLevel: "xhigh",
      reasoningSource: "measured",
      ownerQualified: true,
      status: "available",
    };
  });
  return LOCAL_PROFILE;
}

// Publish what the signed-in subscription can reach. The list is captured at
// sign-in and replayed from the snapshot on every boot, so a restart never has
// to contact xAI before the pickers are correct.
// Which Grok models read images. /v1/models says only that a model exists, so
// this is measured rather than asked for: on 2026-08-21 a 32x32 crimson PNG
// sent to api.x.ai/v1/responses came back "red" from grok-4.5, grok-4.3,
// grok-4.6 and grok-4.20-0309-non-reasoning. Every one of them had been
// published as text-only, which is worse than it sounds - a text-only entry is
// never offered as a vision model AND carries the instruction telling it to
// hand images to something else, so a subscription that can see was being
// asked to pay another model to look.
//
// The grok-4 family is what was measured, so it is what this claims. Other
// Responses models stay text-only until they have been through the same test.
function xaiModelSeesImages(id) {
  return /^grok-4[.\-]/.test(String(id || ""));
}

// Imagine's media model ids are returned by /v1/models alongside language
// models, but they are not Responses chat models. Images are generated by
// Grok 4.6's hosted image_generation tool; videos use their asynchronous
// /v1/videos API. Publishing either as a normal Codex model makes the picker
// send a Responses request that xAI cannot fulfil.
function xaiResponsesModel(id) {
  return !/^grok-imagine-(?:image|video)(?:-|$)/.test(String(id || ""));
}

export function applyXaiProfile(models) {
  XAI_PROFILE.availableModels = (Array.isArray(models) ? models : [])
    .filter((id) => typeof id === "string" && id && xaiResponsesModel(id))
    .map((id) => ({
      id,
      label: id,
      endpoint: "responses",
      // xAI does not publish per-model context windows on /v1/models, and a
      // number invented here would be worse than the catalog default that
      // every unmeasured model already uses.
      supportsVision: xaiModelSeesImages(id),
      ownerQualified: true,
      status: "available",
    }));
  return XAI_PROFILE;
}

// The internal routed address remains readable and stable in preferences,
// usage rollups and diagnostics. It is not the Codex-facing slug; catalog
// construction encodes that address with codexSlugFor above.
// The profile whose ids are published bare, so ids already written into Codex configs
// keep resolving without a suffix.
export const DEFAULT_PROFILE_ID = "opencode-go";

// The canonical internal address. A bare id survives only as a legacy reference
// and routes to the default provider (see providerForModel). Codex-facing code
// must call codexSlugFor instead of exposing this storage/routing representation.
export function routedModelRefFor(profileId, model) {
  const id = typeof model === "string" ? model : model?.id;
  if (!id) return model;
  const pid = profileId || DEFAULT_PROFILE_ID;
  const owned = PROFILES[pid]?.availableModels?.some((candidate) => candidate.id === id);
  return owned ? modelAddressFor(pid, id) : id;
}

export function bareModelId(model) {
  const parts = modelRefParts(model);
  return parts.qualified ? parts.model : model;
}

export function providerForModel(config, model) {
  if (!model) return config?.profileId || DEFAULT_PROFILE_ID;
  // An explicit owner in the slug outranks every heuristic below.
  const parts = modelRefParts(model);
  if (parts.qualified) return parts.provider;
  // Bare id: legacy compatibility only. Bare ids were never published by any
  // provider other than the default one, so a bare id left over from an older
  // config or a stored thread selection routes there unconditionally instead of
  // to the currently active profile - the picker label and the billing source
  // must never disagree.
  return DEFAULT_PROFILE_ID;
}

// Resolve the curated model entry (label, endpoint, zen flag, vision metadata) for a
// bare model id. Used by the gateway to pick the upstream base URL per model.
export function modelEntryFor(config, model) {
  const provider = providerForModel(config, model);
  const bare = bareModelId(model);
  const owned = PROFILES[provider]?.availableModels?.find((entry) => entry.id === bare);
  if (owned) return owned;
  // The address owner is authoritative. Falling through to config.profile here
  // made metadata and routing disagree: a bare or misspelled id could borrow an
  // entry from the active profile while providerForModel still sent it to the
  // default provider. Dynamic profiles must register before this lookup.
  return null;
}

// The window a model actually runs with. Most catalog entries leave
// contextWindow unset and inherit CONTEXT_WINDOW - the catalog has always
// applied that fallback (see modelCatalogDefaults), so anything reporting a
// model's context has to apply it too or it under-reports every model that
// did not need an override.
export function effectiveContextWindow(model) {
  return Number(model?.contextWindow) > 0 ? Number(model.contextWindow) : CONTEXT_WINDOW;
}

export { codexSlugFor, modelAddressFor, modelRefParts } from "./model-ref.mjs";

export function tokenFor(config, model) {
  const provider = providerForModel(config, model);
  const profile = PROFILES[provider];
  if (!profile) return "";
  // A keyless provider has no credential to look up; "local" is a sentinel
  // that keeps the healthz and readiness gates honest about a connected
  // engine being usable. Not connected means not ready, same as no token.
  if (profile.keyless) return profile.availableModels?.length ? "local" : "";
  return upstreamTargetFor(config, model).token || "";
}

export { OPENCODE_GO_PROFILE, DEEPSEEK_OFFICIAL_PROFILE, XAI_PROFILE };
