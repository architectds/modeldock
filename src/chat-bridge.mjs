// Chat Completions bridge for the OpenCode Go / Zen upstreams.
//
// DeepSeek (paid go and zen free) speaks Chat Completions natively; the /responses
// endpoint is a lossy translation shim that rejects native tool pairs, strips
// reasoning, and demands reasoning_content it never returns. So for models in the
// "chat" camp we send the Chat dialect directly and adapt the streaming response
// back into Responses-shaped SSE events, so the rest of the relay pipeline
// (LiveResponsesWriter + harness loop) works unchanged.
//
// Verified live (2026-08-04): deepseek-v4-flash and deepseek-v4-flash-free both
// stream content/reasoning_content/tool_calls deltas and accept chat-dialect tool
// history (assistant.tool_calls + role:"tool") on round 2 with no 400s.

import { randomUUID } from "node:crypto";

const RESPONSES_MODELS = new Set(["gpt-5.6-luna", "grok-4.5"]);
const ZEN_FREE_BASE = "https://opencode.ai/zen/v1/chat/completions";

export function chatCampForModel(model) {
  if (RESPONSES_MODELS.has(model)) return "responses";
  if (model.endsWith("-free") || model === "big-pickle") return "zen-free";
  return "chat";
}

export function chatCampForRequest(model, config) {
  const override = config?.profile?.chatCampOverride;
  if (override === "responses" || override === "chat") return override;
  // Chat bridge applies to the OpenCode Go camp only. Other providers (e.g.
  // deepseek-official) speak Responses natively and must never be converted.
  if (config?.profile?.id !== "opencode-go") return "responses";
  return chatCampForModel(model);
}

function chatBaseFor(goBaseUrl) {
  const base = goBaseUrl.replace(/\/$/, "");
  return `${base}/chat/completions`;
}

// Convert a native Responses input item (function_call / function_call_output /
// message) into the Chat dialect the upstream accepts. Paired calls become
// assistant.tool_calls + role:"tool" messages; orphans become user notes.
// reasoningLookup(callId) optionally returns the actual reasoning the model produced
// for that call (recorded by the relay), so tool-loop turns carry real thought text
// instead of a placeholder.
function inputToChatMessages(input, reasoningLookup) {
  if (!Array.isArray(input)) return [];
  const out = [];
  let index = 0;
  while (index < input.length) {
    const item = input[index];
    const isCall = item?.type === "function_call" || item?.type === "custom_tool_call";
    if (isCall) {
      const batch = [];
      while (index < input.length && (input[index]?.type === "function_call" || input[index]?.type === "custom_tool_call")) {
        if (input[index].call_id != null) batch.push(input[index]);
        index += 1;
      }
      const outputsByCall = new Map();
      while (index < input.length && (input[index]?.type === "function_call_output" || input[index]?.type === "custom_tool_call_output")) {
        const output = input[index];
        if (output.call_id != null && !outputsByCall.has(output.call_id)) outputsByCall.set(output.call_id, output);
        index += 1;
      }
      const paired = batch.filter((call) => outputsByCall.has(call.call_id));
      if (paired.length > 0) {
        // Go's chat camp (thinking mode) demands reasoning_content on every
        // assistant.tool_calls turn. Codex does not store the reasoning we forward, so
        // use the reasoning the relay recorded for this call (real thought text), or an
        // honest continuation note as a last resort.
        const reasoningText = batch.find((call) => typeof call.reasoning_content === "string" && call.reasoning_content)?.reasoning_content
          || (reasoningLookup ? reasoningLookup(paired[0].call_id) : null)
          || "Continuing the task: a local tool was invoked and its result is provided below.";
        out.push({
          role: "assistant",
          content: null,
          reasoning_content: reasoningText,
          tool_calls: paired.map((call) => ({
            id: call.call_id,
            type: "function",
            function: {
              name: call.name || "tool",
              arguments: typeof (call.type === "custom_tool_call" ? call.input : call.arguments) === "string"
                ? (call.type === "custom_tool_call" ? call.input : call.arguments)
                : JSON.stringify(call.type === "custom_tool_call" ? call.input : call.arguments || {}),
            },
          })),
        });
        for (const call of paired) {
          const output = outputsByCall.get(call.call_id);
          out.push({ role: "tool", tool_call_id: call.call_id, content: toolOutputText(output?.output) });
        }
      }
      for (const [callId, output] of outputsByCall) {
        if (!paired.some((call) => call.call_id === callId)) {
          out.push({ role: "user", content: `[tool output for ${callId}]\n${toolOutputText(output?.output)}` });
        }
      }
      continue;
    }
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") {
      out.push({ role: "user", content: `[tool output for ${item.call_id}]\n${toolOutputText(item.output)}` });
      index += 1;
      continue;
    }
    if (item?.role === "assistant") {
      const text = typeof item.content === "string" ? item.content : Array.isArray(item.content) ? item.content.map((part) => part?.text || "").join("") : "";
      if (text) out.push({ role: "assistant", content: text });
      index += 1;
      continue;
    }
    if (item?.role === "user") {
      const isArray = Array.isArray(item.content);
      const text = typeof item.content === "string" ? item.content : isArray ? item.content.map((part) => part?.text || "").join("") : "";
      const imageParts = isArray ? item.content.filter((part) => part?.type === "input_image" && typeof part?.image_url === "string") : [];
      if (text && imageParts.length === 0) {
        out.push({ role: "user", content: text });
      } else if (text || imageParts.length > 0) {
        const content = [];
        if (text) content.push({ type: "text", text });
        for (const img of imageParts) content.push({ type: "image_url", image_url: { url: img.image_url } });
        out.push({ role: "user", content });
      }
      index += 1;
      continue;
    }
    index += 1;
  }
  return out;
}

