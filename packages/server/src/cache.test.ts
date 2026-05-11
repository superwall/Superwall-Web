import { describe, expect, test } from "bun:test";
import { InMemoryCache } from "./cache.ts";
import type { CacheEntry } from "./types.ts";

const entry = (id: string, expiresAt: number): CacheEntry => ({
  expiresAt,
  value: {
    active: [{ id, type: "SERVICE_LEVEL", isActive: true, productIds: [] }],
    inactive: [],
    all: [{ id, type: "SERVICE_LEVEL", isActive: true, productIds: [] }],
  },
});

describe("InMemoryCache", () => {
  test("get returns null on miss", () => {
    const c = new InMemoryCache(10);
    expect(c.get("nope")).toBeNull();
  });

  test("set + get returns the entry", () => {
    const c = new InMemoryCache(10);
    const e = entry("pro", Date.now() + 1000);
    c.set("u1", e);
    expect(c.get("u1")).toBe(e);
  });

  test("expired entry is dropped on read", () => {
    const c = new InMemoryCache(10);
    c.set("u1", entry("pro", Date.now() - 1));
    expect(c.get("u1")).toBeNull();
    expect(c.size).toBe(0);
  });

  test("delete removes the entry", () => {
    const c = new InMemoryCache(10);
    c.set("u1", entry("pro", Date.now() + 1000));
    c.delete("u1");
    expect(c.get("u1")).toBeNull();
  });

  test("clear empties the cache", () => {
    const c = new InMemoryCache(10);
    c.set("a", entry("pro", Date.now() + 1000));
    c.set("b", entry("pro", Date.now() + 1000));
    c.clear();
    expect(c.size).toBe(0);
  });

  test("LRU evicts oldest when maxEntries exceeded", () => {
    const c = new InMemoryCache(2);
    c.set("a", entry("pro", Date.now() + 1000));
    c.set("b", entry("pro", Date.now() + 1000));
    c.set("c", entry("pro", Date.now() + 1000));
    expect(c.size).toBe(2);
    expect(c.get("a")).toBeNull();
    expect(c.get("b")).not.toBeNull();
    expect(c.get("c")).not.toBeNull();
  });

  test("read refreshes LRU position so recent reads survive eviction", () => {
    const c = new InMemoryCache(2);
    c.set("a", entry("pro", Date.now() + 1000));
    c.set("b", entry("pro", Date.now() + 1000));
    c.get("a"); // refresh
    c.set("c", entry("pro", Date.now() + 1000));
    expect(c.get("a")).not.toBeNull();
    expect(c.get("b")).toBeNull();
    expect(c.get("c")).not.toBeNull();
  });
});
