import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { parseSseData } from "./sse.mjs";
import { collaborationEnvelopeTurn, itemPlainText, partPlainText } from "./subagent-guidance.mjs";

export class LocalChatBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalChatBridgeError";
    this.code = code;
  }
}

function escapeMediaMarkerText(value, mediaMarker = "") {
  if (typeof value !== "string" || !mediaMarker || !value.includes(mediaMarker)) return value;
  // llama.cpp's multimodal tokenizer scans ordinary prompt text for this
  // runtime-specific sentinel. Keep literal diagnostic/tool text readable to
  // the model while breaking that out-of-band media control sequence.
  return value.split(mediaMarker).join(`<\u200b${mediaMarker.slice(1)}`);
}

function escapeMediaMarkerValue(value, mediaMarker = "") {
  if (typeof value === "string") return escapeMediaMarkerText(value, mediaMarker);
  if (Array.isArray(value)) return value.map((part) => escapeMediaMarkerValue(part, mediaMarker));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, escapeMediaMarkerValue(part, mediaMarker)]));
}

function textValue(value, mediaMarker = "") {
  if (typeof value === "string") return escapeMediaMarkerText(value, mediaMarker);
  if (value === null || value === undefined) return "";
  return escapeMediaMarkerText(JSON.stringify(value), mediaMarker);
}

function instructionText(instructions, mediaMarker = "") {
  if (typeof instructions === "string") return escapeMediaMarkerText(instructions, mediaMarker);
  if (!Array.isArray(instructions)) return "";
  return instructions.map((part) => typeof part?.text === "string" ? escapeMediaMarkerText(part.text, mediaMarker) : "").filter(Boolean).join("\n");
}

// Chat carries text, images, and tool calls; Codex's Requests carry more shapes
// than that, and it invents new ones faster than this bridge can learn them.
// `notes` collects what had to be folded so the caller can say so out loud
// (metrics, and one log line) - the alternative used to be a 502 that killed the
// turn and told the user nothing about which item was at fault.
function chatContent(content, itemType = "message", mediaMarker = "", notes = null) {
  if (typeof content === "string") return escapeMediaMarkerText(content, mediaMarker);
  if (content === null || content === undefined) return "";
  if (!Array.isArray(content)) {
    // Not a content array at all. Reading it as text is lossy; failing the turn
    // is worse, and the shape still belongs in the log.
    notes?.push(`${itemType} content (not an array)`);
    return textValue(content, mediaMarker);
  }
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (["input_text", "output_text", "text", "reasoning_text"].includes(part.type) && typeof part.text === "string") {
      parts.push({ type: "text", text: escapeMediaMarkerText(part.text, mediaMarker) });
      continue;
    }
    if (part.type === "input_image") {
      // Codex sends the Responses dialect (a bare string) and history that has
      // already passed a Chat round trip carries the object form. Accept either.
      const url = typeof part.image_url === "string"
        ? part.image_url
        : (typeof part.image_url?.url === "string" ? part.image_url.url : "");
      if (url) {
        parts.push({ type: "image_url", image_url: { url } });
        continue;
      }
    }
    const text = partPlainText(part);
    if (text) {
      parts.push({ type: "text", text: escapeMediaMarkerText(text, mediaMarker) });
      continue;
    }
    // A part this transport cannot carry (a file, an audio clip, a type newer
    // than this build). Say so in the history instead of pretending it was not
    // there: the model can then tell the user what it could not read.
    const name = typeof part.filename === "string" && part.filename
      ? part.filename
      : (typeof part.file_id === "string" && part.file_id ? part.file_id : "");
    parts.push({
      type: "text",
      text: escapeMediaMarkerText(`[${String(part.type || "part")}${name ? `: ${name}` : ""} - not carried to this model]`, mediaMarker),
    });
    notes?.push(`content part ${String(part.type || "unknown")}`);
  }
  if (parts.every((part) => part.type === "text")) return parts.map((part) => part.text).join("\n");
  return parts;
}

