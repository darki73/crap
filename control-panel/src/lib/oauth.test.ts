import { describe, expect, it } from "vitest";
import { parseCallback, validateLogin } from "./oauth";

describe("OAuth input validation", () => {
  it("requires HTTPS authorization URLs and a session state", () => {
    expect(() =>
      validateLogin({ status: "ok", state: "", url: "https://auth.example/" }),
    ).toThrow();
    expect(() =>
      validateLogin({ status: "ok", state: "s", url: "javascript:alert(1)" }),
    ).toThrow();
    expect(() =>
      validateLogin({
        status: "ok",
        state: "s",
        url: "https://user:password@auth.example/",
      }),
    ).toThrow();
  });
  it("accepts Claude codes bound to the active state", () => {
    expect(
      parseCallback("code#current-state", "current-state", "claude"),
    ).toEqual({ provider: "claude", state: "current-state", code: "code" });
    expect(() =>
      parseCallback("code#other-state", "current-state", "claude"),
    ).toThrow(/different/);
  });
  it("rejects callback URLs without state or authorization result", () => {
    expect(() =>
      parseCallback("http://localhost/callback?code=c", "s", "codex"),
    ).toThrow(/different/);
    expect(() =>
      parseCallback("http://localhost/callback?state=s", "s", "codex"),
    ).toThrow(/no authorization/);
  });
});
