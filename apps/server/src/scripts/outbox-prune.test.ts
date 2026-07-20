import { describe, expect, it } from "vitest";

import { parsePruneArgs } from "./outbox-prune";

describe("parsePruneArgs", () => {
  it("省略 --days：預設 30 天", () => {
    const result = parsePruneArgs([]);

    expect(result).toEqual({ ok: true, days: 30 });
  });

  it("--days=10：解析出指定天數", () => {
    const result = parsePruneArgs(["--days=10"]);

    expect(result).toEqual({ ok: true, days: 10 });
  });

  it("--days=1：邊界值 1 合法", () => {
    const result = parsePruneArgs(["--days=1"]);

    expect(result).toEqual({ ok: true, days: 1 });
  });

  it("--days=0：小於 1，回傳錯誤", () => {
    const result = parsePruneArgs(["--days=0"]);

    expect(result.ok).toBe(false);
  });

  it("--days=-5：負數，回傳錯誤", () => {
    const result = parsePruneArgs(["--days=-5"]);

    expect(result.ok).toBe(false);
  });

  it("--days=abc：非數字，回傳錯誤", () => {
    const result = parsePruneArgs(["--days=abc"]);

    expect(result.ok).toBe(false);
  });

  it("--days= 空值：回傳錯誤", () => {
    const result = parsePruneArgs(["--days="]);

    expect(result.ok).toBe(false);
  });

  it("其他不相干的參數不影響解析", () => {
    const result = parsePruneArgs(["--verbose", "--days=7"]);

    expect(result).toEqual({ ok: true, days: 7 });
  });
});
