import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";

function textResult(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function errorResult(error) {
  return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
}

export function recordMcpError(metrics, error) {
  metrics.recent.unshift({
    id: "mcp",
    kind: "mcp",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  });
  metrics.recent.length = Math.min(metrics.recent.length, metrics.recentLimit);
  metrics.emit("change");
}

// acceptScopeOnly is true only on gateway-side endpoints: the stdio bridge
// forwards internal args after injecting them, so the gateway schema must keep
// scope_only even though the model-facing tools/list never advertises it.
export function createMcpServer({ upstreams, acceptScopeOnly = false }) {
  const server = new McpServer(
    { name: "modeldock-opencode-go", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  const recallInputSchema = z.object({
    query: z.string().min(1).describe("What to recall, in your own words"),
    scope_dir: z.string().optional().describe("Absolute working directory to scope the recall to; omit to use the session working directory (project first, then global)"),
    ...(acceptScopeOnly
      ? { scope_only: z.boolean().optional().describe("Only search the given scope, never fall back to global memory") }
      : {}),
    limit: z.number().int().min(1).max(20).optional().describe("Number of results; defaults to 8"),
  });

      server.registerTool(
        "web_search_exa",
        {
          title: "Exa Web Search",
          description: "Search the public web through Exa hosted MCP and return source URLs with relevant context.",
          inputSchema: z.object({
            query: z.string().min(1).describe("Web search query"),
            numResults: z.number().int().min(1).max(20).optional().describe("Number of results; defaults to 8"),
            livecrawl: z.enum(["fallback", "preferred"]).optional(),
            type: z.enum(["auto", "fast", "deep"]).optional(),
            contextMaxCharacters: z.number().int().min(1_000).max(50_000).optional(),
          }),
          // A read-only query must not be gated behind Codex's open-world
          // policy: openWorldHint: true hides the tool from sessions whose
          // config does not enable open_world, which is the default. Web
          // search never mutates external state, so it is read-only only.
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args) => {
          try {
            return textResult(await upstreams.searchWeb(args));
          } catch (error) {
            return errorResult(error);
          }
        },
      );

      server.registerTool(
        "vision_inspect",
        {
          title: "Vision Inspect",
          description:
            "Delegate image inspection to the configured vision model. This is the visual path for text-only models; a model that can inspect image pixels itself should use view_image or preview_images instead.",
          inputSchema: z.object({
            image_ref: z.string().startsWith("img_").optional().describe("Image reference inserted into the conversation by the Responses gate"),
            compare_image_ref: z.string().startsWith("img_").optional().describe("Optional second image for compare mode"),
            path: z.string().min(1).optional().describe("Absolute local file path of a screenshot to inspect"),
            question: z.string().min(1).describe("What to inspect or extract"),
            mode: z.enum(["general", "ocr", "ui", "chart", "compare"]).optional(),
          }),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args) => {
          try {
            return textResult(await upstreams.inspectVision(args));
          } catch (error) {
            return errorResult(error);
          }
        },
      );

      if (typeof upstreams.previewImages === "function") {
        server.registerTool(
          "preview_images",
          {
            title: "Preview Local Images",
            description:
              "Attach local PNG/JPEG screenshots as bounded conversation previews so a vision-capable model can inspect them directly. Compressed previews prefer the 200-600 KiB range and never exceed 1 MiB; already-small images are not enlarged. The returned original_ref preserves access to the full image when a later text-only route needs delegated inspection.",
            inputSchema: z.object({
              paths: z.array(z.string().min(1)).min(1).max(20).describe("Absolute local paths of PNG/JPEG screenshots, in display order"),
            }),
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
          async (args) => {
            try {
              return await upstreams.previewImages(args);
            } catch (error) {
              return errorResult(error);
            }
          },
        );
      }

      server.registerTool(
        "image_gen",
        {
          title: "Image Generation",
          description:
            "Generate an image through the native ChatGPT backend (uses the signed-in Codex subscription). Returns the absolute path to the saved PNG so it can be surfaced in the conversation.",
          inputSchema: z.object({
            prompt: z.string().min(1).describe("Describe the image to generate"),
            size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).optional().describe("Output size; defaults to 1024x1024"),
            model: z.string().optional().describe("Native image model; defaults to gpt-image-1"),
          }),
          annotations: { readOnlyHint: false, openWorldHint: false },
        },
        async (args) => {
          try {
            return textResult(await upstreams.generateImage(args));
          } catch (error) {
            return errorResult(error);
          }
        },
      );

      // Grok media is a connected capability, not a permanently advertised
      // placeholder. Each tool also needs its specific upstream model: a
      // subscription that can chat with Grok but lacks Imagine must not spend
      // Codex's tool context on a call guaranteed to fail.
      if (upstreams.hasXaiImageGeneration?.()) {
        server.registerTool(
          "grok_image_gen",
          {
            title: "Grok Image Generation",
            description:
              "Generate an image with the signed-in xAI Grok service. Returns the absolute path to the saved image so it can be surfaced in the conversation.",
            inputSchema: z.object({
              prompt: z.string().min(1).describe("Describe the image to generate"),
            }),
            annotations: { readOnlyHint: false, openWorldHint: false },
          },
          async (args) => {
            try {
              return textResult(await upstreams.generateXaiImage(args));
            } catch (error) {
              return errorResult(error);
            }
          },
        );
      }

      if (upstreams.hasXaiVideoGeneration?.()) {
        server.registerTool(
          "grok_video_gen",
          {
            title: "Grok Video Generation",
            description:
              "Generate a video with the signed-in xAI Grok Imagine service. The normal call waits for a terminal result and returns the temporary video URL. Set wait_seconds to 0 only for an explicit detached job, then call action=status with its request_id. ModelDock does not copy the video locally.",
            inputSchema: z.object({
              action: z.enum(["generate", "status"]).optional().describe("generate starts a video; status checks a pending request"),
              prompt: z.string().min(1).optional().describe("Video prompt; required for generate"),
              request_id: z.string().min(1).optional().describe("Pending request id; required for status"),
              model: z.enum(["grok-imagine-video", "grok-imagine-video-1.5"]).optional().describe("Defaults to grok-imagine-video-1.5"),
              duration: z.number().int().min(1).max(15).optional().describe("Seconds; defaults to 5"),
              aspect_ratio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]).optional().describe("Defaults to 16:9"),
              resolution: z.enum(["480p", "720p", "1080p"]).optional().describe("Defaults to 480p"),
              wait_seconds: z.number().int().min(0).max(600).optional().describe("Wait up to 600 seconds by default; use 0 only for an explicit detached job"),
            }),
            annotations: { readOnlyHint: false, openWorldHint: false },
          },
          async (args) => {
            try {
              return textResult(await upstreams.generateXaiVideo(args));
            } catch (error) {
              return errorResult(error);
            }
          },
        );
      }

      server.registerTool(
        "speak",
        {
          title: "Text To Speech",
          description:
            "Synthesize the given text into a local speech audio file (Microsoft Edge neural voice, no API key; works on Windows/macOS/Linux - the npm package calls Microsoft's endpoint). Returns the absolute file path of the generated audio (webm/opus) so it can be surfaced in the conversation or used by other tools.",
          inputSchema: z.object({
            text: z.string().min(1).describe("The text to speak aloud. Use short paragraphs for the best result."),
            voice: z.string().optional().describe("Voice name, e.g. zh-CN-XiaoxiaoNeural (Chinese female), en-US-AriaNeural (English female), ja-JP-NanamiNeural (Japanese female). Defaults to zh-CN-XiaoxiaoNeural."),
            output: z.string().optional().describe("Optional absolute file path for the generated audio. Defaults to a temp file."),
          }),
          annotations: { readOnlyHint: false, openWorldHint: false },
        },
        async (args) => {
          try {
            const { ttsSpeak } = await import("./tts.mjs");
            const result = await ttsSpeak(args);
            return textResult([
              "TTS_SPEECH_GENERATED",
              `file: ${result.file}`,
              `bytes: ${result.bytes}`,
              `voice: ${result.voice}`,
              `text: ${result.text}`,
            ].join("\n"));
          } catch (error) {
            return errorResult(error);
          }
        },
      );

      server.registerTool(
        "hear",
        {
          title: "Speech To Text",
          description:
            "Transcribe a local audio file into text using a local engine with no API key: Windows SAPI/System.Speech on Windows, or Apple SpeechAnalyzer/SpeechTranscriber on macOS (requires the ModelDock Mac STT helper). Returns the recognized text and a confidence score.",
          inputSchema: z.object({
            file: z.string().min(1).describe("Absolute local file path of the audio file to transcribe (mp3, wav, webm/opus, m4a)."),
            language: z.string().optional().describe("Optional language hint, e.g. zh-CN, en-US. Defaults to an installed Windows recognizer or Apple automatic selection."),
            output: z.string().optional().describe("Optional absolute path for the intermediate WAV when conversion is needed."),
          }),
          // Not read-only: sttTranscribe can transcode audio to WAV with
          // `ffmpeg -y`, at `output` when the caller supplies one.
          annotations: { readOnlyHint: false, openWorldHint: false },
        },
        async (args) => {
          try {
            const { sttTranscribe } = await import("./stt.mjs");
            const result = await sttTranscribe(args);
            return textResult([
              "STT_TRANSCRIPTION_COMPLETED",
              `text: ${result.text}`,
              `confidence: ${result.confidence.toFixed(3)}`,
              `language: ${result.language}`,
            ].join("\n"));
          } catch (error) {
            return errorResult(error);
          }
        },
      );

      if (typeof upstreams.recallMemory === "function") {
        server.registerTool(
          "recall_memory",
          {
            title: "Recall Memory",
            description:
              "Search this project's persistent memory: past decisions, frozen baselines, user preferences and reusable knowledge written across sessions. Call this when the task depends on earlier work, specific parameters, or facts not present in the current conversation. Returns ranked snippets with their source file. Each hit includes a stable key; pass it back to store_memory to update or correct that entry.",
            inputSchema: recallInputSchema,
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
          async (args) => {
            try {
              return textResult(await upstreams.recallMemory(args));
            } catch (error) {
              return errorResult(error);
            }
          },
        );
      }

      if (typeof upstreams.storeMemory === "function") {
        server.registerTool(
          "store_memory",
          {
            title: "Store Memory",
            description:
              "Persist a fact, decision, preference, correction, or baseline into this project's long-term memory vault so future sessions can recall it with recall_memory. Call this when something reusable happened in this conversation: a stable preference, a hard-won fix, a frozen baseline, a project fact, or a correction. Do not store one-off task details or transient state. To correct or replace an earlier memory, recall it first and reuse its key from the result - storing under the same key supersedes the old revision.",
            inputSchema: z.object({
              content: z.string().min(1).describe("What to remember, one short paragraph"),
              scope_dir: z.string().optional().describe("Absolute working directory this memory applies to; omit to use the session working directory"),
              kind: z
                .enum(["decision", "preference", "baseline", "knowledge", "correction"])
                .optional()
                .describe("Memory kind, used as its recall heading; defaults to knowledge"),
              key: z.string().optional().describe("Stable key from recall_memory results; reuse the same key to update or correct an existing entry instead of appending a new one"),
            }),
            annotations: { readOnlyHint: false, openWorldHint: false },
          },
          async (args) => {
            try {
              return textResult(await upstreams.storeMemory(args));
            } catch (error) {
              return errorResult(error);
            }
          },
        );
      }

      if (typeof upstreams.learnMemory === "function") {
        server.registerTool(
          "learn",
          {
            title: "Learn Knowledge",
            description:
              "Ingest a local knowledge file or every markdown/text file directly under a directory into this project's persistent memory, chunked by `#` heading. Call this to bulk-load a knowledge base, frozen baseline, or reference material before reasoning from it. Unchanged files are skipped and changed files supersede their previous revision, so the newest version wins recall. This tool reads text only: for pdf/docx/pptx/xlsx, first extract the text with the bundled Python from load_workspace_dependencies (pdfplumber / python-docx / python-pptx / openpyxl), then pass the extracted text file here; for scanned pages, use vision_inspect with mode=ocr instead.",
            inputSchema: z.object({
              path: z.string().min(1).describe("Absolute path to a file or directory of markdown/text/json files to ingest"),
              scope_dir: z.string().optional().describe("Absolute working directory this memory applies to; omit to use the session working directory"),
            }),
            annotations: { readOnlyHint: false, openWorldHint: false },
          },
          async (args) => {
            try {
              return textResult(await upstreams.learnMemory(args));
            } catch (error) {
              return errorResult(error);
            }
          },
        );
      }

  return server;
}

export function createMcpNodeHandler({ upstreams, onError = () => {} }) {
  const handler = createMcpHandler(
    () => createMcpServer({ upstreams, acceptScopeOnly: true }),
    { legacy: "stateless", onerror: onError },
  );
  const nodeHandler = toNodeHandler(handler);
  nodeHandler.close = () => handler.close();
  return nodeHandler;
}
