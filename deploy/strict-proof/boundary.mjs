// Disposable architecture probe, NOT a production ingress or general proxy.
import http from "node:http";
import net from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { once } from "node:events";

const executions = new Map();
const authID = (key) =>
  "claude:apikey:" +
  createHash("sha256")
    .update(
      ["claude:apikey", key, "https://provider:8443", "", "", ""].join("\0"),
    )
    .digest("hex")
    .slice(0, 12);
const policy = { account: "fixture-a", fault: false, deny: false, skip: false };
const audit = {
  admissions: 0,
  connects: 0,
  denied: 0,
  revoked: 0,
  lastTicket: null,
};
async function body(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 1024 * 1024) throw Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
function reject(res) {
  if (!res.headersSent)
    json(res, 503, {
      error: {
        code: "crap_execution_unavailable",
        message: "CRAP could not authorize or complete this execution.",
      },
    });
  else res.destroy();
}
function revoke(ticket) {
  const e = executions.get(ticket);
  if (!e) return;
  executions.delete(ticket);
  audit.revoked++;
  e.abort.abort();
  for (const socket of e.sockets) socket.destroy();
}
function lookup(req) {
  return executions.get(
    (req.headers.authorization || "").replace(/^Bearer /, ""),
  );
}

const server = http.createServer(async (req, res) => {
  try {
    // Test controls are confined to a disposable network with no published ports.
    // They are intentionally not a production API.
    if (req.url === "/fixture/policy" && req.method === "POST") {
      const p = JSON.parse(await body(req));
      if (
        p.account &&
        !["fixture-a", "fixture-b", "missing"].includes(p.account)
      )
        return json(res, 400, {});
      Object.assign(policy, p);
      return json(res, 200, policy);
    }
    if (req.url === "/fixture/state")
      return json(res, 200, { ...audit, active: executions.size });
    if (req.url === "/claim" && req.method === "POST") {
      const e = lookup(req);
      if (!e || e.claimed) return res.writeHead(410).end();
      e.claimed = true;
      return json(res, 200, {
        auth_id: e.authID,
        body: e.payload.toString("base64"),
        stream: e.stream,
        fault: e.fault,
      });
    }
    if (req.url === "/relay" && req.method === "POST") {
      const e = lookup(req);
      if (!e) return res.writeHead(410).end();
      const frame = JSON.parse(await body(req));
      if (
        frame.kind !== "admit" ||
        !e.claimed ||
        e.admitted ||
        frame.auth_id !== e.authID
      )
        return res.writeHead(403).end();
      e.admitted = true;
      audit.admissions++;
      return res.writeHead(204).end();
    }
    if (req.url !== "/v1/messages" || req.method !== "POST")
      return json(res, 404, { error: "unsupported proof route" });
    if (req.headers.authorization !== "Bearer disposable-proof-client")
      return json(res, 401, { error: "unauthorized" });
    if (policy.deny) return reject(res);
    const payload = await body(req),
      parsed = JSON.parse(payload);
    if (parsed.model !== "claude-fixture")
      return json(res, 400, { error: "unsupported proof model" });
    const ticket = randomBytes(32).toString("hex");
    const e = {
      authID:
        policy.account === "missing"
          ? "nonexistent-auth"
          : authID(policy.account),
      payload,
      fault: policy.fault,
      stream: !!parsed.stream,
      admitted: false,
      sockets: new Set(),
      abort: new AbortController(),
    };
    executions.set(ticket, e);
    audit.lastTicket = ticket;
    res.on("close", () => {
      if (!res.writableFinished) revoke(ticket);
    });
    try {
      // Only the plugin owns this internal model. The actual untouched client
      // payload and routing choice are fetched once using the private grant.
      const result = await fetch("http://proxy:8317/v1/messages", {
        method: "POST",
        redirect: "error",
        signal: e.abort.signal,
        headers: {
          authorization: "Bearer disposable-proof-client",
          "content-type": "application/json",
          "x-crap-execution": ticket,
          "x-proof-skip": String(policy.skip),
        },
        body: JSON.stringify({ ...parsed, model: "crap-strict-proof" }),
      });
      if (!result.ok || !e.admitted) {
        console.error(
          "Fixture execution rejected:",
          result.status,
          await result.text(),
        );
        throw Error("execution rejected");
      }
      res.writeHead(result.status, {
        "content-type":
          result.headers.get("content-type") || "application/json",
      });
      res.flushHeaders();
      for await (const chunk of result.body) {
        if (!res.write(chunk))
          await Promise.race([once(res, "drain"), once(res, "close")]);
      }
      res.end();
    } catch {
      reject(res);
    } finally {
      revoke(ticket);
    }
  } catch {
    reject(res);
  }
});
server.listen(8320, "0.0.0.0");

// A grant is execution-scoped, not an assertion that CONNECT exposes account
// headers. Exact account selection is enforced by the pinned host callback.
// Revocation closes ALL tunnels, preventing reuse after execution completion.
const outbound = http.createServer((req, res) => {
  audit.denied++;
  res.writeHead(403).end();
});
outbound.on("connect", (req, socket, head) => {
  const basic = (req.headers["proxy-authorization"] || "").replace(
    /^Basic /,
    "",
  );
  const auth = Buffer.from(basic, "base64").toString();
  const ticket = auth.startsWith("execution:") ? auth.slice(10) : "";
  const e = executions.get(ticket);
  if (!e?.admitted || req.url !== "provider:8443") {
    audit.denied++;
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  const upstream = net.connect(8443, "provider");
  e.sockets.add(socket);
  e.sockets.add(upstream);
  const cleanup = () => {
    socket.destroy();
    upstream.destroy();
    e.sockets.delete(socket);
    e.sockets.delete(upstream);
  };
  socket.on("error", cleanup);
  upstream.on("error", cleanup);
  socket.on("close", cleanup);
  upstream.on("close", cleanup);
  upstream.on("connect", () => {
    if (!executions.has(ticket)) {
      cleanup();
      return;
    }
    audit.connects++;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
});
outbound.listen(8321, "0.0.0.0");
