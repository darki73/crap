import { afterEach, expect, it, vi } from "vitest";
import {
  act,
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

it("re-authenticates an expired account through its provider and waits for OAuth completion", async () => {
  vi.useFakeTimers();
  try {
    let authorized = false;
    const api = vi.spyOn(apiModule, "api").mockImplementation(async (path) => {
      if (path.startsWith("/accounts/usage"))
        return { windows: [], checkedAt: Date.now() };
      if (path.startsWith("/oauth/auth-url"))
        return {
          status: "ok",
          state: "reauth-session",
          url: "https://oauth.example.test/authorize",
        };
      if (path.startsWith("/oauth/status"))
        return { status: authorized ? "ok" : "wait" };
      return { status: "ok" };
    });
    const write = vi
      .spyOn(apiModule, "write")
      .mockResolvedValue({ status: "ok" });
    const saved = vi.fn(async () => {});
    render(
      <Providers
        config={config}
        credentials={[
          {
            ...credential,
            status: "error",
            status_message:
              "invalid_grant: Refresh token expired for alice@example.com",
          },
        ]}
        onConnect={vi.fn()}
        onSaved={saved}
      />,
    );
    expect(screen.getByText("Sign-in required")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Manage a•••@e•••" }));
    });
    expect(
      screen
        .getByRole("button", { name: "Refresh token" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Re-authenticate" }));
    expect(
      screen.getByRole("dialog", { name: "Re-authenticate account" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Sign in with ChatGPT/ }),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("alice@example.com");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Sign in with Claude" }),
      );
    });
    expect(api).toHaveBeenCalledWith(
      "/oauth/auth-url?provider=claude&is_webui=true",
    );
    fireEvent.change(
      screen.getByLabelText("Callback URL or authorization code"),
      {
        target: {
          value:
            "http://localhost:54545/callback?code=fixture&state=reauth-session",
        },
      },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit callback" }));
    });
    expect(saved).not.toHaveBeenCalled();
    authorized = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(saved).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("/oauth/callback", "POST", {
      provider: "claude",
      state: "reauth-session",
      redirect_url:
        "http://localhost:54545/callback?code=fixture&state=reauth-session",
    });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

it("offers sign-in recovery when refreshing a seemingly active account returns invalid_grant", async () => {
  vi.spyOn(apiModule, "api").mockResolvedValue({
    windows: [],
    checkedAt: Date.now(),
  });
  vi.spyOn(apiModule, "write").mockRejectedValue(
    new Error(
      'token refresh failed after 3 attempts: status 400: {"error":"invalid_grant","error_description":"Refresh token expired"}',
    ),
  );
  const saved = vi.fn(async () => {});
  render(
    <Providers
      config={config}
      credentials={[credential]}
      onConnect={vi.fn()}
      onSaved={saved}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Manage a•••@e•••" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh token" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh credential" }));
  expect(
    await screen.findByText(/provider rejected the saved refresh token/),
  ).toBeTruthy();
  expect(
    screen.queryByRole("dialog", { name: "Refresh credential" }),
  ).toBeNull();
  expect(saved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Re-authenticate" }));
  expect(
    screen.getByRole("button", { name: "Sign in with Claude" }),
  ).toBeTruthy();
});

it("keeps transient refresh failures retryable and limits re-authentication to supported saved accounts", async () => {
  vi.spyOn(apiModule, "api").mockResolvedValue({
    windows: [],
    checkedAt: Date.now(),
  });
  vi.spyOn(apiModule, "write").mockRejectedValue(
    new Error("Provider temporarily unavailable"),
  );
  const view = render(
    <Providers
      config={config}
      credentials={[credential]}
      onConnect={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Manage a•••@e•••" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh token" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh credential" }));
  expect(
    await screen.findByText("Provider temporarily unavailable"),
  ).toBeTruthy();
  expect(
    screen.getByRole("dialog", { name: "Refresh credential" }),
  ).toBeTruthy();
  expect(
    screen.queryByText(/provider rejected the saved refresh token/),
  ).toBeNull();
  view.unmount();
  render(
    <Providers
      config={config}
      credentials={[{ ...credential, runtime_only: true }]}
      onConnect={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Manage a•••@e•••" }));
  expect(screen.queryByRole("button", { name: "Re-authenticate" })).toBeNull();
});

it("shows renewal failure even while the existing access token keeps the account active", async () => {
  vi.spyOn(apiModule, "api").mockResolvedValue({
    windows: [],
    checkedAt: Date.now(),
  });
  render(
    <Providers
      config={config}
      credentials={[
        {
          ...credential,
          status: "active",
          status_message: "",
          requires_sign_in: true,
        },
      ]}
      onConnect={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(screen.getByText("Sign-in required")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Manage a•••@e•••" }));
  });
  const dialog = screen.getByRole("dialog", { name: "a•••@e•••" });
  expect(within(dialog).getByText("Sign-in required")).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "Re-authenticate" }),
  ).toBeTruthy();
  expect(
    within(dialog)
      .getByRole("button", { name: "Refresh token" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