function chatTools(tools, mediaMarker = "", notes = null) {
  if (!Array.isArray(tools)) return { tools: [], customToolNames: new Set() };
  const customToolNames = new Set();
  const converted = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "function" && typeof tool.name === "string" && tool.name) {
      converted.push({
        type: "function",
        function: {
          name: tool.name,
          ...(typeof tool.description === "string" && tool.description ? { description: escapeMediaMarkerText(tool.description, mediaMarker) } : {}),
          parameters: escapeMediaMarkerValue(tool.parameters || tool.inputSchema || { type: "object", properties: {}, additionalProperties: false }, mediaMarker),
          ...(tool.strict === true ? { strict: true } : {}),
        },
      });
      continue;
    }
    if (tool.type === "custom" && typeof tool.name === "string" && tool.name) {
      customToolNames.add(tool.name);
      converted.push({
        type: "function",
        function: {
          name: tool.name,
          description: escapeMediaMarkerText(tool.description || `Run the ${tool.name} tool using its exact input.`, mediaMarker),
          parameters: {
            type: "object",
            properties: { input: { type: "string", description: "Exact input for the original custom tool." } },
            required: ["input"],
            additionalProperties: false,
          },
        },
      });
      continue;
    }
    // A tool descriptor this transport has no equivalent for (a provider-owned
    // builtin, or a type newer than this build). Declaring it is impossible and
    // failing the turn helps nobody: leave it out so the model answers with the
    // tools it can see, and record that we did.
    notes?.push(`tool type ${String(tool.type || "unknown")}`);
  }
  return { tools: converted, customToolNames };
}

function chatToolChoice(value) {
  if (!value || typeof value === "string") return value;
  if (value.type === "function" && typeof value.name === "string") {
    return { type: "function", function: { name: value.name } };
  }
  if (value.type === "function" && typeof value.function?.name === "string") return value;
  return undefined;
}

function objectToolArguments(value) {
  const source = typeof value === "string" ? value : textValue(value);
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new LocalChatBridgeError("tool_arguments", "The local Chat template requires function arguments to be a JSON object.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LocalChatBridgeError("tool_arguments", "The local Chat template requires function arguments to be a JSON object.");
  }
  return parsed;
}

// Returns null for a call that cannot be paired at all - Chat has no place for a
// tool call with no id or no name, and the caller folds its text into an ordinary
// turn rather than failing the request over one malformed history item.
function toolCallItem(item, { toolArgumentsAsObjects = false, mediaMarker = "", notes = null } = {}) {
  const callId = item.call_id || item.id;
  if (typeof callId !== "string" || !callId) return null;
  if (typeof item.name !== "string" || !item.name) return null;
  const argumentsValue = item.type === "custom_tool_call"
    ? { input: typeof item.input === "string" ? item.input : textValue(item.input ?? "") }
    : item.arguments ?? item.input ?? {};
  const argumentsText = typeof argumentsValue === "string" ? argumentsValue : textValue(argumentsValue, mediaMarker);
  let args = escapeMediaMarkerText(argumentsText, mediaMarker);
  if (toolArgumentsAsObjects) {
    try {
      args = escapeMediaMarkerValue(objectToolArguments(argumentsValue), mediaMarker);
    } catch {
      // This template wants a decoded object and this call's arguments are not
      // JSON. Send the string shape every other dialect uses: the call still
      // reads, and the note records that the template got the weaker form.
      notes?.push(`tool arguments for ${item.name} are not a JSON object`);
    }
  }
  return {
    id: callId,
    type: "function",
    function: { name: item.name, arguments: args },
  };
}

function reasoningContent(item, mediaMarker = "") {
  const summary = Array.isArray(item.summary)
    ? item.summary.map((part) => typeof part?.text === "string" ? escapeMediaMarkerText(part.text, mediaMarker) : "").filter(Boolean).join("\n")
    : "";
  const content = chatContent(item.content || [], "reasoning", mediaMarker);
  const text = typeof content === "string" ? content : "";
  return text || summary;
}

