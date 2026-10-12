import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Setup } from "./Setup";

const integrations = {
  tailscale: { enabled: false },
  telegram: { configured: false },
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function stubRuntime(runtime: Promise<Response>) {
  const fetcher = vi.fn((url: string, _options?: RequestInit) =>
    url === "/api/runtime"
      ? runtime
      : Promise.resolve(Response.json(integrations)),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
function show() {
  render(<Setup connected accountCount={0} navigate={vi.fn()} />);
}

it("detects Kubernetes behind localhost and separates the current instance from guide selection", async () => {
  const fetcher = stubRuntime(
    Promise.resolve(Response.json({ deployment: "kubernetes" })),
  );
  show();
  await screen.findByText(/Current instance: Kubernetes/);
  expect(
    screen
      .getByRole("button", { name: /^Kubernetes/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    screen
      .getByRole("link", { name: /Kubernetes deployment guide/ })
      .getAttribute("href"),
  ).toContain("/k8s/README.md");
  expect(screen.queryByText(/not release-ready/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Docker Compose/ }));
  expect(
    screen
      .getByRole("button", { name: /^Docker Compose/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.getByText(/Current instance: Kubernetes/)).toBeTruthy();
  expect(
    fetcher.mock.calls.every(
      ([, options]) => !options || !(options as RequestInit).method,
    ),
  ).toBe(true);
});

it("does not mistake unavailable runtime detection for a local deployment", async () => {
  stubRuntime(Promise.resolve(new Response("", { status: 404 })));
  show();
  await screen.findByText(/Runtime not detected/);
  for (const button of screen
    .getByRole("group", { name: "Deployment options" })
    .querySelectorAll("button")) {
    expect(button.getAttribute("aria-pressed")).toBe("false");
  }
});

it("late runtime detection does not replace a guide the user already selected", async () => {
  let resolve!: (response: Response) => void;
  stubRuntime(
    new Promise((done) => {
      resolve = done;
    }),
  );
  show();
  fireEvent.click(screen.getByRole("button", { name: /^Docker Compose/ }));
  await act(async () => {
    resolve(Response.json({ deployment: "kubernetes" }));
  });
  expect(
    screen
      .getByRole("button", { name: /^Docker Compose/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.getByText(/Current instance: Kubernetes/)).toBeTruthy();
});
