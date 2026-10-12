import https from "node:https";
import http from "node:http";
import { readFileSync } from "node:fs";

// All account identifiers and API keys in this stack are synthetic fixtures.
const calls = [];
let mode = "success",
  released = false;
let waiting = new Set();
https
  .createServer(
    { key: readFileSync("key.pem"), cert: readFileSync("ca.pem") },
    async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const record = {
        account: (
          req.headers["x-api-key"] ||
          req.headers.authorization ||
          ""
        ).replace(/^Bearer /, ""),
        stream: !!body.stream,
        closed: false,
      };
      calls.push(record);
      res.on("close", () => {
        record.closed = true;
      });
      if (mode === "fail-a" && record.account === "fixture-a") {
        res.writeHead(503, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            error: { type: "overloaded_error", message: "fixture unavailable" },
          }),
        );
      }
      const message = {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: "claude-fixture",
        content: [{ type: "text", text: "proof" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      };
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(message));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type, data) =>
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
        );
      event("message_start", {
        message: { ...message, content: [], stop_reason: null },
      });
      event("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      });
      event("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "first" },
      });
      if (mode === "hold" && !released)
        await new Promise((resolve) => {
          waiting.add(resolve);
          res.once("close", resolve);
        });
      if (res.destroyed) return;
      event("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "last" },
      });
      event("content_block_stop", { index: 0 });
      event("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      });
      event("message_stop", {});
      res.end();
    },
  )
  .listen(8443, "0.0.0.0");
http
  .createServer(async (req, res) => {
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks));
      if (body.reset) {
        calls.length = 0;
        released = false;
      }
      if (body.mode) mode = body.mode;
      if (body.release) {
        released = true;
        for (const resolve of waiting) resolve();
        waiting.clear();
      }
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ calls, mode, released }));
  })
  .listen(8444, "0.0.0.0");
