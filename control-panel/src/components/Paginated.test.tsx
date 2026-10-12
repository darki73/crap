import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Paginated } from "./Paginated";
afterEach(cleanup);
const original = Array.from({ length: 23 }, (_, i) => `Record ${i + 1}`);
const content = (rows: readonly string[]) => (
  <ul>
    {rows.map((row) => (
      <li key={row}>{row}</li>
    ))}
  </ul>
);
it("bounds rows, handles the last page and clamps after deletion", () => {
  const view = render(
    <Paginated items={original} label="records">
      {content}
    </Paginated>,
  );
  expect(screen.getAllByRole("listitem")).toHaveLength(10);
  expect(
    (screen.getByLabelText("Previous records page") as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByLabelText("Next records page"));
  fireEvent.click(screen.getByLabelText("Next records page"));
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  expect(screen.getByText("21–23 of 23")).toBeTruthy();
  expect(
    (screen.getByLabelText("Next records page") as HTMLButtonElement).disabled,
  ).toBe(true);
  view.rerender(
    <Paginated items={original.slice(0, 11)} label="records">
      {content}
    </Paginated>,
  );
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByText("11–11 of 11")).toBeTruthy();
  view.rerender(
    <Paginated items={[]} label="records">
      {content}
    </Paginated>,
  );
  expect(screen.queryByRole("navigation")).toBeNull();
});
it("keeps history stable through polling until Show latest is selected", () => {
  const view = render(
    <Paginated items={original} label="requests" snapshot loadedOnly>
      {content}
    </Paginated>,
  );
  fireEvent.click(screen.getByLabelText("Next requests page"));
  view.rerender(
    <Paginated
      items={["New request", ...original]}
      label="requests"
      snapshot
      loadedOnly
    >
      {content}
    </Paginated>,
  );
  expect(screen.getByText("Record 11")).toBeTruthy();
  expect(screen.queryByText("Record 10")).toBeNull();
  expect(screen.getByText("11–20 of 23 loaded")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show latest requests" }));
  expect(screen.getByText("New request")).toBeTruthy();
  expect(screen.getByText("1–10 of 24 loaded")).toBeTruthy();
});
