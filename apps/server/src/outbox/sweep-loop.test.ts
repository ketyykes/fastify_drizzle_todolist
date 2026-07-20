import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSweepLoop } from "./sweep-loop";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSweepLoop", () => {
  it("啟動即先跑一輪，不必等第一個 interval tick", async () => {
    const sweep = vi.fn().mockResolvedValue("ok");
    const loop = createSweepLoop({ sweep, intervalMs: 1000 });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sweep).toHaveBeenCalledTimes(1);
    await loop.stop();
  });

  it("之後每隔 intervalMs 觸發一輪", async () => {
    const sweep = vi.fn().mockResolvedValue("ok");
    const loop = createSweepLoop({ sweep, intervalMs: 1000 });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(3);

    await loop.stop();
  });

  it("上一輪尚未完成時，tick 應跳過本輪（呼叫 onSkip）且不重疊執行", async () => {
    let resolveFirst: (() => void) | undefined;
    const sweep = vi.fn();
    // 第一次呼叫回傳可控制的 pending promise，模擬「還在跑」；
    // 之後的呼叫立即 resolve，避免第二輪也卡住導致 stop() 永遠等不到。
    sweep.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = () => resolve("ok");
        }),
    );
    sweep.mockResolvedValue("ok");
    const onSkip = vi.fn();
    const loop = createSweepLoop({ sweep, intervalMs: 1000, onSkip });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1); // 第一輪已啟動但尚未 resolve

    // 第一輪仍在跑時觸發下一個 tick：應跳過，不再呼叫 sweep
    await vi.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);

    // 讓第一輪完成
    resolveFirst?.();
    await vi.advanceTimersByTimeAsync(0);

    // 下一個 tick 恢復正常觸發
    await vi.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it("stop 後不再觸發任何一輪", async () => {
    const sweep = vi.fn().mockResolvedValue("ok");
    const loop = createSweepLoop({ sweep, intervalMs: 1000 });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);

    await loop.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("stop 會等待目前這輪完成才 resolve，並在完成後呼叫 onResult", async () => {
    let resolveFirst: (() => void) | undefined;
    const sweep = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = () => resolve("ok");
        }),
    );
    const onResult = vi.fn();
    const loop = createSweepLoop({ sweep, intervalMs: 1000, onResult });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    let stopped = false;
    const stopPromise = loop.stop().then(() => {
      stopped = true;
    });

    // stop 尚未 resolve，因為第一輪還在跑
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    resolveFirst?.();
    await stopPromise;

    expect(stopped).toBe(true);
    expect(onResult).toHaveBeenCalledWith("ok");
  });
});
