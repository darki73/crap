import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthConnect } from "./OAuthConnect";
import { api, write } from "@/lib/api";
import type { OAuthLogin } from "@/lib/oauth";

vi.mock("@/lib/api", () => ({
  api: vi.fn(),
  write: vi.fn(),
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : "Error",
}));
const login: OAuthLogin = {
  status: "ok",
  url: "https://auth.openai.com/oauth/authorize",
  state: "test-session",
};
let status: { status: string; error?: string };
const onSaved = vi.fn(async () => {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  status = { status: "wait" };
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.startsWith("/oauth/auth-url")) return login;
    if (path.startsWith("/oauth/session"))
      return { status: "ok", cancelled: true };
    return status;
  });
  vi.mocked(write).mockResolvedValue({ status: "ok" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
async function choose(name = /ChatGPT \/ Codex/) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

describe("OAuth account sign-in", () => {
  it("waits for saved credentials, not callback acceptance, and reports success once", async () => {
    render(<OAuthConnect onSaved={onSaved} onDone={() => {}} />);
    await choose();
    expect(api).toHaveBeenCalledWith(
      "/oauth/auth-url?provider=codex&is_webui=true",
    );
    expect(
      screen.getByRole("link", { name: /Open ChatGPT/ }).getAttribute("href"),
    ).toBe(login.url);
    fireEvent.click(
      screen.getByText("Browser didn’t return? Paste the callback"),
    );
    fireEvent.change(
      screen.getByLabelText("Callback URL or authorization code"),
      {
        target: {
          value:
            "http://localhost:1455/auth/callback?code=example&state=test-session",
        },
      },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit callback" }));
    });
    expect(
      screen.getByText("Callback received. Finishing sign-in…"),
    ).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    status = { status: "ok" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText("ChatGPT / Codex is connected")).toBeTruthy();
    expect(onSaved).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("shows device codes and omits browser callback input for device flows", async () => {
    vi.mocked(api).mockImplementation(async (path) =>
      path.startsWith("/oauth/auth-url")
        ? { ...login, flow: "device", user_code: "ABCD-1234" }
        : status,
    );
    render(<OAuthConnect onSaved={onSaved} onDone={() => {}} />);
    await choose(/^Sign in with Kimi$/);
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    expect(
      screen.queryByLabelText("Callback URL or authorization code"),
    ).toBeNull();
  });

  it("rejects callbacks for another state before submitting anything", async () => {
    render(<OAuthConnect onSaved={onSaved} onDone={() => {}} />);
    await choose();
    fireEvent.click(
      screen.getByText("Browser didn’t return? Paste the callback"),
    );
    fireEvent.change(
      screen.getByLabelText("Callback URL or authorization code"),
      {
        target: {
          value:
            "http://localhost:1455/auth/callback?code=example&state=someone-else",
        },
      },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit callback" }));
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "different sign-in",
    );
    expect(write).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("surfaces expiry and allows another attempt", async () => {
    status = { status: "error", error: "unknown or expired state" };
    render(<OAuthConnect onSaved={onSaved} onDone={() => {}} />);
    await choose();
    expect(screen.getByRole("alert").textContent).toContain("expired state");
    status = { status: "wait" };
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(screen.getByText("Waiting for authorization…")).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("cancels a pending session when the dialog closes", async () => {
    const view = render(<OAuthConnect onSaved={onSaved} onDone={() => {}} />);
    await choose();
    view.unmount();
    expect(api).toHaveBeenCalledWith("/oauth/session?state=test-session", {
      method: "DELETE",
      keepalive: true,
    });
    status = { status: "ok" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("cancels a late start response after closing, rather than leaking a session", async () => {
    let resolveStart!: (value: OAuthLogin) => void;
    vi.mocked(api).mockImplementation((path) =>
      path.startsWith("/oauth/auth-url")
        ? new Promise((resolve) => {
            resolveStart = resolve;
          })
        : Promise.resolve({ status: "ok" }),
    );
    const view = render(<OAuthConnect onSaved={onSaved} onDone={() => {}} />);
    await choose();
    view.unmount();
    await act(async () => {
      resolveStart(login);
    });
    expect(api).toHaveBeenCalledWith("/oauth/session?state=test-session", {
      method: "DELETE",
      keepalive: true,
    });
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("retries transient polling failures and clears the stale error", async () => {
    let failures = 1;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.startsWith("/oauth/auth-url")) return login;
      if (path.startsWith("/oauth/status") && failures-- > 0)
        throw new Error("Proxy unavailable");
      return status;
    });
    render(<OAuthConnect onSaved={onSaved} onDone={() => {}} />);
    await choose();
    expect(screen.getByRole("alert").textContent).toContain(
      "Retrying automatically",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("returns to the provider chooser after explicit cancellation", async () => {
    render(<OAuthConnect onSaved={onSaved} onDone={() => {}} />);
    await choose();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    });
    expect(api).toHaveBeenCalledWith("/oauth/session?state=test-session", {
      method: "DELETE",
      keepalive: true,
    });
    expect(
      screen.getByRole("button", { name: /ChatGPT \/ Codex/ }),
    ).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