export function responsesToChat(payload, { toolArgumentsAsObjects = false, mediaMarker = "", cachePrompt = true } = {}) {
  if (!payload || !Array.isArray(payload.input)) {
    throw new LocalChatBridgeError("input", "Local Chat bridge needs a Responses input array.");
  }
  const messages = [];
  const instructions = instructionText(payload.instructions, mediaMarker);
  if (instructions) messages.push({ role: "system", content: instructions });
  let pendingAssistant = null;
  const assistant = () => {
    if (!pendingAssistant) pendingAssistant = { role: "assistant", content: null };
    return pendingAssistant;
  };
  const flushAssistant = () => {
    if (!pendingAssistant) return;
    if (!pendingAssistant.tool_calls?.length) delete pendingAssistant.tool_calls;
    if (!pendingAssistant.reasoning_content) delete pendingAssistant.reasoning_content;
    messages.push(pendingAssistant);
    pendingAssistant = null;
  };
  // A Codex item that has no Chat equivalent - a collaboration envelope, a tool
  // shape newer than this build, an orphan call - joins the transcript as a
  // labeled user turn carrying whatever is readable in it, and `degraded` names
  // the shape so the relay can record it. Throwing here used to answer the user
  // with "Local Chat bridge cannot encode input item <type>" and no turn at all:
  // one unread item ended every chat-transport session that had ever exchanged a
  // message between agents. Keeping is better than dropping, and dropping is
  // better than failing, but neither is allowed to be silent.
  // This is the transport half of a deliberate pair: the input contract already
  // repairs pairing before any provider validates it (promoteDeliveredToolOutputs
  // and dropUnpairedToolItems in gateway.mjs). That pass cannot see a shape it does
  // not know, so this one owns the rest; neither is redundant.
  const degraded = [];
  // `note` is what the relay records. An empty note marks a fold that is the
  // intended encoding of a Codex shape - a collaboration envelope - rather than a
  // loss this build had to accept, so an ordinary multi-agent session does not
  // read as a degraded one.
  const foldItem = (item, label, note = label) => {
    if (note) degraded.push(note);
    // Readable text from any of the three places Codex keeps it: content/summary
    // parts, a tool result, or the arguments of the call itself.
    const argumentsValue = item.type === "custom_tool_call" ? item.input : (item.arguments ?? item.input);
    const body = itemPlainText(item)
      || (item.output === undefined || item.output === null ? "" : textValue(item.output, mediaMarker))
      || (typeof argumentsValue === "string" ? argumentsValue : argumentsValue === undefined || argumentsValue === null ? "" : textValue(argumentsValue, mediaMarker));
    if (!body) return;
    flushAssistant();
    messages.push({ role: "user", content: escapeMediaMarkerText(`[${label}]\n${body}`, mediaMarker) });
  };
  for (const item of payload.input) {
    if (!item || typeof item !== "object") continue;
    if (["function_call", "custom_tool_call"].includes(item.type)) {
      const call = toolCallItem(item, { toolArgumentsAsObjects, mediaMarker, notes: degraded });
      if (!call) {
        foldItem(item, `unpaired ${item.type}${item.name ? ` ${item.name}` : ""}`);
        continue;
      }
      const next = assistant();
      if (!next.tool_calls) next.tool_calls = [];
      next.tool_calls.push(call);
      continue;
    }
    if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
      flushAssistant();
      const callId = item.call_id || item.id;
      if (typeof callId !== "string" || !callId) {
        foldItem(item, `unpaired ${item.type}`);
        continue;
      }
      messages.push({ role: "tool", tool_call_id: callId, content: textValue(item.output, mediaMarker) });
      continue;
    }
    if (item.type === "message") {
      const role = item.role === "developer" ? "system" : item.role;
      const content = chatContent(item.content, "message", mediaMarker, degraded);
      if (role !== "system" && role !== "user" && role !== "assistant") {
        // A role this transport does not have is still somebody's turn: keep the
        // content, and keep the role visible in the text.
        degraded.push(`message role ${String(item.role || "unknown")}`);
        flushAssistant();
        const roleLabel = escapeMediaMarkerText(`[${String(item.role || "unknown")}]`, mediaMarker);
        messages.push({
          role: "user",
          content: Array.isArray(content)
            ? [{ type: "text", text: roleLabel }, ...content]
            : `${roleLabel} ${content}`,
        });
        continue;
      }
      if (role === "assistant") {
        const next = assistant();
        next.content = next.content === null || next.content === undefined
          ? content
          : typeof next.content === "string" && typeof content === "string"
            ? `${next.content}\n${content}`
            : content;
      } else {
        flushAssistant();
        messages.push({ role, content });
      }
      continue;
    }
    if (item.type === "reasoning") {
      const reasoning = reasoningContent(item, mediaMarker);
      if (reasoning) {
        const next = assistant();
        next.reasoning_content = next.reasoning_content ? `${next.reasoning_content}\n${reasoning}` : reasoning;
      }
      continue;
    }
    if (item.type === "agent_message") {
      // Codex collaboration envelope: one agent addressing another. Chat has no such
      // item type, so the turn joins the history as a labeled user message - rendered by
      // the single owner in subagent-guidance, which is also what the input contract
      // applies before this bridge ever sees the item. Author and recipient are carried
      // verbatim; a body that stayed opaque after the relay gate drops out instead of
      // being guessed.
      const envelope = collaborationEnvelopeTurn(item);
      if (!envelope) continue;
      flushAssistant();
      messages.push({
        role: "user",
        content: escapeMediaMarkerText(envelope.content[0].text, mediaMarker),
      });
      continue;
    }
    // The bracket keeps the type the model can repeat back; the note keeps the
    // reason a reader of the metrics needs.
    foldItem(item, String(item.type || "unknown"), `unsupported item ${String(item.type || "unknown")}`);
  }
  flushAssistant();
  const convertedTools = chatTools(payload.tools, mediaMarker, degraded);
  const chat = {
    model: payload.model,
    messages,
    stream: payload.stream === true,
    ...(Number.isSafeInteger(payload.id_slot) && payload.id_slot >= 0 ? { id_slot: payload.id_slot } : {}),
    ...(convertedTools.tools.length ? { tools: convertedTools.tools } : {}),
    ...(chatToolChoice(payload.tool_choice) ? { tool_choice: chatToolChoice(payload.tool_choice) } : {}),
    ...(payload.parallel_tool_calls !== undefined ? { parallel_tool_calls: payload.parallel_tool_calls } : {}),
    ...(Number.isFinite(payload.max_output_tokens) ? { max_tokens: payload.max_output_tokens } : {}),
    ...(Number.isFinite(payload.temperature) ? { temperature: payload.temperature } : {}),
    ...(Number.isFinite(payload.top_p) ? { top_p: payload.top_p } : {}),
    ...(Number.isFinite(payload.seed) ? { seed: payload.seed } : {}),
    ...(payload.stop !== undefined ? { stop: payload.stop } : {}),
    ...(payload.chat_template_kwargs && typeof payload.chat_template_kwargs === "object" ? { chat_template_kwargs: payload.chat_template_kwargs } : {}),
    ...(cachePrompt ? { cache_prompt: true } : {}),
    ...(payload.stream === true ? { stream_options: { include_usage: true } } : {}),
  };
  return { payload: chat, customToolNames: convertedTools.customToolNames, degraded };
}

function responseUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens);
  const output = Number(usage.completion_tokens ?? usage.output_tokens);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return undefined;
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens);
  const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens);
  return {
    ...(Number.isFinite(input) ? { input_tokens: input } : {}),
    ...(Number.isFinite(output) ? { output_tokens: output } : {}),
    ...(Number.isFinite(input) && Number.isFinite(output) ? { total_tokens: input + output } : {}),
    ...(Number.isFinite(cached) ? { input_tokens_details: { cached_tokens: cached } } : {}),
    ...(Number.isFinite(reasoning) ? { output_tokens_details: { reasoning_tokens: reasoning } } : {}),
  };
}

// llama.cpp reports model-internal prompt/decode work in the terminal Chat
// chunk. Keep one normalized representation for diagnostics and the managed
// host monitor; never infer this work from gateway wall time.
export function normalizeLlamaServerTimings(value) {
  if (!value || typeof value !== "object") return undefined;
  const metric = (field) => {
    const number = Number(value[field]);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  };
  const cacheTokens = metric("cache_n");
  const promptTokens = metric("prompt_n");
  const promptMs = metric("prompt_ms");
  const decodeTokens = metric("predicted_n");
  const decodeMs = metric("predicted_ms");
  const reportedPromptTps = metric("prompt_per_second");
  const reportedDecodeTps = metric("predicted_per_second");
  if (!cacheTokens && !promptTokens && !promptMs && !decodeTokens && !decodeMs) return undefined;
  return Object.freeze({
    cacheTokens,
    promptTokens,
    promptMs,
    promptTps: reportedPromptTps || (promptTokens > 0 && promptMs > 0 ? (promptTokens * 1000) / promptMs : 0),
    decodeTokens,
    decodeMs,
    decodeTps: reportedDecodeTps || (decodeTokens > 0 && decodeMs > 0 ? (decodeTokens * 1000) / decodeMs : 0),
  });
}

