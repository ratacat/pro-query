import { describe, expect, test } from "bun:test";
import { sanitizeCookies, toCookieHeader } from "../src/cookies";

describe("cookie sanitization", () => {
  test("drops volatile per-conversation cookies", () => {
    const cookies = sanitizeCookies([
      cookie("__Secure-next-auth.session-token", "chatgpt.com", "session"),
      cookie("conv_key_abc", "chatgpt.com", "temporary"),
    ]);

    expect(cookies.map((stored) => stored.name)).toEqual(["__Secure-next-auth.session-token"]);
  });

  test("does not replay volatile cookies in a Cookie header", () => {
    const header = toCookieHeader([
      cookie("__Secure-next-auth.session-token", "chatgpt.com", "session"),
      cookie("conv_key_abc", "chatgpt.com", "temporary"),
    ]);

    expect(header).toBe("__Secure-next-auth.session-token=session");
  });
});

function cookie(name: string, domain: string, value: string): {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
} {
  return { name, value, domain, path: "/", secure: true };
}
