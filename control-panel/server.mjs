import http from "node:http";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLatestReleaseReader } from "./latest-release.mjs";
import { createAccountUsageReader } from "./account-usage.mjs";
import { allowsManagementRoute } from "./management-routes.mjs";
import { accountLabels } from "./account-labels.mjs";
import { enrollmentFromEnvironment } from "./client-enrollment.mjs";
import { quotaAdmissionFromEnvironment } from "./quota-admission.mjs";

const gzipAsync = promisify(gzip);
const defaultRoot = fileURLToPath(new URL("./dist/", import.meta.url));
const routes = new Map([
  ["/config", ["GET"]],
  ["/config/access/api-keys", ["PUT"]],
  ["/config/api-keys/openai-compatibility", ["PUT"]],
  ["/config/routing", ["PATCH"]],
  ["/config/observability", ["PATCH"]],
  ["/credentials", ["GET", "POST", "DELETE"]],
  ["/accounts/usage", ["GET"]],
  ["/database", ["GET"]],
  ["/database/check", ["POST"]],
  ["/database/apply", ["POST"]],
  ["/affinity/state", ["GET"]],
  ["/affinity/policy", ["PUT"]],
  ["/affinity/prices", ["POST"]],
  ["/oauth/auth-url", ["GET"]],
  ["/oauth/status", ["GET"]],
  ["/oauth/session", ["DELETE"]],
  ["/oauth/callback", ["POST"]],
  ["/observability/logs", ["GET", "DELETE"]],
  ["/observability/usage/api-keys", ["GET"]],
]);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export function createPanelServer({
  upstream,
  inferenceURL,
  managementKey,
  origins,
  staticRoot = defaultRoot,
  affinityURL = process.env.AFFINITY_CONTROL_URL,
  affinityToken = process.env.AFFINITY_CONTROL_TOKEN,
  accountUsageReader,
  databaseManager,
  databaseTransfer,
  integrations,
  affinityIdentityKey = process.env.AFFINITY_ID_KEY,
  clientEnrollment,
  runtimeEnvironment = process.env,
  latestReleaseReader = createLatestReleaseReader(),
}) {
  const allowedOrigins = new Set(origins);
  const allowedHosts = new Set(origins.map((origin) => new URL(origin).host));
  if (!managementKey) throw new Error("MANAGEMENT_KEY is required.");
  const upstreamURL = new URL(upstream);
  if (!["http:", "https:"].includes(upstreamURL.protocol))
    throw new Error("Invalid PROXY_URL.");
  // Strict deployments expose management and inference on separate listeners.
  const healthURL = inferenceURL
    ? new URL("/readyz", inferenceURL)
    : new URL("/healthz", upstreamURL);
  if (!["http:", "https:"].includes(healthURL.protocol))
    throw new Error("Invalid INFERENCE_PROXY_URL.");
  const readAccountUsage =
    accountUsageReader ||
    createAccountUsageReader({
      upstreamURL,
      managementKey,
      quotaAdmission: quotaAdmissionFromEnvironment({
        url: affinityURL,
        token: affinityToken,
        key: affinityIdentityKey,
      }),
    });
  const enrollment =
    clientEnrollment ||
    enrollmentFromEnvironment({
      upstream,
      managementKey,
      integrations,
      affinityURL,
      affinityToken,
      affinityIdentityKey,
    });

  return http.createServer(async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
    try {
      // Host and Origin checks protect the credential-injecting local bridge.
      if (!allowedHosts.has(req.headers.host))
        return json(403, { error: "Unrecognized panel host." });
      const url = new URL(req.url, "http://panel.invalid");
      // The CLI exchanges a bearer setup ticket here, never a management credential.
      // Browser origins are rejected: this endpoint is only for installed shell scripts.
      if (url.pathname === "/client-setup/probe") {
        if (req.method !== "GET")
          return json(405, { error: "Method not allowed." });
        const lan = integrations && (await integrations.status()).lanAccess;
        if (!lan?.enabled || !lan.probeId)
          return json(404, { error: "LAN access is not configured." });
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
        return res.end(`CRAP-LAN-1:${lan.probeId}\n`);
      }
      if (url.pathname === "/client-setup/redeem") {
        if (req.method !== "POST")
          return json(405, { error: "Method not allowed." });
        if (req.headers.origin || req.headers["sec-fetch-site"])
          return json(403, { error: "Use the downloaded installer." });
        if (!enrollment)
          return json(503, {
            error: "Client enrollment requires workspace storage.",
          });
        let token = "";
        for await (const chunk of req) {
          token += chunk;
          if (token.length > 64)
            return json(400, { error: "Invalid setup token." });
        }
        try {
          const result = await enrollment.redeem(token);
          res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          });
          return res.end(result);
        } catch (error) {
          return json(error.status || 503, {
            error: error.status
              ? error.message
              : "Enrollment storage is unavailable.",
          });
        }
      }
      if (url.pathname.startsWith("/client-setup/")) {
        const assets = {
          "crap.ps1": "text/plain",
          "crap.sh": "text/plain",
          "guide.md": "text/markdown",
        };
        const name = url.pathname.slice("/client-setup/".length);
        if (!Object.hasOwn(assets, name))
          return json(404, { error: "Unknown client setup file." });
        if (req.method !== "GET")
          return json(405, { error: "Method not allowed." });
        const content = await readFile(
          new URL(`./client-shell/${name}`, import.meta.url),
        );
        res.writeHead(200, {
          "Content-Type": `${assets[name]}; charset=utf-8`,
          "Cache-Control": "no-store",
          ...(name === "guide.md"
            ? {}
            : { "Content-Disposition": `attachment; filename="${name}"` }),
        });
        return res.end(content);
      }
      if (url.pathname.startsWith("/api/")) {
        if (
          req.headers["x-panel-client"] !== "cliproxy-panel" ||
          (req.headers.origin && !allowedOrigins.has(req.headers.origin)) ||
          req.headers["sec-fetch-site"] === "cross-site"
        ) {
          return json(403, {
            error: "This API is available only to the local control panel.",
          });
        }
        const endpoint = url.pathname.slice(4);
        if (endpoint === "/server/latest-version") {
          if (req.method !== "GET")
            return json(405, { error: "Method not allowed." });
          try {
            return json(200, await latestReleaseReader());
          } catch {
            return json(503, {
              error:
                "GitHub release information is unavailable or rate-limited. Try again later.",
            });
          }
        }
        if (endpoint === "/runtime") {
          if (req.method !== "GET")
            return json(405, { error: "Method not allowed." });
          // Report only a runtime category, never cluster addresses or host details.
          return json(200, {
            deployment: runtimeEnvironment.KUBERNETES_SERVICE_HOST
              ? "kubernetes"
              : "unknown",
          });
        }
        if (endpoint === "/client-enrollment") {
          if (!enrollment)
            return json(503, {
              error: "Client enrollment requires workspace storage.",
            });
          try {
            if (req.method === "GET") return json(200, await enrollment.list());
            if (!["POST", "DELETE"].includes(req.method))
              return json(405, { error: "Method not allowed." });
            let body = "";
            for await (const chunk of req) {
              body += chunk;
              if (body.length > 4096)
                return json(413, { error: "Setup request is too large." });
            }
            const input = JSON.parse(body || "{}");
            if (req.method === "DELETE") {
              await enrollment.remove(input.id, {
                recover: input.recover === true,
              });
              return json(200, { ok: true });
            }
            // Only a validated panel origin may be used as the local return address.
            const localOrigin =
              req.headers.origin ||
              origins.find((value) => new URL(value).host === req.headers.host);
            return json(201, await enrollment.create(input, localOrigin));
          } catch (error) {
            return json(error.status || 503, {
              error: error.status
                ? error.message
                : "Could not prepare client setup. Check workspace storage.",
            });
          }
        }
        if (
          endpoint === "/integrations" ||
          endpoint.startsWith("/integrations/")
        ) {
          if (!integrations)
            return json(503, {
              error: "Integrations are not configured on this host.",
            });
          try {
            if (endpoint === "/integrations" && req.method === "GET")
              return json(200, await integrations.status());
            if (req.method !== "POST")
              return json(405, { error: "Method not allowed." });
            let body = "";
            for await (const chunk of req) {
              body += chunk;
              if (body.length > 16384)
                return json(413, {
                  error: "Integration request is too large.",
                });
            }
            return json(
              200,
              await integrations.action(
                endpoint.slice("/integrations/".length),
                JSON.parse(body || "{}"),
              ),
            );
          } catch (error) {
            return json(409, {
              error:
                error instanceof SyntaxError
                  ? "Invalid integration request."
                  : error.message,
            });
          }
        }
        if (endpoint.startsWith("/database/transfer")) {
          if (!databaseTransfer)
            return json(503, {
              error: "Database transfers are not enabled on this host.",
            });
          try {
            if (endpoint === "/database/transfer" && req.method === "GET")
              return json(200, await databaseTransfer.status());
            if (
              endpoint === "/database/transfer/download" &&
              req.method === "GET"
            ) {
              const file = await databaseTransfer.download();
              const info = await stat(file);
              res.writeHead(200, {
                "Content-Type": "application/octet-stream",
                "Content-Length": info.size,
                "Content-Disposition": "attachment; filename=workspace.crapdb",
                "Cache-Control": "no-store",
              });
              await pipeline(createReadStream(file), res);
              return;
            }
            if (
              endpoint === "/database/transfer/upload" &&
              req.method === "POST"
            )
              return json(201, await databaseTransfer.upload(req));
            if (
              [
                "/database/transfer/start",
                "/database/transfer/resume",
              ].includes(endpoint) &&
              req.method === "POST"
            ) {
              let body = "";
              for await (const chunk of req) {
                body += chunk;
                if (body.length > 100000)
                  return json(413, { error: "Transfer request is too large." });
              }
              const input = JSON.parse(body);
              if (endpoint.endsWith("/resume"))
                return json(200, await databaseTransfer.resume(input.confirm));
              return json(202, await databaseTransfer.start(input));
            }
            return json(404, { error: "Transfer operation not found." });
          } catch (error) {
            if (res.headersSent) {
              res.destroy();
              return;
            }
            return json(409, {
              error:
                error instanceof SyntaxError
                  ? "Invalid transfer request."
                  : error.message,
            });
          }
        }
        if (endpoint === "/database" || endpoint.startsWith("/database/")) {
          if (!databaseManager)
            return json(503, {
              error: "Managed database setup is not enabled on this host.",
              available: false,
            });
          try {
            if (endpoint === "/database" && req.method === "GET")
              return json(200, await databaseManager.status());
            if (endpoint === "/database/check" && req.method === "POST")
              return json(200, await databaseManager.check());
            if (endpoint === "/database/apply" && req.method === "POST") {
              let body = "";
              for await (const chunk of req) {
                body += chunk;
                if (body.length > 1024)
                  return json(413, { error: "Request is too large." });
              }
              if (JSON.parse(body).confirm !== "migrate-local-proxy")
                return json(400, {
                  error: "Confirm the local credential migration first.",
                });
              return json(202, await databaseManager.apply());
            }
            return json(404, { error: "Database operation not found." });
          } catch (error) {
            return json(409, {
              error:
                error instanceof SyntaxError
                  ? "Invalid setup request."
                  : error.message,
            });
          }
        }
        if (
          endpoint !== "/health" &&
          !routes.get(endpoint)?.includes(req.method) &&
          !allowsManagementRoute(endpoint, req.method)
        ) {
          return json(404, { error: "Panel endpoint not found." });
        }
        if (endpoint === "/health" && req.method !== "GET")
          return json(405, { error: "Method not allowed." });
        if (endpoint.startsWith("/affinity/")) {
          if (!affinityURL || !affinityToken)
            return json(503, {
              error: "The affinity control service is not configured.",
            });
          let body;
          if (req.method === "PUT" || req.method === "POST") {
            const chunks = [];
            let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > 16384)
                return json(413, { error: "Policy is too large." });
              chunks.push(chunk);
            }
            body = Buffer.concat(chunks);
          }
          try {
            const result = await fetch(
              new URL(endpoint.slice("/affinity".length), affinityURL),
              {
                method: req.method,
                headers: {
                  Authorization: `Bearer ${affinityToken}`,
                  "Content-Type": "application/json",
                },
                body,
                redirect: "error",
              },
            );
            const value = await result.json();
            if (endpoint === "/affinity/state" && result.ok) {
              value.accountLabels = {};
              if (affinityIdentityKey) {
                try {
                  const response = await fetch(
                    new URL("/v8/management/credentials", upstreamURL),
                    {
                      headers: { Authorization: `Bearer ${managementKey}` },
                      redirect: "error",
                    },
                  );
                  if (response.ok)
                    value.accountLabels = accountLabels(
                      (await response.json()).files,
                      affinityIdentityKey,
                    );
                } catch {
                  // Keep historical records available if the proxy is offline.
                }
              }
              try {
                const host = await fetch(
                  new URL("/v8/management/plugins", upstreamURL),
                  {
                    headers: { Authorization: `Bearer ${managementKey}` },
                    redirect: "error",
                  },
                );
                const plugins = await host.json();
                value.pluginRegistered =
                  host.ok &&
                  plugins.plugins?.some(
                    (plugin) =>
                      plugin.id === "affinity-router" &&
                      plugin.registered &&
                      plugin.effective_enabled,
                  ) === true;
              } catch {
                value.pluginRegistered = false;
              }
            }
            return json(result.status, value);
          } catch {
            return json(503, {
              error: "The affinity control service is unavailable.",
            });
          }
        }
        if (endpoint === "/accounts/usage") {
          const authIndex = url.searchParams.get("auth_index")?.trim();
          if (!authIndex)
            return json(400, { error: "An account is required." });
          try {
            return json(
              200,
              await readAccountUsage(authIndex, {
                refreshPlan: url.searchParams.get("refresh_plan") === "1",
              }),
            );
          } catch (error) {
            return json(502, { error: error.message });
          }
        }
        // The upstream treats an absent state as success. Never allow an
        // unbound status/cancel request to produce a false login result.
        if (
          (endpoint === "/oauth/status" || endpoint === "/oauth/session") &&
          !url.searchParams.get("state")?.trim()
        )
          return json(400, { error: "An OAuth session state is required." });
        let body;
        if (!["GET", "HEAD"].includes(req.method)) {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 2 * 1024 * 1024)
              return json(413, { error: "Request exceeds the 2 MB limit." });
            chunks.push(chunk);
          }
          body = Buffer.concat(chunks);
        }
        if (endpoint === "/health") {
          // Readiness must not send the management secret to the public gateway.
          const result = await fetch(healthURL, { redirect: "error" });
          await result.arrayBuffer();
          return result.ok
            ? json(200, { status: "ok" })
            : json(result.status, { error: "The proxy gateway is not ready." });
        }
        const target = new URL(
          `/v8/management${endpoint === "/admin/config" ? "/config" : endpoint}`,
          upstreamURL,
        );
        target.search = url.search;
        const headers = { Authorization: `Bearer ${managementKey}` };
        if (req.headers["content-type"])
          headers["Content-Type"] = req.headers["content-type"];
        const result = await fetch(target, {
          method: req.method,
          headers,
          body,
          redirect: "error",
        });
        const version = result.headers.get("x-cpa-version");
        if (version) res.setHeader("X-CPA-Version", version);
        if (endpoint === "/config" && result.ok) {
          const config = await result.json();
          // Never return the management hash or unrelated transport secrets to the browser.
          return json(200, {
            access: config.access ?? {},
            "api-keys": config["api-keys"] ?? {},
            routing: config.routing ?? {},
            observability: config.observability ?? {},
          });
        }
        // Refresh responses can contain the entire credential, including tokens.
        if (endpoint === "/credentials/refresh" && result.ok) {
          const refreshed = await result.json();
          return json(result.status, {
            ok: refreshed.ok,
            results: Array.isArray(refreshed.results)
              ? refreshed.results.map((item) => ({
                  id: item.id,
                  success: item.success,
                  error: item.error,
                }))
              : undefined,
          });
        }
        res.writeHead(result.status, {
          "Content-Type":
            result.headers.get("content-type") ?? "application/json",
          "Cache-Control": "no-store",
        });
        res.end(Buffer.from(await result.arrayBuffer()));
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        return json(405, { error: "Method not allowed." });
      const decoded = decodeURIComponent(url.pathname);
      const filename = path.resolve(staticRoot, `.${decoded}`);
      if (!filename.startsWith(path.resolve(staticRoot) + path.sep)) {
        if (decoded !== "/") return json(404, { error: "Not found." });
      }
      let asset =
        decoded === "/" ? path.join(staticRoot, "index.html") : filename;
      try {
        if (!(await stat(asset)).isFile()) throw new Error("Not a file");
      } catch {
        return json(404, { error: "Not found." });
      }
      const data = await readFile(asset);
      const extension = path.extname(asset);
      const fingerprinted =
        /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css|woff2|svg|png)$/.test(
          decoded,
        );
      const compressible = [".html", ".js", ".css", ".svg"].includes(extension);
      const encodings = new Map(
        (req.headers["accept-encoding"] ?? "").split(",").map((entry) => {
          const [name, ...parameters] = entry.trim().toLowerCase().split(";");
          const quality = parameters
            .map((part) => part.trim())
            .find((part) => part.startsWith("q="));
          return [name, quality ? Number(quality.slice(2)) : 1];
        }),
      );
      const compressed =
        compressible &&
        data.length >= 1024 &&
        (encodings.get("gzip") ?? encodings.get("*") ?? 0) > 0;
      const body = compressed ? await gzipAsync(data) : data;
      res.writeHead(200, {
        "Content-Type": mime[extension] ?? "application/octet-stream",
        "Cache-Control": fingerprinted
          ? "private, max-age=31536000, immutable"
          : "no-cache",
        ...(compressible ? { Vary: "Accept-Encoding" } : {}),
        ...(compressed ? { "Content-Encoding": "gzip" } : {}),
        "Content-Length": body.length,
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      // Do not log request bodies, upstream credentials, or full configuration.
      if (!res.headersSent)
        json(502, {
          error:
            "CLIProxyAPI is unavailable. Check that the proxy container is running.",
        });
      else res.end();
    }
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = createPanelServer({
    upstream: process.env.PROXY_URL ?? "http://127.0.0.1:8317",
    inferenceURL: process.env.INFERENCE_PROXY_URL,
    managementKey: process.env.MANAGEMENT_KEY,
    origins: (
      process.env.PANEL_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000"
    ).split(","),
  });
  server.listen(
    Number(process.env.PORT ?? 3000),
    process.env.HOST ?? "127.0.0.1",
    () =>
      console.log(
        "CLIProxy control panel is ready on port " + (process.env.PORT ?? 3000),
      ),
  );
}