export function chatReasoningText(message) {
  if (!message || typeof message !== "object") return "";
  for (const field of ["reasoning_content", "reasoning", "reasoning_text"]) {
    if (typeof message[field] === "string" && message[field]) return message[field];
  }
  return "";
}

const RESPONSE_ITEM_PREFIX = new Map([
  ["message", "msg"],
  ["reasoning", "rs"],
  ["function_call", "fc"],
  ["custom_tool_call", "ctc"],
]);

function responseItemId(type, identity) {
  const prefix = RESPONSE_ITEM_PREFIX.get(type);
  const id = String(identity || "item");
  if (!prefix || id.startsWith(`${prefix}_`)) return id;
  return `${prefix}_${createHash("sha256").update(`${type}\0${id}`).digest("hex").slice(0, 48)}`;
}

function normalizeResponseItemId(item, identity = item?.call_id || item?.id) {
  const id = responseItemId(item?.type, identity);
  return id === item?.id ? item : { ...item, id };
}

function responseReasoningItem(id, content, status = "completed") {
  return {
    id: responseItemId("reasoning", id),
    type: "reasoning",
    status,
    summary: [],
    content: content ? [{ type: "reasoning_text", text: String(content) }] : [],
    // Codex has already proven that it persists and replays this local
    // Responses shape. The reasoning itself stays in content; the empty field
    // only preserves the standard reasoning-item contract used by Codex.
    encrypted_content: "",
  };
}

function responseMessageItem(id, content) {
  return {
    id: responseItemId("message", id),
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: String(content || "") }],
  };
}

function responseFunctionItem(id, toolCall) {
  const callId = toolCall.id || id;
  return {
    id: responseItemId("function_call", callId),
    type: "function_call",
    status: "completed",
    call_id: callId,
    name: toolCall.function?.name || "",
    arguments: typeof toolCall.function?.arguments === "string" ? toolCall.function.arguments : textValue(toolCall.function?.arguments || {}),
  };
}

function incompleteDetails(finishReason) {
  if (finishReason === "length") return { reason: "max_output_tokens" };
  if (finishReason === "content_filter") return { reason: "content_filter" };
  return undefined;
}

function terminalResponse({ id, created, model, output, usage, finishReason }) {
  const incomplete = incompleteDetails(finishReason);
  return {
    id,
    object: "response",
    created_at: created,
    model,
    status: incomplete ? "incomplete" : "completed",
    output,
    ...(incomplete ? { incomplete_details: incomplete } : {}),
    ...(usage ? { usage } : {}),
  };
}

export function chatCompletionToResponse(chat, { restoreCall = (item) => item } = {}) {
  if (!chat || typeof chat !== "object") throw new LocalChatBridgeError("chat_response", "Local Chat bridge received an invalid Chat completion.");
  const message = chat.choices?.[0]?.message || {};
  const id = typeof chat.id === "string" && chat.id ? chat.id : `resp_local_${Date.now()}`;
  const output = [];
  const reasoning = chatReasoningText(message);
  if (reasoning) output.push(responseReasoningItem(`${id}-reasoning`, reasoning));
  if (typeof message.content === "string" && message.content) output.push(responseMessageItem(`${id}-message`, message.content));
  for (let index = 0; index < (message.tool_calls || []).length; index += 1) {
    output.push(normalizeResponseItemId(
      restoreCall(responseFunctionItem(`${id}-call-${index}`, message.tool_calls[index])),
    ));
  }
  return terminalResponse({
    id,
    created: Number.isFinite(chat.created) ? chat.created : Math.floor(Date.now() / 1000),
    model: chat.model || "",
    output,
    usage: responseUsage(chat.usage),
    finishReason: chat.choices?.[0]?.finish_reason,
  });
}

