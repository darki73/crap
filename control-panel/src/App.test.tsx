import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { api } from "@/lib/api";
import {
  PERSONAL_USE_GUIDE_KEY,
  PERSONAL_USE_GUIDE_VERSION,
} from "@/components/PersonalUseGuide";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  });
  history.replaceState(null, "", "#ledger");
  vi.mocked(api)
    .mockReset()
    .mockRejectedValue(new Error("Test workspace offline"));
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function readGuide(user: ReturnType<typeof userEvent.setup>) {
  for (let step = 0; step < 3; step++)
    await user.click(screen.getByRole("button", { name: "Continue" }));
}

it("gates a deep link without API calls, requires both acknowledgements and remembers completion", async () => {
  const user = userEvent.setup();
  const view = render(<App />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "Your accounts. Your workspace.",
  );
  expect(api).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Back to workspace" }),
  ).toBeNull();
  await readGuide(user);
  const enter = screen.getByRole("button", {
    name: "Enter my workspace",
  }) as HTMLButtonElement;
  expect(enter.disabled).toBe(true);
  await user.click(
    screen.getByRole("checkbox", { name: /I will connect only/ }),
  );
  expect(enter.disabled).toBe(true);
  await user.click(screen.getByRole("checkbox", { name: /I understand CRAP/ }));
  expect(enter.disabled).toBe(false);
  await user.click(screen.getByRole("button", { name: "Back" }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(
    (
      screen.getByRole("checkbox", {
        name: /I understand CRAP/,
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect(api).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Enter my workspace" }));
  await screen.findByRole("heading", { name: "Let’s get connected." });
  expect(localStorage.getItem(PERSONAL_USE_GUIDE_KEY)).toBe(
    PERSONAL_USE_GUIDE_VERSION,
  );
  expect(location.hash).toBe("#ledger");
  expect(document.title).toBe("Token Ledger · CRAP");
  view.unmount();
  render(<App />);
  await screen.findByRole("heading", { name: "Let’s get connected." });
  expect(screen.queryByText("Your accounts. Your workspace.")).toBeNull();
});

it("can reopen and leave the guide without another acknowledgement or changing the route", async () => {
  localStorage.setItem(PERSONAL_USE_GUIDE_KEY, PERSONAL_USE_GUIDE_VERSION);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("heading", { name: "Let’s get connected." });
  await user.click(screen.getByRole("button", { name: "Personal Use Guide" }));
  expect(document.title).toBe("Personal Use Guide · CRAP");
  await readGuide(user);
  expect(screen.queryByRole("checkbox")).toBeNull();
  await user.click(
    screen.getAllByRole("button", { name: "Back to workspace" })[0],
  );
  await screen.findByRole("heading", { name: "Let’s get connected." });
  expect(location.hash).toBe("#ledger");
  expect(document.activeElement?.id).toBe("workspace-content");
});

it("shows updated guidance again when an older version was acknowledged", () => {
  localStorage.setItem(PERSONAL_USE_GUIDE_KEY, "older-version");
  render(<App />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "Your accounts. Your workspace.",
  );
  expect(api).not.toHaveBeenCalled();
});

it("allows this visit to continue when browser storage cannot be read or written", async () => {
  vi.mocked(localStorage.getItem).mockImplementation(() => {
    throw new Error("Storage blocked");
  });
  vi.mocked(localStorage.setItem).mockImplementation(() => {
    throw new Error("Storage blocked");
  });
  const user = userEvent.setup();
  render(<App />);
  await readGuide(user);
  for (const checkbox of screen.getAllByRole("checkbox"))
    await user.click(checkbox);
  await user.click(screen.getByRole("button", { name: "Enter my workspace" }));
  await waitFor(() => expect(api).toHaveBeenCalled());
  await screen.findByRole("heading", { name: "Let’s get connected." });
});
