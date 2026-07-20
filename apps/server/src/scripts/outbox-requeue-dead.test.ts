import { describe, expect, it } from "vitest";

import { parseRequeueDeadArgs } from "./outbox-requeue-dead";

describe("parseRequeueDeadArgs", () => {
  it("省略 --id：代表重排全部 dead 訊息，ids 為 undefined", () => {
    const result = parseRequeueDeadArgs([]);

    expect(result).toEqual({ ok: true, ids: undefined });
  });

  it("--id=1：解析出單一 id", () => {
    const result = parseRequeueDeadArgs(["--id=1"]);

    expect(result).toEqual({ ok: true, ids: [1] });
  });

  it("--id=1,2,3：解析出多個 id", () => {
    const result = parseRequeueDeadArgs(["--id=1,2,3"]);

    expect(result).toEqual({ ok: true, ids: [1, 2, 3] });
  });

  it("--id=1, 2 ,3：容許逗號周圍空白", () => {
    const result = parseRequeueDeadArgs(["--id=1, 2 ,3"]);

    expect(result).toEqual({ ok: true, ids: [1, 2, 3] });
  });

  it("--id= 空值：回傳錯誤（防止誤觸全部重排）", () => {
    const result = parseRequeueDeadArgs(["--id="]);

    expect(result.ok).toBe(false);
  });

  it("--id=1,,2 含空白項目：回傳錯誤", () => {
    const result = parseRequeueDeadArgs(["--id=1,,2"]);

    expect(result.ok).toBe(false);
  });

  it("--id=abc 含非數字：回傳錯誤", () => {
    const result = parseRequeueDeadArgs(["--id=abc"]);

    expect(result.ok).toBe(false);
  });

  it("--id=1,abc,2 部分非數字：回傳錯誤", () => {
    const result = parseRequeueDeadArgs(["--id=1,abc,2"]);

    expect(result.ok).toBe(false);
  });

  it("--id=0 或負數：回傳錯誤（id 從 1 起）", () => {
    expect(parseRequeueDeadArgs(["--id=0"]).ok).toBe(false);
    expect(parseRequeueDeadArgs(["--id=-1"]).ok).toBe(false);
  });

  it("其他不相干的參數不影響解析", () => {
    const result = parseRequeueDeadArgs(["--verbose", "--id=5"]);

    expect(result).toEqual({ ok: true, ids: [5] });
  });
});