function responseSse(event) {
  return `data: ${JSON.stringify(event)}\r\n\r\n`;
}

class ChatResponseAssembler {
  constructor({ restoreCall = (item) => item } = {}) {
    this.restoreCall = restoreCall;
    this.id = "";
    this.model = "";
    this.created = 0;
    this.started = false;
    this.message = null;
    this.reasoning = null;
    this.calls = new Map();
    this.nextOutputIndex = 0;
    this.usage = undefined;
    this.timings = undefined;
    this.finishReason = "";
  }

  start(chunk) {
    if (this.started) return [];
    this.id = typeof chunk?.id === "string" && chunk.id ? chunk.id : `resp_local_${Date.now()}`;
    this.model = chunk?.model || "";
    this.created = Number.isFinite(chunk?.created) ? chunk.created : Math.floor(Date.now() / 1000);
    this.started = true;
    const response = { id: this.id, object: "response", created_at: this.created, model: this.model, status: "in_progress", output: [] };
    return [
      { type: "response.created", response },
      { type: "response.in_progress", response },
    ];
  }

  openMessage() {
    if (this.message) return [];
    const id = responseItemId("message", `${this.id}-message`);
    this.message = { id, text: "", index: this.nextOutputIndex++ };
    return [
      { type: "response.output_item.added", response_id: this.id, output_index: this.message.index, item: { id, type: "message", role: "assistant", status: "in_progress", content: [] } },
      { type: "response.content_part.added", response_id: this.id, item_id: id, output_index: this.message.index, content_index: 0, part: { type: "output_text", text: "" } },
    ];
  }

  openReasoning() {
    if (this.reasoning) return [];
    const id = responseItemId("reasoning", `${this.id}-reasoning`);
    this.reasoning = { id, text: "", index: this.nextOutputIndex++ };
    return [
      { type: "response.output_item.added", response_id: this.id, output_index: this.reasoning.index, item: responseReasoningItem(id, "", "in_progress") },
      { type: "response.content_part.added", response_id: this.id, item_id: id, output_index: this.reasoning.index, content_index: 0, part: { type: "reasoning_text", text: "" } },
    ];
  }

  openCall(index, delta) {
    const key = Number.isInteger(index) ? index : 0;
    let entry = this.calls.get(key);
    if (!entry) {
      entry = { callId: delta?.id || `${this.id}-call-${key}`, itemId: "", itemType: "function_call", name: "", arguments: "", emitted: false, index: this.nextOutputIndex++ };
      this.calls.set(key, entry);
    }
    if (!entry.emitted && typeof delta?.id === "string" && delta.id) entry.callId = delta.id;
    if (typeof delta?.function?.name === "string" && delta.function.name) entry.name = delta.function.name;
    const events = [];
    if (!entry.emitted && entry.name) {
      entry.emitted = true;
      const item = normalizeResponseItemId(this.restoreCall({
        id: responseItemId("function_call", entry.callId),
        type: "function_call",
        status: "in_progress",
        call_id: entry.callId,
        name: entry.name,
        arguments: "",
      }), entry.callId);
      entry.itemId = item.id;
      entry.itemType = item.type;
      events.push({ type: "response.output_item.added", response_id: this.id, output_index: entry.index, item });
    }
    if (typeof delta?.function?.arguments === "string") {
      entry.arguments += delta.function.arguments;
      if (entry.emitted) events.push({
        type: entry.itemType === "custom_tool_call" ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta",
        response_id: this.id,
        item_id: entry.itemId,
        call_id: entry.callId,
        output_index: entry.index,
        delta: delta.function.arguments,
      });
    }
    return events;
  }

