import { test, expect, beforeEach } from "bun:test";
import { deleteCookie, readCookie, writeCookie } from "./cookies.ts";

const clearAll = () => {
  // happy-dom doesn't ship a `document.cookie = ""` reset, so we walk and
  // expire each existing cookie individually.
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) deleteCookie(name);
  }
};

beforeEach(clearAll);

test("readCookie returns null when the cookie does not exist", () => {
  expect(readCookie("missing")).toBeNull();
});

test("writeCookie + readCookie round-trip URL-encoded values", () => {
  writeCookie("_sw_alias_id", "$SuperwallAlias:abc/def+xyz");
  expect(readCookie("_sw_alias_id")).toBe("$SuperwallAlias:abc/def+xyz");
});

test("writeCookie applies SameSite=Lax + Path=/ + Max-Age default", () => {
  writeCookie("k", "v");
  // happy-dom only echoes back name=value via document.cookie (cookie
  // attributes aren't observable). Verify the value round-trips and the
  // call doesn't throw on the attribute set we apply by default.
  expect(readCookie("k")).toBe("v");
});

test("deleteCookie removes a previously-written cookie", () => {
  writeCookie("x", "y");
  expect(readCookie("x")).toBe("y");
  deleteCookie("x");
  expect(readCookie("x")).toBeNull();
});

test("readCookie handles multiple cookies and trims whitespace", () => {
  writeCookie("a", "1");
  writeCookie("b", "2");
  writeCookie("c", "3");
  expect(readCookie("a")).toBe("1");
  expect(readCookie("b")).toBe("2");
  expect(readCookie("c")).toBe("3");
});

test("deleteCookie accepts secure + sameSite + path attributes (P1)", () => {
  // Smoke — happy-dom doesn't expose attributes back via document.cookie
  // so we can only verify the call doesn't throw + the value disappears.
  writeCookie("strict_cookie", "v", { sameSite: "Strict" });
  expect(readCookie("strict_cookie")).toBe("v");
  deleteCookie("strict_cookie", { sameSite: "Strict", path: "/" });
  expect(readCookie("strict_cookie")).toBeNull();
});
