import type { AddressInfo } from "node:net";

import { db, outboxMessages, todos, users } from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setOutboxConfigForTest } from "../outbox/config";
import { createTestApp, registerAndGetToken, resetDb } from "../test/helpers";

const app = createTestApp();

let webhookUrl: string;

beforeAll(async () => {
  await app.listen({ port: 0 });
  const address = app.server.address() as AddressInfo;
  webhookUrl = `http://127.0.0.1:${address.port}/mock-external/notifications`;
  setOutboxConfigForTest({ webhookUrl, timeoutMs: 3000 });
});

afterAll(async () => {
  setOutboxConfigForTest(null);
  await app.close();
});

beforeEach(async () => {
  await resetDb();
  await app.inject({ method: "POST", url: "/mock-external/reset" });
  await app.inject({
    method: "PUT",
    url: "/mock-external/mode",
    payload: { mode: "success" },
  });
});

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function insertUserAndTodo(email: string) {
  const [user] = await db
    .insert(users)
    .values({ email, password: "hashed" })
    .returning({ id: users.id });
  if (!user) {
    throw new Error("建立測試使用者失敗");
  }
  const [todo] = await db
    .insert(todos)
    .values({ userId: user.id, title: "todo" })
    .returning({ id: todos.id });
  if (!todo) {
    throw new Error("建立測試 todo 失敗");
  }
  return todo.id;
}

describe("認證", () => {
  it("未帶 token 呼叫三支端點皆回 401", async () => {
    const stats = await app.inject({ method: "GET", url: "/outbox/stats" });
    expect(stats.statusCode).toBe(401);

    const requeue = await app.inject({ method: "POST", url: "/outbox/requeue-dead" });
    expect(requeue.statusCode).toBe(401);

    const sweep = await app.inject({ method: "POST", url: "/outbox/sweep" });
    expect(sweep.statusCode).toBe(401);
  });
});

describe("GET /outbox/stats", () => {
  it("回傳各狀態計數與最近 20 列", async () => {
    const token = await registerAndGetToken(app, "admin-stats@example.com");
    const refId = await insertUserAndTodo("stats-todo@example.com");

    await db.insert(outboxMessages).values({ topic: "todo.completed", refId, status: "pending" });
    await db
      .insert(outboxMessages)
      .values({ topic: "todo.completed", refId, status: "processing" });
    await db.insert(outboxMessages).values({ topic: "todo.completed", refId, status: "done" });
    await db.insert(outboxMessages).values({ topic: "todo.completed", refId, status: "dead" });

    const res = await app.inject({ method: "GET", url: "/outbox/stats", headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.counts).toEqual({ pending: 1, processing: 1, done: 1, dead: 1 });
    expect(Array.isArray(body.recent)).toBe(true);
    expect(body.recent.length).toBeLessThanOrEqual(20);
    expect(body.recent.length).toBeGreaterThanOrEqual(4);
  });
});

describe("POST /outbox/sweep", () => {
  it("實際觸發一輪 sweep：到期 pending 轉為 done", async () => {
    const token = await registerAndGetToken(app, "admin-sweep@example.com");
    const refId = await insertUserAndTodo("sweep-todo@example.com");
    const [row] = await db
      .insert(outboxMessages)
      .values({ topic: "todo.completed", refId })
      .returning();
    if (!row) {
      throw new Error("建立測試 outbox 訊息失敗");
    }

    const res = await app.inject({ method: "POST", url: "/outbox/sweep", headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.done).toBe(1);

    const [persisted] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, row.id));
    expect(persisted?.status).toBe("done");
  });
});

describe("POST /outbox/requeue-dead", () => {
  it("指定 ids 只重排該幾筆", async () => {
    const token = await registerAndGetToken(app, "admin-requeue-ids@example.com");
    const refId = await insertUserAndTodo("requeue-ids-todo@example.com");
    const [deadA] = await db
      .insert(outboxMessages)
      .values({ topic: "todo.completed", refId, status: "dead", attempts: 8, lastError: "boom" })
      .returning();
    const [deadB] = await db
      .insert(outboxMessages)
      .values({ topic: "todo.completed", refId, status: "dead", attempts: 8, lastError: "boom" })
      .returning();
    if (!deadA || !deadB) {
      throw new Error("建立測試 outbox 訊息失敗");
    }

    const res = await app.inject({
      method: "POST",
      url: "/outbox/requeue-dead",
      headers: auth(token),
      payload: { ids: [deadA.id] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().requeued).toBe(1);

    const [persistedA] = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, deadA.id));
    expect(persistedA?.status).toBe("pending");
    expect(persistedA?.attempts).toBe(0);
    expect(persistedA?.lastError).toBeNull();

    const [persistedB] = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, deadB.id));
    expect(persistedB?.status).toBe("dead");
  });

  it("省略 ids 時重排全部 dead", async () => {
    const token = await registerAndGetToken(app, "admin-requeue-all@example.com");
    const refId = await insertUserAndTodo("requeue-all-todo@example.com");
    await db
      .insert(outboxMessages)
      .values({ topic: "todo.completed", refId, status: "dead", attempts: 8 });
    await db
      .insert(outboxMessages)
      .values({ topic: "todo.completed", refId, status: "dead", attempts: 8 });

    const res = await app.inject({
      method: "POST",
      url: "/outbox/requeue-dead",
      headers: auth(token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().requeued).toBe(2);
  });

  it("body 格式不合法回 400", async () => {
    const token = await registerAndGetToken(app, "admin-requeue-bad@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/outbox/requeue-dead",
      headers: auth(token),
      payload: { ids: "not-an-array" },
    });
    expect(res.statusCode).toBe(400);
  });
});
