// Synthetic OAuth provider. No real credentials, DNS or inference.
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const calls = [];
let behavior = {};
http
  .createServer(async (req, res) => {
    if (req.method === "POST") {
      let b = "";
      for await (const c of req) b += c;
      behavior = JSON.parse(b);
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(calls));
  })
  .listen(8080, "0.0.0.0");
https
  .createServer(
    { key: readFileSync("/test/key.pem"), cert: readFileSync("/test/ca.pem") },
    async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw || "{}");
      res.setHeader("request-id", randomUUID());
      calls.push({ path: req.url, auth: req.headers.authorization, body });
      if (req.url.includes("/api/oauth/")) {
        res.setHeader("content-type", "application/json");
        res.end("{}");
        return;
      }
      if (behavior.status) {
        res.writeHead(behavior.status, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "overloaded_error", message: "Fixture overload" },
          }),
        );
        return;
      }
      res.setHeader(
        "anthropic-ratelimit-unified-7d-utilization",
        String(behavior.used ?? 0.8),
      );
      res.setHeader(
        "anthropic-ratelimit-unified-7d-reset",
        String(Math.floor(Date.now() / 1000) + 86400),
      );
      if (req.url.includes("count_tokens")) {
        res.setHeader("content-type", "application/json");
        res.end('{"input_tokens":42}');
        return;
      }
      const usage = {
        input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_creation: {
          ephemeral_5m_input_tokens: 3,
          ephemeral_1h_input_tokens: 2,
        },
        output_tokens: 7,
      };
      const message = {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "fixture" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage,
      };
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(message));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (type, event) =>
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...event })}\n\n`,
        );
      emit("message_start", {
        message: {
          ...message,
          content: [],
          stop_reason: null,
          usage: { ...usage, output_tokens: 0 },
        },
      });
      if (behavior.hold) return;
      emit("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      });
      emit("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "fixture" },
      });
      emit("content_block_stop", { index: 0 });
      emit("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 7 },
      });
      emit("message_stop", {});
      res.end();
    },
  )
  .listen(443, "0.0.0.0");
