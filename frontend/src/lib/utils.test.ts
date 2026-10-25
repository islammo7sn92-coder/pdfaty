import { describe, expect, it } from "vitest";
import { formatBytes, parseRange, stem } from "./utils";

describe("parseRange", () => {
  it("parses ranges, lists and open ends", () => {
    expect(parseRange("1-3,5", 10)).toEqual([0, 1, 2, 4]);
    expect(parseRange("8-", 10)).toEqual([7, 8, 9]);
    expect(parseRange("", 3)).toEqual([0, 1, 2]);
  });
  it("accepts Arabic digits and comma", () => {
    expect(parseRange("١-٢،٤", 5)).toEqual([0, 1, 3]);
  });
  it("rejects invalid input", () => {
    expect(parseRange("0", 5)).toBeNull();
    expect(parseRange("3-9", 5)).toBeNull();
    expect(parseRange("abc", 5)).toBeNull();
  });
});

describe("misc", () => {
  it("formats bytes", () => {
    expect(formatBytes(1536, "en")).toBe("1.5 KB");
    expect(formatBytes(10, "en")).toBe("10 B");
  });
  it("strips extension", () => {
    expect(stem("file.name.pdf")).toBe("file.name");
    expect(stem("noext")).toBe("noext");
  });
});
