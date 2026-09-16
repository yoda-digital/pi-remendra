import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  clipTokens,
  redact,
  equivalent,
  safeDate,
  hash,
  COUNTER,
} from "../../src/v2/text.js";

describe("estimateTokens", () => {
  it("reports chars/4-estimate counter", () => {
    expect(COUNTER).toBe("chars/4-estimate");
  });

  it("estimates ASCII text", () => {
    // "Hello world" = 11 chars → ceil(11/4) = 3
    expect(estimateTokens("Hello world")).toBe(3);
  });

  it("estimates Cyrillic without 2-3x overestimate", () => {
    const text = "Привет мир на русском языке";
    const tokens = estimateTokens(text);
    // 27 chars → ceil(27/4) = 7, not the old 17 from UTF-8 bytes / 3
    expect(tokens).toBe(7);
    expect(tokens).toBeLessThan(10); // Must not overestimate like the old formula
  });

  it("estimates CJK without 3x overestimate", () => {
    const text = "你好世界测试中文文本";
    const tokens = estimateTokens(text);
    // 10 chars → ceil(10/4) = 3, not the old 10 from UTF-8 bytes / 3
    expect(tokens).toBe(3);
  });

  it("handles emoji (surrogate pairs)", () => {
    // "🎉🎊" = 4 UTF-16 code units (2 per emoji) → ceil(4/4) = 1
    expect(estimateTokens("🎉🎊")).toBe(1);
  });

  it("handles empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("handles mixed scripts", () => {
    const text = "Hello Привет 你好 🎉";
    const tokens = estimateTokens(text);
    // 18 chars → ceil(18/4) = 5
    expect(tokens).toBe(5);
  });
});

describe("clipTokens", () => {
  it("returns text unchanged when within budget", () => {
    expect(clipTokens("Hello", 100)).toBe("Hello");
  });

  it("clips long text to budget", () => {
    const long = "a".repeat(1000);
    const clipped = clipTokens(long, 10);
    expect(estimateTokens(clipped)).toBeLessThanOrEqual(10);
    expect(clipped.endsWith("…")).toBe(true);
  });

  it("returns empty on budget < 2", () => {
    expect(clipTokens("Hello world", 1)).toBe("");
  });

  it("does not split surrogate pairs", () => {
    const text = "A".repeat(39) + "🎉";
    const clipped = clipTokens(text, 10);
    // Must not end with a lone high surrogate
    expect(clipped).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});

describe("redact", () => {
  it("redacts OpenAI API keys", () => {
    const text = "key: sk-proj-abc123def456ghi789jkl012mno";
    expect(redact(text)).toContain("[REDACTED]");
    expect(redact(text)).not.toContain("abc123");
  });

  it("redacts GitHub tokens", () => {
    const text = "token: ghp_1234567890abcdefghij1234567890ab";
    expect(redact(text)).toContain("[REDACTED]");
  });

  it("redacts PEM private keys", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpA...\n-----END RSA PRIVATE KEY-----";
    expect(redact(text)).toContain("[REDACTED PRIVATE KEY]");
  });

  it("applies custom literal patterns", () => {
    const text = "The secret is MY_SECRET_VALUE here";
    expect(redact(text, ["MY_SECRET_VALUE"])).toContain("[REDACTED]");
    expect(redact(text, ["MY_SECRET_VALUE"])).not.toContain("MY_SECRET_VALUE");
  });

  it("redacts AWS access keys", () => {
    const text = "aws_key: AKIAIOSFODNN7EXAMPLE";
    expect(redact(text)).toContain("[REDACTED]");
    expect(redact(text)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts Stripe secret keys", () => {
    expect(redact("sk_live_51OcZLDCMDi12345abcdef")).toContain("[REDACTED]");
    expect(redact("sk_test_51OcZLDCMDi12345abcdef")).toContain("[REDACTED]");
    expect(redact("rk_live_51OcZLDCMDi12345abcdef")).toContain("[REDACTED]");
    expect(redact("pk_live_51OcZLDCMDi12345abcdef")).toContain("[REDACTED]");
  });

  it("redacts Slack tokens", () => {
    expect(redact("xoxb-1234-5678-abcdefgh")).toContain("[REDACTED]");
    expect(redact("xoxp-1234-5678-abcdefgh")).toContain("[REDACTED]");
    expect(redact("xapp-1234-5678-abcdefgh")).toContain("[REDACTED]");
  });

  it("redacts database connection URIs", () => {
    expect(redact("postgres://user:pass@host:5432/db")).toContain("[REDACTED_URI]");
    expect(redact("mongodb+srv://user:pass@cluster.example.com/db")).toContain("[REDACTED_URI]");
    expect(redact("redis://default:secret@redis.example.com:6379")).toContain("[REDACTED_URI]");
    expect(redact("mysql://root:password@localhost/mydb")).toContain("[REDACTED_URI]");
  });

  it("strips ANSI escape sequences", () => {
    const text = "\x1b[31mred text\x1b[0m";
    expect(redact(text)).toBe("red text");
  });
});

describe("equivalent", () => {
  it("matches NFC-normalized text", () => {
    expect(equivalent("café", "café")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(equivalent("Hello World", "hello world")).toBe(true);
  });

  it("collapses whitespace", () => {
    expect(equivalent("hello   world", "hello world")).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(equivalent("", "")).toBe(false);
  });

  it("rejects different text", () => {
    expect(equivalent("hello", "goodbye")).toBe(false);
  });
});

describe("safeDate", () => {
  it("accepts undefined", () => {
    expect(safeDate(undefined)).toBe(true);
  });

  it("accepts ISO date with timezone", () => {
    expect(safeDate("2026-01-15T12:00:00Z")).toBe(true);
    expect(safeDate("2026-01-15T12:00:00+03:00")).toBe(true);
  });

  it("rejects date without timezone", () => {
    expect(safeDate("2026-01-15T12:00:00")).toBe(false);
  });

  it("rejects invalid date", () => {
    expect(safeDate("not-a-date")).toBe(false);
  });
});

describe("hash", () => {
  it("produces consistent SHA-256 hex", () => {
    const h = hash("hello");
    expect(h).toHaveLength(64);
    expect(h).toBe(hash("hello"));
    expect(h).not.toBe(hash("world"));
  });
});