  push(chunk) {
    const events = this.start(chunk);
    if (chunk?.usage) this.usage = responseUsage(chunk.usage);
    if (chunk?.timings) this.timings = normalizeLlamaServerTimings(chunk.timings) || this.timings;
    for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
      if (typeof choice?.finish_reason === "string" && choice.finish_reason) this.finishReason = choice.finish_reason;
      const delta = choice?.delta || {};
      const reasoningDelta = chatReasoningText(delta);
      if (reasoningDelta) {
        events.push(...this.openReasoning());
        this.reasoning.text += reasoningDelta;
        events.push({ type: "response.reasoning_text.delta", response_id: this.id, item_id: this.reasoning.id, output_index: this.reasoning.index, content_index: 0, delta: reasoningDelta });
      }
      if (typeof delta.content === "string" && delta.content) {
        events.push(...this.openMessage());
        this.message.text += delta.content;
        events.push({ type: "response.output_text.delta", response_id: this.id, item_id: this.message.id, output_index: this.message.index, content_index: 0, delta: delta.content });
      }
      for (const toolCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        events.push(...this.openCall(toolCall.index, toolCall));
      }
    }
    return events;
  }

  finish() {
    if (!this.started) return [];
    const events = [];
    const indexedOutput = [];
    if (this.reasoning) {
      const item = responseReasoningItem(this.reasoning.id, this.reasoning.text);
      events.push({ type: "response.reasoning_text.done", response_id: this.id, item_id: this.reasoning.id, output_index: this.reasoning.index, content_index: 0, text: this.reasoning.text });
      events.push({ type: "response.content_part.done", response_id: this.id, item_id: this.reasoning.id, output_index: this.reasoning.index, content_index: 0, part: item.content[0] });
      events.push({ type: "response.output_item.done", response_id: this.id, output_index: this.reasoning.index, item });
      indexedOutput.push({ index: this.reasoning.index, item });
    }
    if (this.message) {
      const item = responseMessageItem(this.message.id, this.message.text);
      events.push({ type: "response.output_text.done", response_id: this.id, item_id: this.message.id, output_index: this.message.index, content_index: 0, text: this.message.text });
      events.push({ type: "response.content_part.done", response_id: this.id, item_id: this.message.id, output_index: this.message.index, content_index: 0, part: item.content[0] });
      events.push({ type: "response.output_item.done", response_id: this.id, output_index: this.message.index, item });
      indexedOutput.push({ index: this.message.index, item });
    }
    for (const entry of this.calls.values()) {
      if (!entry.emitted || !entry.name) continue;
      const item = normalizeResponseItemId(this.restoreCall({
        id: entry.itemId || responseItemId("function_call", entry.callId),
        type: "function_call",
        status: "completed",
        call_id: entry.callId,
        name: entry.name,
        arguments: entry.arguments,
      }), entry.callId);
      events.push(item.type === "custom_tool_call"
        ? { type: "response.custom_tool_call_input.done", response_id: this.id, item_id: item.id, call_id: entry.callId, output_index: entry.index, input: item.input }
        : { type: "response.function_call_arguments.done", response_id: this.id, item_id: item.id, call_id: entry.callId, output_index: entry.index, arguments: entry.arguments });
      events.push({ type: "response.output_item.done", response_id: this.id, output_index: entry.index, item });
      indexedOutput.push({ index: entry.index, item });
    }
    const output = indexedOutput.sort((a, b) => a.index - b.index).map((entry) => entry.item);
    const response = terminalResponse({
      id: this.id,
      created: this.created,
      model: this.model,
      output,
      usage: this.usage,
      finishReason: this.finishReason,
    });
    events.push({ type: response.status === "incomplete" ? "response.incomplete" : "response.completed", response });
    return events;
  }
}

export function chatChunksToResponseEvents(chunks, options) {
  const assembler = new ChatResponseAssembler(options);
  const events = [];
  for (const chunk of chunks || []) events.push(...assembler.push(chunk));
  events.push(...assembler.finish());
  return events;
}

