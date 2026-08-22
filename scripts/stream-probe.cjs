// End-to-end SSE stream probe used by verify-release-install.ps1.
//
// Two modes:
//   upstream --portfile <path>   Serve a minimal SSE Responses upstream. Writes
//                                the bound port to <path>, then keeps serving
//                                until the parent closes stdin.
//   client --gateway <url> --keyfile <path>
//                                POST /c/<key>/v1/responses to the gateway,
//                                read the SSE stream until response.completed,
//                                then close the connection after the terminal
//                                event, exercising that gateway state transition,
//                                and finally assert via /api/status that
//                                the gateway recorded the request as 200 - not
//                                as a 499 client-disconnect.
"use strict";

const http = require("node:http");
const fs = require("node:fs");

function usage() {
  console.error("usage: stream-probe.cjs upstream --portfile <path> | client --gateway <url> --keyfile <path>");
  process.exit(2);
}

const args = process.argv.slice(2);
const mode = args[0];
const options = {};
for (let i = 1; i < args.length; i += 1) {
  if (args[i] === "--portfile") options.portfile = args[i + 1];
  if (args[i] === "--gateway") options.gateway = args[i + 1];
  if (args[i] === "--keyfile") options.keyfile = args[i + 1];
}

function fail(message) {
  console.error(`stream-probe: ${message}`);
  process.exit(1);
}

async function runUpstream() {
  if (!options.portfile) usage();
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    req.resume();
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (type, data) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    };
    send("response.created", { response: { id: "probe-1", object: "response", status: "in_progress" } });
    send("response.output_item.added", {
      output_index: 0,
      item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello from probe" }] },
    });
    send("response.completed", {
      response: {
        id: "probe-1",
        object: "response",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello from probe" }] }],
        usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
      },
    });
    // Keep the socket open briefly so the client has a chance to close first,
    // mirroring how a real upstream holds the stream past the terminal event.
    const keepAlive = setInterval(() => res.write(":\n\n"), 500);
    res.on("close", () => {
      clearInterval(keepAlive);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  fs.writeFileSync(options.portfile, String(address.port), "utf8");
  process.stdin.resume();
}

async function runClient() {
  if (!options.gateway || !options.keyfile) usage();
  const key = fs.readFileSync(options.keyfile, "utf8").trim();
  const base = options.gateway.replace(/\/+$/, "");
  const target = `${base}/c/${encodeURIComponent(key)}/v1/responses`;
  const body = JSON.stringify({
    model: "deepseek-v4-flash",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    stream: true,
  });

  const completed = await new Promise((resolve, reject) => {
    const req = http.request(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 20_000,
    });
    let sawCompleted = false;
    let buffer = "";
    req.on("response", (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`gateway returned ${res.statusCode}`));
        return;
      }
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
          if (!dataLine) continue;
          try {
            const payload = JSON.parse(dataLine.slice(5).trim());
            if (payload.type === "response.completed") {
              sawCompleted = true;
              // Codex closes the HTTP response after receiving the terminal
              // event. Keep the upstream socket alive long enough for this
              // close to reach the gateway and exercise its bookkeeping.
              setImmediate(() => res.destroy());
            }
          } catch { /* keep scanning */ }
        }
      });
      res.on("end", () => resolve(sawCompleted));
      res.on("close", () => resolve(sawCompleted));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("probe request timed out"));
    });
    req.end(body);
  });
  if (!completed) fail("did not observe response.completed before the stream ended");
  console.log("stream-probe: response.completed observed");

  // Give the gateway a moment to settle its finish bookkeeping, then assert the
  // request was recorded as a normal completion, not a 499 disconnect.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const status = await fetch(`${base}/api/status`);
  if (!status.ok) fail(`api/status returned ${status.status}`);
  const payload = await status.json();
  const recent = payload.recent || [];
  const responseRecord = recent.find((record) => record.kind === "responses" && record.httpStatus !== undefined);
  if (!responseRecord) fail("no responses record found in api/status");
  if (responseRecord.httpStatus === 499) {
    fail(`gateway recorded a 499 client-disconnect after response.completed: ${JSON.stringify(responseRecord)}`);
  }
  if (responseRecord.httpStatus !== 200) {
    fail(`gateway recorded httpStatus=${responseRecord.httpStatus}, expected 200`);
  }
  console.log(`stream-probe: gateway recorded httpStatus=200 (${responseRecord.httpStatus})`);
}

if (mode === "upstream") {
  runUpstream().catch((error) => fail(error.message));
} else if (mode === "client") {
  runClient().catch((error) => fail(error.message));
} else {
  usage();
}
