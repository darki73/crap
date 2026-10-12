import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createIntegrationStore } from "./integrations.mjs";
import { localAPIOrigin } from "./local-api-origin.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message, status = 409) =>
  Object.assign(new Error(message), { status });
function origin(value) {
  const u = new URL(value);
  if (
    !/^(https:\/\/[a-zA-Z0-9.-]+(?::\d+)?|http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?)$/.test(
      value,
    ) ||
    u.username ||
    u.password
  )
    throw fail("A secure client address is required.");
  return u.origin;
}

// Enrollment shares the encrypted, versioned PostgreSQL integration document.
// Tokens are stored only as hashes. Consuming a token is committed before key creation.
export function createClientEnrollment({
  store,
  upstream,
  managementKey,
  integrations,
  now = Date.now,
  fetcher = fetch,
}) {
  const active = new Set();
  async function change(fn) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const d = await store.load();
      d.data.clientEnrollments ??= [];
      const result = fn(d.data);
      try {
        await store.save(d);
        return result;
      } catch (error) {
        if (!error.message.includes("settings changed") || attempt === 4)
          throw error;
      }
    }
  }
  async function config(method = "GET", body) {
    const r = await fetcher(
      new URL("/v8/management/config/access/api-keys", upstream),
      {
        method,
        headers: {
          Authorization: `Bearer ${managementKey}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
      },
    );
    if (!r.ok)
      throw fail("Could not update client keys. Check the proxy connection.");
    return method === "GET" ? r.json() : undefined;
  }
  return {
    async list() {
      const d = await store.load();
      return (d.data.clientEnrollments || []).map(
        ({ id, name, createdAt, expiresAt, status, keyHash, suffix }) => ({
          id,
          name,
          createdAt,
          expiresAt,
          status:
            status === "pending" && expiresAt <= now() ? "expired" : status,
          keyHash,
          suffix,
        }),
      );
    },
    async create(input, localOrigin) {
      const name = String(input.name || "").trim();
      if (!name || name.length > 60 || /[\x00-\x1f]/.test(name))
        throw fail("Name this computer (1–60 characters).");
      if (
        !["powershell", "bash", "zsh"].includes(input.shell) ||
        !["proxy", "direct"].includes(input.mode)
      )
        throw fail("Choose a supported shell and starting mode.");
      const status = await integrations.status();
      const tail = status.tailscale;
      let apiOrigin, panelOrigin;
      if (tail.enabled && tail.api) {
        if (tail.phase !== "online" || !tail.dashboard)
          throw fail(
            "Enable the Tailscale dashboard and wait for private access to come online.",
          );
        apiOrigin = origin(tail.apiUrl);
        panelOrigin = origin(tail.dashboardUrl);
      } else {
        panelOrigin = origin(localOrigin);
        if (!/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(panelOrigin))
          throw fail("Enable Tailscale inference access for remote setup.");
        apiOrigin = localAPIOrigin(status.localApiOrigin);
      }
      const token = randomBytes(32).toString("hex"),
        id = randomUUID(),
        expiresAt = now() + 15 * 60_000;
      const file = input.shell === "powershell" ? "crap.ps1" : "crap.sh";
      const source = await readFile(
        new URL(`./client-shell/${file}`, import.meta.url),
        "utf8",
      );
      const cleanup = input.cleanup !== false;
      const payload =
        input.shell === "powershell"
          ? `\n# CRAP enrollment payload\nif ($Install) { Complete-CrapEnrollment '${panelOrigin}' '${token}' '${input.mode}' $${cleanup ? "true" : "false"} $PSCommandPath }\n`
          : `\n# CRAP enrollment payload\nif [ "$crap_install_result" = 0 ] && [ "\${1-}" = install ]; then\n  _crap_enroll '${panelOrigin}' '${token}' '${input.mode}' '${cleanup ? "yes" : "no"}' "$crap_source_file"\nfi\n`;
      await change((d) => {
        // Never silently discard devices with issued keys.
        d.clientEnrollments = d.clientEnrollments.filter(
          (x) => x.status !== "pending" || x.expiresAt > now(),
        );
        if (d.clientEnrollments.length >= 250)
          throw fail("Too many setup records. Remove unused devices first.");
        d.clientEnrollments.push({
          id,
          name,
          tokenHash: hash(token),
          createdAt: now(),
          expiresAt,
          status: "pending",
          apiOrigin,
        });
      });
      return {
        id,
        filename: file,
        content: source + payload,
        expiresAt,
        apiOrigin,
      };
    },
    async redeem(token) {
      if (!/^[a-f0-9]{64}$/.test(token))
        throw fail(
          "Setup token is invalid or expired. Download a new installer.",
          410,
        );
      const key = `crap-${randomBytes(24).toString("hex")}`;
      const record = await change((d) => {
        const r = d.clientEnrollments.find((x) => x.tokenHash === hash(token));
        if (!r || r.status !== "pending" || r.expiresAt <= now())
          throw fail(
            "Setup token has expired or was already used. Download a new installer.",
            410,
          );
        if (d.clientSetupWriting)
          throw fail("Another device is being configured. Try again shortly.");
        d.clientSetupWriting = r.id;
        r.status = "issuing";
        r.keyHash = hash(key);
        r.suffix = key.slice(-4);
        delete r.tokenHash;
        return { ...r };
      });
      active.add(record.id);
      try {
        const keys = await config();
        if (!Array.isArray(keys) || !keys.length)
          throw fail(
            "Create the first workspace API key before enrolling a device.",
          );
        await config("PUT", [...keys, key]);
        const verified = await config();
        if (!verified.includes(key))
          throw fail("The proxy did not retain the new key.");
        await change((d) => {
          d.clientEnrollments.find((r) => r.id === record.id).status =
            "installed";
          delete d.clientSetupWriting;
        });
        return `CRAP-ENROLLMENT-1\n${record.apiOrigin}\n${key}\n`;
      } catch {
        await change((d) => {
          d.clientEnrollments.find((r) => r.id === record.id).status =
            "uncertain";
          delete d.clientSetupWriting;
        }).catch(() => {});
        throw fail(
          "Setup could not finish. Its token is consumed; remove this device's key in Client API Keys before downloading another installer.",
        );
      } finally {
        active.delete(record.id);
      }
    },
    async remove(id, { recover = false } = {}) {
      // Removing a record also revokes any issued key, including uncertain deliveries.
      const record = await change((d) => {
        if (
          d.clientSetupWriting &&
          !(recover && d.clientSetupWriting === id && !active.has(id))
        )
          throw fail(
            "Key issuance is in progress. Recovery is available only after the previous setup process has stopped.",
          );
        const r = d.clientEnrollments.find((x) => x.id === id);
        if (!r) throw fail("Device not found.", 404);
        d.clientSetupWriting = id;
        r.status = "revoking";
        delete r.tokenHash;
        return { ...r };
      });
      active.add(id);
      try {
        if (record.keyHash) {
          const keys = await config(),
            next = keys.filter((key) => hash(key) !== record.keyHash);
          if (!next.length)
            throw fail("Keep at least one workspace key enabled.");
          if (next.length !== keys.length) await config("PUT", next);
        }
        await change((d) => {
          d.clientEnrollments = d.clientEnrollments.filter((r) => r.id !== id);
          delete d.clientSetupWriting;
        });
      } catch (error) {
        await change((d) => {
          delete d.clientSetupWriting;
        }).catch(() => {});
        throw error;
      } finally {
        active.delete(id);
      }
    },
  };
}

export function enrollmentFromEnvironment(options) {
  const {
    affinityURL: url,
    affinityToken: token,
    affinityIdentityKey: key,
  } = options;
  if (!url || !token || !key || !options.integrations) return undefined;
  return createClientEnrollment({
    ...options,
    store: createIntegrationStore({ url, token, key }),
  });
}
