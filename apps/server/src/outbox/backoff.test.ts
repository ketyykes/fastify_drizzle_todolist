import { describe, expect, it } from "vitest";

import { computeNextAttemptAt } from "./backoff";

// 退避查表：第 1~4 次失敗分別等 1 / 5 / 15 / 60 分鐘，第 5 次起封頂 360 分鐘，無 jitter。
describe("computeNextAttemptAt", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it.each([
    [1, 1],
    [2, 5],
    [3, 15],
    [4, 60],
    [5, 360],
    [99, 360],
  ])("第 %i 次失敗 → 等待 %i 分鐘", (attempts, expectedMinutes) => {
    const result = computeNextAttemptAt(attempts, now);
    expect(result.getTime()).toBe(now.getTime() + expectedMinutes * 60_000);
  });
});
