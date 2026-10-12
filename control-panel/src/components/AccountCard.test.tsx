import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  act,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { AccountCard } from "./AccountCard";
import { accountUsage, maskEmails } from "@/lib/accounts";
import type { Credential } from "@/lib/api";
import * as apiModule from "@/lib/api";

const credential: Credential = {
  id: "one",
  name: "claude-alice@example.com.json",
  email: "alice@example.com",
  provider: "claude",
  disabled: false,
  status: "active",
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("account usage", () => {
  it("loads account-wide usage and plan, and retains it with a warning on failed refresh", async () => {
    const api = vi
      .spyOn(apiModule, "api")
      .mockResolvedValueOnce({
        windows: [{ label: "5-hour window", used: 1 }],
        plan: "Pro",
        checkedAt: Date.now(),
      })
      .mockRejectedValueOnce(new Error("Claude is unavailable"));
    render(
      <AccountCard credential={{ ...credential, auth_index: "account-one" }} />,
    );
    expect(await screen.findByText("1% used")).toBeTruthy();
    expect(screen.getByText("Pro")).toBeTruthy();
    expect(
      screen.getByText(/including activity outside this proxy/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Showing the last successful lookup",
      ),
    );
    expect(screen.getByText("1% used")).toBeTruthy();
    expect(api).toHaveBeenCalledTimes(2);
  });
  it("displays a partial usage failure without losing the fetched plan", async () => {
    vi.spyOn(apiModule, "api").mockResolvedValue({
      windows: [],
      plan: "Pro",
      checkedAt: Date.now(),
      usageError: "Claude usage lookup returned HTTP 429.",
    });
    render(
      <AccountCard credential={{ ...credential, auth_index: "account-one" }} />,
    );
    expect(await screen.findByText("Pro")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("429");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
  it("masks email addresses in account names and status messages, including DOM attributes", () => {
    const { container } = render(
      <AccountCard
        credential={{
          ...credential,
          status_message: "Account alice@example.com is active",
        }}
      />,
    );
    expect(container.innerHTML).not.toContain("alice@example.com");
    expect(screen.getByText("a•••@e•••")).toBeTruthy();
    expect(maskEmails(credential.name)).not.toContain("example.com");
    expect(maskEmails("a@b.example")).toBe("a•••@b•••");
    expect(maskEmails("service-account")).toBe("service-account");
  });
  it("distinguishes unknown data from zero usage and unknown plan", () => {
    render(<AccountCard credential={credential} />);
    expect(screen.getByText(/No usage data yet/)).toBeTruthy();
    expect(screen.getAllByText("Unknown")).toHaveLength(2);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText("Not reported")).toBeTruthy();
  });
  it("converts Claude fractions and preserves zero usage", () => {
    render(
      <AccountCard
        credential={{
          ...credential,
          quota: {
            signals: {
              "Anthropic-Ratelimit-Unified-5h-Utilization": "0",
              "Anthropic-Ratelimit-Unified-7d-Utilization": "0.53",
            },
          },
        }}
      />,
    );
    expect(screen.getByText("0% used")).toBeTruthy();
    expect(screen.getByText("53% used")).toBeTruthy();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
  });
  it("does not invent a replenished allowance after the reset time passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
    render(
      <AccountCard
        credential={{
          ...credential,
          quota: {
            observed_at: "2026-10-05T11:59:00Z",
            signals: {
              "anthropic-ratelimit-unified-5h-reset": String(
                Date.parse("2026-10-05T12:00:30Z") / 1000,
              ),
              "anthropic-ratelimit-unified-5h-utilization": "1",
            },
          },
        }}
      />,
    );
    expect(screen.getByText("Resets in 1m")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(
      screen.getByText("Reset time passed · awaiting an update"),
    ).toBeTruthy();
    expect(screen.getByText("100% used")).toBeTruthy();
  });
  it("anchors Codex relative resets to the observation, not render time", () => {
    const result = accountUsage({
      ...credential,
      provider: "codex",
      quota: {
        observed_at: "2026-10-05T12:00:00Z",
        signals: {
          "X-Codex-Primary-Used-Percent": "42",
          "X-Codex-Primary-Window-Minutes": "300",
          "X-Codex-Primary-Reset-After-Seconds": "60",
          "X-Codex-Plan-Type": "pro",
        },
      },
    });
    expect(result.plan).toBe("pro");
    expect(result.windows[0]).toMatchObject({
      label: "5-hour window",
      used: 42,
      resetAt: Date.parse("2026-10-05T12:01:00Z"),
    });
  });
  it("rejects missing, negative and malformed measurements", () => {
    const result = accountUsage({
      ...credential,
      quota: {
        observed_at: "invalid",
        signals: {
          "anthropic-ratelimit-unified-5h-utilization": "",
          "anthropic-ratelimit-unified-7d-utilization": "-1",
          "anthropic-ratelimit-unified-5h-reset": "NaN",
          "anthropic-ratelimit-unified-7d-reset": "1e300",
        },
      },
    });
    expect(result.hasData).toBe(false);
    expect(result.observedAt).toBeUndefined();
  });
});