export async function pipeChatCompletionStream(body, res, {
  onEvent,
  onFirstResponse,
  restoreCall,
  signal,
  completeOnFinishReason = false,
  onTerminal,
} = {}) {
  if (!body) {
    res.end();
    return { bytes: 0, upstreamBytes: 0, interrupted: false, failure: "Local Chat upstream returned no response body." };
  }
  const assembler = new ChatResponseAssembler({ restoreCall });
  const decoder = new StringDecoder("utf8");
  let bytes = 0;
  let upstreamBytes = 0;
  let buffer = "";
  let reader;
  let interrupted = false;
  let responseError = null;
  let upstreamTerminal = false;
  let first = false;
  let resolveInterruption;
  const interruption = new Promise((resolve) => { resolveInterruption = resolve; });
  const write = async (event) => {
    const text = responseSse(event);
    bytes += Buffer.byteLength(text);
    onEvent?.(event);
    if (!res.write(text)) await new Promise((resolve, reject) => {
      res.once("drain", resolve);
      res.once("error", reject);
      res.once("close", resolve);
    });
  };
  const process = async () => {
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match) return;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("data:") && line.slice(5).trim() === "[DONE]") {
          upstreamTerminal = true;
          continue;
        }
        const chunk = parseSseData(line);
        if (chunk === undefined) continue;
        if (!first) {
          first = true;
          onFirstResponse?.();
        }
        for (const event of assembler.push(chunk)) await write(event);
        if (completeOnFinishReason && chunk?.choices?.some((choice) => choice?.finish_reason)) {
          upstreamTerminal = true;
        }
      }
    }
  };
  const interrupt = (error = null) => {
    if (res.writableFinished || interrupted) return;
    interrupted = true;
    if (error) responseError = error;
    resolveInterruption({ interrupted: true });
    reader?.cancel?.().catch(() => {});
  };
  const onClose = () => interrupt();
  const onError = (error) => interrupt(error);
  const onAbort = () => interrupt();
  res.once("close", onClose);
  res.once("error", onError);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    reader = body.getReader();
    if (signal?.aborted) interrupt();
    while (!interrupted) {
      const outcome = await Promise.race([
        reader.read().then(
          (value) => ({ type: "read", value }),
          (error) => ({ type: "error", error }),
        ),
        interruption,
      ]);
      if (outcome?.interrupted) break;
      if (outcome.type === "error") {
        if (interrupted) break;
        throw outcome.error;
      }
      const { done, value } = outcome.value;
      if (done) break;
      upstreamBytes += value.byteLength || Buffer.byteLength(value);
      buffer += decoder.write(Buffer.from(value));
      await process();
      // Chat Completions defines data: [DONE] as the transport terminator, and
      // llama.cpp also reports a semantic finish_reason once it has released the
      // request. Accept either as the end of the turn: waiting for the HTTP body
      // to close on its own keeps the gateway lease, and every queued local
      // conversation behind it, alive until the idle timeout fires.
      if (upstreamTerminal) {
        break;
      }
    }
    if (responseError) throw responseError;
    if (!interrupted) {
      buffer += decoder.end();
      await process();
      const finalEvents = assembler.finish();
      for (const event of finalEvents) await write(event);
      const completedResponse = finalEvents.find((event) => event.type === "response.completed")?.response;
      res.end();
      return {
        bytes,
        upstreamBytes,
        interrupted,
        failure: completedResponse?.output?.length ? "" : "Local Chat completion had no output.",
        completedResponse,
        llamaTimings: assembler.timings,
      };
    }
  } finally {
    res.removeListener("close", onClose);
    res.removeListener("error", onError);
    signal?.removeEventListener("abort", onAbort);
    if (upstreamTerminal) {
      try {
        reader?.releaseLock?.();
      } catch {
        // The terminal response is already complete; network cleanup below is
        // owned by the fetch layer even if this reader cannot release cleanly.
      }
      try {
        onTerminal?.();
      } catch {
        // Closing an already-finished upstream must not change the response.
      }
    }
    if (interrupted) reader?.cancel?.().catch(() => {});
  }
  return { bytes, upstreamBytes, interrupted, failure: "", completedResponse: undefined, llamaTimings: assembler.timings };
}
