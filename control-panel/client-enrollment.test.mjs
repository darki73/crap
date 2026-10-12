import test from "node:test";
import assert from "node:assert/strict";
import { createClientEnrollment } from "./client-enrollment.mjs";

function fixture() {
  let clock = 1000,
    d = { version: 0, data: { telegram: { token: "provider-secret" } } },
    keys = ["existing-key"],
    failure = false;
  const store = {
    load: async () => structuredClone(d),
    save: async (value) => {
      if (value.version !== d.version)
        throw new Error("Integration settings changed");
      d = structuredClone(value);
      d.version++;
      value.version++;
    },
  };
  const integrations = {
    status: async () => ({
      tailscale: {
        enabled: true,
        dashboard: true,
        api: true,
        phase: "online",
        apiUrl: "https://device.example.ts.net:8443",
        dashboardUrl: "https://device.example.ts.net",
      },
    }),
  };
  const options = {
    store,
    integrations,
    upstream: "http://localhost:8317",
    managementKey: "management-secret",
    now: () => clock,
    fetcher: async (url, options) => {
      assert.equal(url.pathname, "/v8/management/config/access/api-keys");
      assert.equal(options.headers.Authorization, "Bearer management-secret");
      if (options.method === "PUT") {
        keys = JSON.parse(options.body);
        if (failure) throw new Error("lost response");
      }
      return new Response(JSON.stringify(keys));
    },
  };
  return {
    options,
    service: createClientEnrollment(options),
    keys: () => keys,
    document: () => d,
    expire: () => {
      clock += 900001;
    },
    fail: () => {
      failure = true;
    },
    reset: () => {
      failure = false;
    },
  };
}
const input = {
  name: "Work laptop",
  shell: "powershell",
  mode: "proxy",
  cleanup: true,
};
const ticket = (file) => file.content.match(/'([a-f0-9]{64})'/)[1];

test("local enrollment uses the deployment port instead of the internal proxy address", async () => {
  const f = fixture();
  f.options.integrations.status = async () => ({
    localApiOrigin: "http://localhost:18317",
    tailscale: { enabled: false },
  });
  const file = await f.service.create(input, "http://localhost:13000");
  assert.match(
    await f.service.redeem(ticket(file)),
    /\nhttp:\/\/localhost:18317\n/,
  );
  f.options.integrations.status = async () => ({
    localApiOrigin: "http://remote.example:18317",
    tailscale: { enabled: false },
  });
  await assert.rejects(
    f.service.create(input, "http://localhost:13000"),
    /loopback/,
  );
});

test("personalized installers carry only one-use tickets; redemption survives restart and revocation preserves existing keys", async () => {
  const f = fixture();
  const file = await f.service.create(input, "http://localhost:5173");
  assert.equal(file.filename, "crap.ps1");
  assert.match(
    file.content,
    /Complete-CrapEnrollment 'https:\/\/device.example.ts.net'/,
  );
  for (const secret of ["existing-key", "management-secret", "provider-secret"])
    assert.ok(!file.content.includes(secret));
  assert.ok(!JSON.stringify(f.document()).includes(ticket(file)));
  const restarted = createClientEnrollment(f.options);
  const response = await restarted.redeem(ticket(file));
  assert.match(
    response,
    /^CRAP-ENROLLMENT-1\nhttps:\/\/device.example.ts.net:8443\ncrap-[a-f0-9]{48}\n$/,
  );
  assert.equal(f.keys().length, 2);
  assert.equal(f.document().data.telegram.token, "provider-secret");
  await assert.rejects(restarted.redeem(ticket(file)), /already used/);
  const list = await restarted.list();
  assert.equal(list[0].name, "Work laptop");
  assert.equal(list[0].status, "installed");
  assert.ok(!JSON.stringify(list).includes(f.keys()[1]));
  await restarted.remove(file.id);
  assert.deepEqual(f.keys(), ["existing-key"]);
  assert.deepEqual(await restarted.list(), []);
});
test("parallel redemption consumes once, expires, cancels, and never creates duplicate keys", async () => {
  const f = fixture(),
    file = await f.service.create(input, "http://localhost:5173");
  const results = await Promise.allSettled([
    f.service.redeem(ticket(file)),
    createClientEnrollment(f.options).redeem(ticket(file)),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.keys().length, 2);
  const expired = await f.service.create(input, "http://localhost:5173");
  f.expire();
  await assert.rejects(f.service.redeem(ticket(expired)), /expired/);
  const cancelled = await f.service.create(input, "http://localhost:5173");
  await f.service.remove(cancelled.id);
  await assert.rejects(f.service.redeem(ticket(cancelled)), /expired/);
});
test("uncertain writes consume the token and remain revocable without exposing a key", async () => {
  const f = fixture(),
    file = await f.service.create(input, "http://localhost:5173");
  f.fail();
  await assert.rejects(f.service.redeem(ticket(file)), /token is consumed/);
  assert.equal((await f.service.list())[0].status, "uncertain");
  await assert.rejects(f.service.redeem(ticket(file)), /already used/);
  f.reset();
  await f.service.remove(file.id);
  assert.deepEqual(f.keys(), ["existing-key"]);
});
test("addresses are server-selected, remote setup fails closed, and shell payloads are not injectable", async () => {
  const f = fixture();
  const bash = await f.service.create(
    { ...input, shell: "zsh", name: "$(do-not-execute)", cleanup: false },
    "http://localhost:5173",
  );
  assert.ok(!bash.content.includes("$(do-not-execute)"));
  assert.match(bash.content, /_crap_enroll 'https:/);
  assert.match(bash.content, /'no'/);
  await assert.rejects(
    f.service.create(
      { ...input, shell: "bash'; evil" },
      "http://localhost:5173",
    ),
  );
  f.options.integrations.status = async () => ({
    tailscale: { enabled: true, api: true, phase: "disconnected" },
  });
  await assert.rejects(
    f.service.create(input, "http://localhost:5173"),
    /private access/,
  );
  f.options.integrations.status = async () => ({
    tailscale: { enabled: false },
  });
  await assert.rejects(
    f.service.create(input, "https://remote.example"),
    /remote setup/,
  );
  const local = await f.service.create(input, "http://127.0.0.1:5173");
  assert.equal(local.apiOrigin, "http://localhost:8317");
});

test("interrupted durable locks require explicit recovery before revocation", async () => {
  const f = fixture(),
    file = await f.service.create(input, "http://localhost:5173");
  await f.service.redeem(ticket(file));
  // Simulate a crash after the proxy accepted the key but before completion persisted.
  const d = f.document();
  d.data.clientSetupWriting = file.id;
  d.data.clientEnrollments[0].status = "issuing";
  const restarted = createClientEnrollment(f.options);
  await assert.rejects(restarted.remove(file.id), /Recovery/);
  await restarted.remove(file.id, { recover: true });
  assert.deepEqual(f.keys(), ["existing-key"]);
  assert.equal(f.document().data.clientSetupWriting, undefined);
});