function toolOutputText(output) {
  if (typeof output === "string") return output;
  if (!output) return "";
  if (typeof output?.text === "string") return output.text;
  if (Array.isArray(output?.content)) {
    return output.content
      .map((part) => (typeof part?.text === "string" ? part.text : part?.type === "input_image" || part?.type === "output_image" ? "[image]" : ""))
      .join("\n");
  }
  return JSON.stringify(output);
}

// Chat Completions tools require the nested { type, function: {...} } shape.
function toolsToChat(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    if (tool?.type === "function") {
      out.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.parameters || { type: "object", properties: {} },
        },
      });
    } else if (tool?.type === "custom" || (tool?.type === "function" && tool?.name)) {
      out.push({
        type: "function",
        function: { name: tool.name, description: tool.description || "", parameters: { type: "object", properties: {} } },
      });
    }
  }
  return out;
}

// Build the Chat Completions request body from a Responses payload.
export function responsesToChatRequest(payload, { reasoningLookup = null } = {}) {
  const messages = inputToChatMessages(payload.input, reasoningLookup);
  const body = {
    model: payload.model,
    messages,
    // Mirror the official opencode client budget (32000) instead of a hard 4096, which
    // truncated long outputs whenever Codex omits max_output_tokens.
    max_tokens: payload.max_output_tokens ?? 32000,
    stream: payload.stream === true,
  };
  // Forward the client's identity so the upstream sees official-client-shaped traffic
  // (session/turn/installation ids) instead of an anonymous relay.
  if (payload.client_metadata && typeof payload.client_metadata === "object") {
    body.metadata = payload.client_metadata;
  }
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    body.tools = toolsToChat(payload.tools);
  }
  if (payload.tool_choice && typeof payload.tool_choice === "string") body.tool_choice = payload.tool_choice;
  if (typeof payload.temperature === "number") body.temperature = payload.temperature;
  if (payload.stop && Array.isArray(payload.stop) && payload.stop.length > 0) body.stop = payload.stop;
  return body;
}

export function chatEndpointFor(model, config) {
  const camp = chatCampForRequest(model, config);
  if (camp === "responses") {
    return { url: `${config.goBaseUrl.replace(/\/$/, "")}/responses`, style: "responses" };
  }
  if (camp === "zen-free") return { url: ZEN_FREE_BASE, style: "chat" };
  return { url: chatBaseFor(config.goBaseUrl), style: "chat" };
}

// Adapt a Chat Completions SSE chunk into Responses-shaped events so the relay
// loop can consume them identically to native responses events.
export function* chatChunkToResponsesEvents(parsed) {
  const choice = parsed.choices?.[0];
  if (!choice) {
    if (parsed.usage) yield { type: "response.completed", response: { usage: parsed.usage } };
    return;
  }
  const delta = choice.delta || {};
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
    yield { type: "response.reasoning_text.delta", delta: delta.reasoning_content };
  }
  if (typeof delta.content === "string" && delta.content) {
    yield { type: "response.output_text.delta", delta: delta.content };
  }
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    for (const tc of delta.tool_calls) {
      const fn = tc.function || {};
      if (tc.id || fn.name) {
        yield {
          type: "response.output_item.added",
          item: { type: "function_call", id: tc.id || `call_${randomUUID().replace(/-/g, "").slice(0, 12)}`, call_id: tc.id, name: fn.name || "tool", arguments: fn.arguments || "", status: "in_progress" },
        };
      } else if (typeof fn.arguments === "string" && fn.arguments) {
        yield { type: "response.function_call_arguments.delta", delta: fn.arguments };
      }
    }
  }
  if (choice.finish_reason) {
    // Chat completions reports usage as prompt_tokens/completion_tokens; map it to the
    // Responses shape (input_tokens/output_tokens) so metrics count real tokens.
    const usage = parsed.usage;
    const responsesUsage = usage
      ? {
          input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
          output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
          total_tokens: usage.total_tokens ?? 0,
        }
      : null;
    yield { type: "response.completed", response: { usage: responsesUsage } };
  }
}
