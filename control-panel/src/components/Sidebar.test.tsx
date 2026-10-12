import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";
import { pageFromHash, type Page } from "@/lib/navigation";

beforeEach(() =>
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  ),
);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("groups destinations with one selected route and one configuration entry", () => {
  render(
    <Sidebar
      page="ledger"
      connected
      accountCount={2}
      mobile={false}
      onMobileChange={() => {}}
      navigate={() => {}}
    />,
  );
  const nav = screen.getByRole("navigation", { name: "Main navigation" });
  for (const category of ["Gateway", "Monitor", "System"])
    expect(within(nav).getByRole("region", { name: category })).toBeTruthy();
  expect(
    within(nav)
      .getByRole("link", { name: "Token Ledger" })
      .getAttribute("aria-current"),
  ).toBe("page");
  expect(nav.querySelectorAll('[aria-current="page"]').length).toBe(1);
  expect(
    within(nav).getAllByRole("link", { name: "Proxy Configuration" }),
  ).toHaveLength(1);
  expect(within(nav).queryByRole("link", { name: "Settings" })).toBeNull();
  expect(pageFromHash("#settings")).toBe("configuration");
  expect(pageFromHash("#ledger")).toBe("ledger");
});

it("mobile navigation supports Escape, returns focus and closes after selection", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [mobile, setMobile] = useState(false);
    const [page, setPage] = useState<Page>("overview");
    return (
      <>
        <button onClick={() => setMobile(true)}>Open navigation</button>
        <Sidebar
          page={page}
          connected
          accountCount={2}
          mobile={mobile}
          onMobileChange={setMobile}
          navigate={(next) => {
            setPage(next);
            setMobile(false);
          }}
        />
      </>
    );
  }
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Open navigation" });
  await user.click(opener);
  expect(
    await screen.findByRole("dialog", { name: "Navigation" }),
  ).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(opener);
  await user.click(opener);
  await user.click(
    within(screen.getByRole("dialog")).getByRole("link", {
      name: "Token Ledger",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    screen
      .getByRole("link", { name: "Token Ledger" })
      .getAttribute("aria-current"),
  ).toBe("page");
});
