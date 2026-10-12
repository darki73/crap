import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { Providers } from "./Providers";
import { ConnectDialog } from "@/components/ConnectDialog";
import * as apiModule from "@/lib/api";
import type { Config, Credential } from "@/lib/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const config: Config = {
  access: {},
  "api-keys": {
    "openai-compatibility": [
      {
        name: "Local API",
        "base-url": "http://fixture.test/v1",
        keys: [{ "api-key": "secret-key" }],
        models: [{ name: "fixture-model" }],
      },
    ],
  },
  routing: {},
  observability: {},
};
const credential: Credential = {
  id: "fixture",
  auth_index: "fixture-index",
  name: "private-file.json",
  email: "alice@example.com",
  provider: "claude",
  disabled: false,
  status: "active",
};

it("shows peer connection cards without loading quota or exposing credentials", () => {
  const call = vi.spyOn(apiModule, "api");
  render(
    <Providers
      config={config}
      credentials={[credential]}
      onConnect={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(screen.getByRole("region", { name: "API Credentials" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Subscriptions" })).toBeTruthy();
  expect(screen.getByText("a•••@e•••")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText("alice@example.com")).toBeNull();
  expect(screen.queryByText("secret-key")).toBeNull();
  expect(call).not.toHaveBeenCalled();
});

it("opens the masked account details with its plan and confirmation-based actions", async () => {
  vi.spyOn(apiModule, "api").mockResolvedValue({
    plan: "Pro",
    windows: [],
    checkedAt: Date.now(),
  });
  const write = vi.spyOn(apiModule, "write").mockResolvedValue({});
  render(
    <Providers
      config={config}
      credentials={[credential]}
      onConnect={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Manage a•••@e•••" }));
  const dialog = await screen.findByRole("dialog", { name: "a•••@e•••" });
  expect(await within(dialog).findByText("Pro")).toBeTruthy();
  expect(
    within(dialog)
      .getByRole("link", { name: "View Quota & Limits" })
      .getAttribute("href"),
  ).toBe("#usage");
  fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
  expect(
    await screen.findByRole("dialog", { name: "Disable account" }),
  ).toBeTruthy();
  expect(write).not.toHaveBeenCalled();
});

it("API management keeps secrets out of the summary and exposes edit controls", () => {
  render(
    <Providers
      config={config}
      credentials={[]}
      onConnect={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Manage Local API" }));
  const dialog = screen.getByRole("dialog", { name: "Local API" });
  expect(within(dialog).getByText("fixture-model")).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "Edit configuration" }),
  ).toBeTruthy();
  expect(dialog.textContent).not.toContain("secret-key");
});

it("connection actions select API, subscription and import modes", () => {
  const connect = vi.fn();
  render(
    <Providers
      config={config}
      credentials={[credential]}
      onConnect={connect}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add API" }));
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  fireEvent.click(screen.getByRole("button", { name: "Import account" }));
  expect(connect.mock.calls.map(([mode]) => mode)).toEqual([
    "api",
    "oauth",
    "file",
  ]);
});

it("Add API opens the API form directly", () => {
  render(
    <ConnectDialog
      open
      initialMode="api"
      config={config}
      onOpenChange={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(screen.getByLabelText("Provider API key")).toBeTruthy();
});
