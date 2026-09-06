/**
 * Kitty terminal keyboard protocol — regression tests.
 *
 * Kitty terminals report printable characters as CSI-u sequences
 * (e.g. "5" arrives as \x1b[53u). isPlainSearchInput must decode them
 * or typed input is rejected in Kitty terminals. This fix previously
 * lived only on a side branch (c60ed39) and was lost when dev diverged
 * — these tests pin it so that can't happen again.
 */
import { describe, it, expect } from "vitest";
import { isPlainSearchInput } from "../src/pi-base/settings/inline-edit.js";

describe("isPlainSearchInput (Kitty CSI-u decode)", () => {
  it("accepts a plain printable char", () => {
    expect(isPlainSearchInput("5")).toBe(true);
  });

  it("accepts a Kitty CSI-u printable sequence", () => {
    // ASCII 53 = '5' as a CSI-u sequence.
    expect(isPlainSearchInput("\x1b[53u")).toBe(true);
  });

  it("accepts a Kitty CSI-u sequence with Shift", () => {
    // ASCII 97 = 'a', shifted variant 65 = 'A'.
    expect(isPlainSearchInput("\x1b[97;2u")).toBe(true);
  });

  it("rejects control chars and empty input", () => {
    expect(isPlainSearchInput("\x03")).toBe(false); // ctrl+c
    expect(isPlainSearchInput("\x7f")).toBe(false); // backspace
    expect(isPlainSearchInput("")).toBe(false);
  });

  it("rejects non-printable CSI-u sequences (arrows, ctrl combos)", () => {
    // CSI-u with Ctrl modifier (mod 5 → ctrl bit set) — not printable.
    expect(isPlainSearchInput("\x1b[97;5u")).toBe(false);
  });
});
