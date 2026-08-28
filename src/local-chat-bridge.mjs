import { StringDecoder } from "node:string_decoder";
import { parseSseData } from "./sse.mjs";

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

function chatContent(content, itemType = "message", mediaMarker = "") {
  if (typeof content === "string") return escapeMediaMarkerText(content, mediaMarker);
  if (content === null || content === undefined) return "";
  if (!Array.isArray(content)) {
    throw new LocalChatBridgeError("unsupported_content", `Local Chat bridge cannot encode ${itemType} content.`);
  }
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (["input_text", "output_text", "text", "reasoning_text"].includes(part.type) && typeof part.text === "string") {
      parts.push({ type: "text", text: escapeMediaMarkerText(part.text, mediaMarker) });
      continue;
    }
    if (part.type === "input_image" && typeof part.image_url === "string") {
      parts.push({ type: "image_url", image_url: { url: part.image_url } });
      continue;
    }
    throw new LocalChatBridgeError("unsupported_content_part", `Local Chat bridge cannot encode ${itemType} content part ${String(part.type || "unknown")}.`);
  }
  if (parts.every((part) => part.type === "text")) return parts.map((part) => part.text).join("\n");
  return parts;
}

function chatTools(tools, mediaMarker = "") {
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
    throw new LocalChatBridgeError("unsupported_tool", `Local Chat bridge cannot encode tool type ${String(tool.type || "unknown")}.`);
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

function toolCallItem(item, { toolArgumentsAsObjects = false, mediaMarker = "" } = {}) {
  const callId = item.call_id || item.id;
  if (typeof callId !== "string" || !callId) {
    throw new LocalChatBridgeError("tool_call_id", "Local Chat bridge needs a call_id for every function call.");
  }
  if (typeof item.name !== "string" || !item.name) {
    throw new LocalChatBridgeError("tool_call_name", "Local Chat bridge needs a name for every function call.");
  }
  const argumentsValue = item.arguments ?? item.input ?? {};
  const argumentsText = typeof argumentsValue === "string" ? argumentsValue : textValue(argumentsValue, mediaMarker);
  return {
    id: callId,
    type: "function",
    function: {
      name: item.name,
      arguments: toolArgumentsAsObjects
        ? escapeMediaMarkerValue(objectToolArguments(argumentsValue), mediaMarker)
        : escapeMediaMarkerText(argumentsText, mediaMarker),
    },
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
  for (const item of payload.input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call") {
      const next = assistant();
      if (!next.tool_calls) next.tool_calls = [];
      next.tool_calls.push(toolCallItem(item, { toolArgumentsAsObjects, mediaMarker }));
      continue;
    }
    if (item.type === "function_call_output") {
      flushAssistant();
      const callId = item.call_id || item.id;
      if (typeof callId !== "string" || !callId) {
        throw new LocalChatBridgeError("tool_output_id", "Local Chat bridge needs a call_id for every function output.");
      }
      messages.push({ role: "tool", tool_call_id: callId, content: textValue(item.output, mediaMarker) });
      continue;
    }
    if (item.type === "message") {
      const role = item.role === "developer" ? "system" : item.role;
      if (!["system", "user", "assistant"].includes(role)) {
        throw new LocalChatBridgeError("message_role", `Local Chat bridge cannot encode message role ${String(item.role || "unknown")}.`);
      }
      const content = chatContent(item.content, "message", mediaMarker);
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
    throw new LocalChatBridgeError("input_item", `Local Chat bridge cannot encode input item ${String(item.type || "unknown")}.`);
  }
  flushAssistant();
  const convertedTools = chatTools(payload.tools, mediaMarker);
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
  return { payload: chat, customToolNames: convertedTools.customToolNames };
}

function responseUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens);
  const output = Number(usage.completion_tokens ?? usage.output_tokens);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return undefined;
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens);
  return {
    ...(Number.isFinite(input) ? { input_tokens: input } : {}),
    ...(Number.isFinite(output) ? { output_tokens: output } : {}),
    ...(Number.isFinite(input) && Number.isFinite(output) ? { total_tokens: input + output } : {}),
    ...(Number.isFinite(cached) ? { input_tokens_details: { cached_tokens: cached } } : {}),
  };
}

function responseMessageItem(id, content) {
  return {
    id,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: String(content || "") }],
  };
}

