import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { deflateSync } from "node:zlib";
import { loadConfig } from "../src/config.mjs";
import { extractOutputText } from "../src/upstreams.mjs";
import { startServer } from "../src/server.mjs";

const config = loadConfig();
const hasAnyToken = Object.values(config.tokens || {}).some(Boolean);
if (!hasAnyToken) throw new Error("Set a provider token (OPENCODE_GO_TOKEN, DEEPSEEK_API_KEY, or MODELDOCK_CUSTOM_API_KEY) or add it to .env before running npm run probe:live");

const instance = await startServer({ ...config, port: 0 });
const port = instance.server.address().port;
// Caller-key enforcement is on by default; the probe must speak the keyed
// base URL like Codex does, not the bare /v1 path. The suffix stays `/v1/...`
// on each call, so the prefix is `/c/<key>` without the trailing `/v1`.
const baseUrl = `http://127.0.0.1:${port}/c/${instance.services.callerKey}`;
const mcpUrl = `${baseUrl}/mcp`;
const result = { baseUrl, responses: {}, mcp: {}, web: {}, vision: {} };
let client;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function solidBluePngDataUrl() {
  const width = 256;
  const height = 256;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    scanlines[row] = 0;
    for (let x = 0; x < width; x += 1) scanlines.set([35, 126, 220], row + 1 + x * 3);
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND"),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

try {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.mainModel,
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly GATE_OK." }] }],
      tools: [
        { type: "tool_search" },
        { type: "web_search" },
        { type: "function", name: "safe_probe", description: "Unused probe function", parameters: { type: "object", properties: {} } },
      ],
      tool_choice: "auto",
      max_output_tokens: 256,
      stream: false,
    }),
  });
  const responseBody = await response.json();
  result.responses.nonstream = {
    status: response.status,
    output: extractOutputText(responseBody),
    usage: responseBody.usage,
  };

  const stream = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      model: config.mainModel,
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly STREAM_OK." }] }],
      max_output_tokens: 256,
      stream: true,
    }),
  });
  const streamBody = await stream.text();
  result.responses.stream = {
    status: stream.status,
    completedEvent: streamBody.includes("response.completed"),
    bytes: Buffer.byteLength(streamBody),
  };

  const secondTurn = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.mainModel,
      input: [
        { type: "message", id: "msg_probe_previous", role: "assistant", content: [{ type: "output_text", text: "Previous answer." }] },
        { type: "message", id: "msg_probe_current", role: "user", content: [{ type: "input_text", text: "Reply with exactly SECOND_TURN_OK." }] },
      ],
      max_output_tokens: 256,
      stream: false,
    }),
  });
  const secondTurnBody = await secondTurn.json();
  result.responses.secondTurn = {
    status: secondTurn.status,
    output: extractOutputText(secondTurnBody),
  };
  if (secondTurn.status !== 200 || !result.responses.secondTurn.output.includes("SECOND_TURN_OK")) {
    throw new Error(`Second-turn assistant history probe failed with HTTP ${secondTurn.status}`);
  }

  // The OpenCode Go upstream rejects arbitrary `type: "custom"` tools (only
  // apply_patch is allowed); a standard `type: "function"` declaration is
  // accepted and still yields a function_call the gateway can replay.
  const historyTool = { type: "function", name: "history_probe", description: "Return protocol probe input.", parameters: { type: "object", properties: {} } };
  const historyPrompt = [{ role: "user", content: [{ type: "input_text", text: "Call history_probe exactly once with input HISTORY_PROBE." }] }];
  const historyCallResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.mainModel,
      input: historyPrompt,
      tools: [historyTool],
      tool_choice: "auto",
      max_output_tokens: 256,
      stream: false,
    }),
  });
  const historyCallBody = await historyCallResponse.json();
  const providerCall = historyCallBody.output?.find((item) => item?.type === "function_call");
  if (!historyCallResponse.ok || !providerCall?.call_id) {
    throw new Error(`Tool-history first round failed with HTTP ${historyCallResponse.status}`);
  }
  const codexCall = {
    id: providerCall.id,
    type: "custom_tool_call",
    name: providerCall.name,
    call_id: providerCall.call_id,
    input: "HISTORY_PROBE",
  };
  const historyReplay = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.mainModel,
      input: [
        ...historyPrompt,
        { role: "assistant", content: [] },
        codexCall,
        { type: "custom_tool_call_output", call_id: codexCall.call_id, output: "HISTORY_RESULT_OK" },
        { role: "user", content: [{ type: "input_text", text: "Reply exactly TOOL_HISTORY_OK." }] },
      ],
      tools: [historyTool],
      tool_choice: "none",
      max_output_tokens: 256,
      stream: false,
    }),
  });
  const historyReplayBody = await historyReplay.json();
  result.responses.toolHistory = {
    status: historyReplay.status,
    output: extractOutputText(historyReplayBody),
    droppedAssistantMessages: instance.services.metrics.responses.droppedAssistantMessages || 0,
  };
  if (historyReplay.status !== 200 || !result.responses.toolHistory.output.includes("TOOL_HISTORY_OK")) {
    throw new Error(`Native tool-history replay failed with HTTP ${historyReplay.status}`);
  }

  const visualDataUrl = solidBluePngDataUrl();
  const directVision = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.mainModel,
      input: [{ role: "user", content: [
        { type: "input_text", text: "Describe the dominant visible color in one short sentence." },
        { type: "input_image", image_url: visualDataUrl },
      ] }],
      max_output_tokens: 256,
      stream: false,
    }),
  });
  const directVisionBody = await directVision.json();
  const directVisionOutput = extractOutputText(directVisionBody);
  const directVisionTrace = instance.services.metrics.recent.find((item) => item.kind === "responses");
  result.responses.directVision = {
    status: directVision.status,
    route: directVisionTrace?.routeReason,
    model: directVisionTrace?.model,
    output: directVisionOutput,
  };
  if (
    directVision.status !== 200
    || directVisionTrace?.model !== config.visionModel
    || directVisionTrace?.routeReason !== "current_turn_image"
  ) {
    throw new Error(
      `Direct visual routing probe failed with HTTP ${directVision.status}, `
      + `model=${directVisionTrace?.model}, expected=${config.visionModel}, `
      + `route=${directVisionTrace?.routeReason}`,
    );
  }

  const returnToMain = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.mainModel,
      input: [
        { role: "user", content: [{ type: "input_image", image_url: visualDataUrl }] },
        { role: "assistant", content: [{ type: "output_text", text: directVisionOutput || "The image was inspected by Luna." }] },
        { role: "user", content: [{ type: "input_text", text: "Reply with exactly RETURN_MAIN_OK." }] },
      ],
      max_output_tokens: 256,
      stream: false,
    }),
  });
  const returnToMainBody = await returnToMain.json();
  const returnToMainTrace = instance.services.metrics.recent.find((item) => item.kind === "responses");
  result.responses.returnToMain = {
    status: returnToMain.status,
    route: returnToMainTrace?.routeReason,
    model: returnToMainTrace?.model,
    output: extractOutputText(returnToMainBody),
  };
  if (
    returnToMain.status !== 200
    || returnToMainTrace?.model !== config.mainModel
    || returnToMainTrace?.routeReason !== "default_main"
  ) {
    throw new Error(
      `Return-to-main routing probe failed with HTTP ${returnToMain.status}, `
      + `model=${returnToMainTrace?.model}, expected=${config.mainModel}, `
      + `route=${returnToMainTrace?.routeReason}`,
    );
  }

  client = new Client({ name: "modeldock-live-probe", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  const tools = await client.listTools();
  result.mcp.tools = tools.tools.map((tool) => tool.name);

  const web = await client.callTool({
    name: "web_search_exa",
    arguments: { query: "OpenCode Go official documentation", numResults: 2, type: "fast", livecrawl: "fallback" },
  });
  const webText = web.content?.find((item) => item.type === "text")?.text || "";
  result.web = { isError: Boolean(web.isError), outputBytes: Buffer.byteLength(webText), hasUrl: /https?:\/\//.test(webText) };

  const imageRef = instance.services.mediaStore.put(visualDataUrl);
  const vision = await client.callTool({
    name: "vision_inspect",
    arguments: { image_ref: imageRef, question: "Describe the dominant visible color in one short sentence.", mode: "general" },
  });
  const visionText = vision.content?.find((item) => item.type === "text")?.text || "";
  let visionPayload;
  try {
    visionPayload = JSON.parse(visionText);
  } catch {
    visionPayload = { answer: visionText };
  }
  result.vision = {
    isError: Boolean(vision.isError),
    model: visionPayload.model,
    fallbackUsed: visionPayload.fallbackUsed,
    answer: String(visionPayload.answer || "").slice(0, 240),
  };

  result.status = instance.services.metrics.snapshot({ media: instance.services.mediaStore.snapshot() });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client?.close().catch(() => {});
  await instance.stop();
}
