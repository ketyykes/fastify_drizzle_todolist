import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { setOutboxConfigForTest } from "../outbox/config";
import { createTestApp } from "../test/helpers";

const app = createTestApp();

beforeEach(async () => {
  // 每個測試前重置 mock 外部服務的 mode / received，避免互相污染
  // （/mock-external/reset 端點依規格只清 received，故 mode 需另外設回 success）
  await app.inject({ method: "POST", url: "/mock-external/reset" });
  await app.inject({
    method: "PUT",
    url: "/mock-external/mode",
    payload: { mode: "success" },
  });
});

afterEach(() => {
  setOutboxConfigForTest(null);
});

afterAll(async () => {
  await app.close();
});

async function setMode(mode: "success" | "fail" | "timeout") {
  return app.inject({ method: "PUT", url: "/mock-external/mode", payload: { mode } });
}

describe("GET /mock-external/notifications", () => {
  it("預設 mode 為 success 且 received 為空陣列", async () => {
    const res = await app.inject({ method: "GET", url: "/mock-external/notifications" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe("success");
    expect(body.received).toEqual([]);
  });
});

describe("PUT /mock-external/mode", () => {
  it("可切換 mode 為 fail / timeout / success", async () => {
    const toFail = await setMode("fail");
    expect(toFail.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/mock-external/notifications" })).json().mode,
    ).toBe("fail");

    const toTimeout = await setMode("timeout");
    expect(toTimeout.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/mock-external/notifications" })).json().mode,
    ).toBe("timeout");

    const toSuccess = await setMode("success");
    expect(toSuccess.statusCode).toBe(200);
  });

  it("非法 mode 值回傳 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/mock-external/mode",
      payload: { mode: "not-a-mode" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /mock-external/notifications", () => {
  it("success 模式：回 200 並記錄收到的 payload", async () => {
    const payload = { topic: "todo.completed", refId: 1, action: "sync", todo: { id: 1 } };
    const res = await app.inject({
      method: "POST",
      url: "/mock-external/notifications",
      payload,
    });
    expect(res.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/mock-external/notifications" });
    const body = list.json();
    expect(body.received).toHaveLength(1);
    expect(body.received[0]).toMatchObject(payload);
  });

  it("fail 模式：回 500 且不記錄 received", async () => {
    await setMode("fail");
    const res = await app.inject({
      method: "POST",
      url: "/mock-external/notifications",
      payload: { topic: "todo.completed", refId: 2 },
    });
    expect(res.statusCode).toBe(500);

    const list = await app.inject({ method: "GET", url: "/mock-external/notifications" });
    expect(list.json().received).toHaveLength(0);
  });

  it("timeout 模式：延遲需超過 sender timeout 才回應 200", async () => {
    setOutboxConfigForTest({ webhookUrl: "http://unused.invalid", timeoutMs: 50 });
    await setMode("timeout");

    const start = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/mock-external/notifications",
      payload: { topic: "todo.completed", refId: 3 },
    });
    const elapsed = Date.now() - start;

    expect(res.statusCode).toBe(200);
    expect(elapsed).toBeGreaterThan(50);
  });
});

describe("POST /mock-external/reset", () => {
  it("清空 received 清單", async () => {
    await app.inject({
      method: "POST",
      url: "/mock-external/notifications",
      payload: { topic: "todo.completed", refId: 9 },
    });
    expect(
      (await app.inject({ method: "GET", url: "/mock-external/notifications" })).json().received,
    ).toHaveLength(1);

    const res = await app.inject({ method: "POST", url: "/mock-external/reset" });
    expect(res.statusCode).toBe(200);

    expect(
      (await app.inject({ method: "GET", url: "/mock-external/notifications" })).json().received,
    ).toHaveLength(0);
  });
});