function responseFunctionItem(id, toolCall) {
  return {
    id: toolCall.id || id,
    type: "function_call",
    status: "completed",
    call_id: toolCall.id || id,
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
  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    output.push({ id: `${id}-reasoning`, type: "reasoning", status: "completed", content: [{ type: "reasoning_text", text: message.reasoning_content }] });
  }
  if (typeof message.content === "string" && message.content) output.push(responseMessageItem(`${id}-message`, message.content));
  for (let index = 0; index < (message.tool_calls || []).length; index += 1) {
    output.push(restoreCall(responseFunctionItem(`${id}-call-${index}`, message.tool_calls[index])));
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
    const id = `${this.id}-message`;
    this.message = { id, text: "", index: this.nextOutputIndex++ };
    return [
      { type: "response.output_item.added", response_id: this.id, output_index: this.message.index, item: { id, type: "message", role: "assistant", status: "in_progress", content: [] } },
      { type: "response.content_part.added", response_id: this.id, item_id: id, output_index: this.message.index, content_index: 0, part: { type: "output_text", text: "" } },
    ];
  }

  openReasoning() {
    if (this.reasoning) return [];
    const id = `${this.id}-reasoning`;
    this.reasoning = { id, text: "", index: this.nextOutputIndex++ };
    return [
      { type: "response.output_item.added", response_id: this.id, output_index: this.reasoning.index, item: { id, type: "reasoning", status: "in_progress", summary: [] } },
      { type: "response.content_part.added", response_id: this.id, item_id: id, output_index: this.reasoning.index, content_index: 0, part: { type: "reasoning_text", text: "" } },
    ];
  }

  openCall(index, delta) {
    const key = Number.isInteger(index) ? index : 0;
    let entry = this.calls.get(key);
    if (!entry) {
      entry = { id: delta?.id || `${this.id}-call-${key}`, name: "", arguments: "", emitted: false, index: this.nextOutputIndex++ };
      this.calls.set(key, entry);
    }
    if (typeof delta?.id === "string" && delta.id) entry.id = delta.id;
    if (typeof delta?.function?.name === "string" && delta.function.name) entry.name = delta.function.name;
    const events = [];
    if (!entry.emitted && entry.name) {
      entry.emitted = true;
      const item = this.restoreCall({ id: entry.id, type: "function_call", status: "in_progress", call_id: entry.id, name: entry.name, arguments: "" });
      events.push({ type: "response.output_item.added", response_id: this.id, output_index: entry.index, item });
    }
    if (typeof delta?.function?.arguments === "string") {
      entry.arguments += delta.function.arguments;
      if (entry.emitted) events.push({ type: "response.function_call_arguments.delta", response_id: this.id, item_id: entry.id, call_id: entry.id, output_index: entry.index, delta: delta.function.arguments });
    }
    return events;
  }

  push(chunk) {
    const events = this.start(chunk);
    if (chunk?.usage) this.usage = responseUsage(chunk.usage);
    for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
      if (typeof choice?.finish_reason === "string" && choice.finish_reason) this.finishReason = choice.finish_reason;
      const delta = choice?.delta || {};
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        events.push(...this.openReasoning());
        this.reasoning.text += delta.reasoning_content;
        events.push({ type: "response.reasoning_text.delta", response_id: this.id, item_id: this.reasoning.id, output_index: 0, content_index: 0, delta: delta.reasoning_content });
      }
      if (typeof delta.content === "string" && delta.content) {
        events.push(...this.openMessage());
        this.message.text += delta.content;
        events.push({ type: "response.output_text.delta", response_id: this.id, item_id: this.message.id, output_index: 0, content_index: 0, delta: delta.content });
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
    const output = [];
    if (this.reasoning) {
      const item = { id: this.reasoning.id, type: "reasoning", status: "completed", content: [{ type: "reasoning_text", text: this.reasoning.text }] };
      events.push({ type: "response.reasoning_text.done", response_id: this.id, item_id: this.reasoning.id, output_index: this.reasoning.index, content_index: 0, text: this.reasoning.text });
      events.push({ type: "response.content_part.done", response_id: this.id, item_id: this.reasoning.id, output_index: this.reasoning.index, content_index: 0, part: item.content[0] });
      events.push({ type: "response.output_item.done", response_id: this.id, output_index: this.reasoning.index, item });
      output.push(item);
    }
    if (this.message) {
      const item = responseMessageItem(this.message.id, this.message.text);
      events.push({ type: "response.output_text.done", response_id: this.id, item_id: this.message.id, output_index: this.message.index, content_index: 0, text: this.message.text });
      events.push({ type: "response.content_part.done", response_id: this.id, item_id: this.message.id, output_index: this.message.index, content_index: 0, part: item.content[0] });
      events.push({ type: "response.output_item.done", response_id: this.id, output_index: this.message.index, item });
      output.push(item);
    }
    for (const entry of this.calls.values()) {
      if (!entry.emitted || !entry.name) continue;
      const item = this.restoreCall({ id: entry.id, type: "function_call", status: "completed", call_id: entry.id, name: entry.name, arguments: entry.arguments });
      events.push({ type: "response.function_call_arguments.done", response_id: this.id, item_id: entry.id, call_id: entry.id, output_index: entry.index, arguments: entry.arguments });
      events.push({ type: "response.output_item.done", response_id: this.id, output_index: entry.index, item });
      output.push(item);
    }
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

export async function pipeChatCompletionStream(body, res, { onEvent, onFirstResponse, restoreCall } = {}) {
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
  let first = false;
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
        const chunk = parseSseData(line);
        if (chunk === undefined) continue;
        if (!first) {
          first = true;
          onFirstResponse?.();
        }
        for (const event of assembler.push(chunk)) await write(event);
      }
    }
  };
  const onClose = () => {
    if (!res.writableFinished) {
      interrupted = true;
      reader?.cancel?.().catch(() => {});
    }
  };
  res.once("close", onClose);
  try {
    reader = body.getReader();
    while (!interrupted) {
      const { done, value } = await reader.read();
      if (done) break;
      upstreamBytes += value.byteLength || Buffer.byteLength(value);
      buffer += decoder.write(Buffer.from(value));
      await process();
    }
    if (!interrupted) {
      buffer += decoder.end();
      await process();
      const finalEvents = assembler.finish();
      for (const event of finalEvents) await write(event);
      const completedResponse = finalEvents.find((event) => event.type === "response.completed")?.response;
      res.end();
      return { bytes, upstreamBytes, interrupted, failure: completedResponse?.output?.length ? "" : "Local Chat completion had no output.", completedResponse };
    }
  } finally {
    res.removeListener("close", onClose);
    if (interrupted) reader?.cancel?.().catch(() => {});
  }
  return { bytes, upstreamBytes, interrupted, failure: "", completedResponse: undefined };
}
