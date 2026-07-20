import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { db, outboxMessages, todos, users } from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetDb } from "../test/helpers";
import { setOutboxConfigForTest } from "./config";
import { runSweepOnce } from "./sweeper";

// mock 外部 webhook 服務：依請求 payload 的 refId 決定成功或失敗，模擬批次中有成有敗。
const failingRefIds = new Set<number>();

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf-8");
    const body = raw ? (JSON.parse(raw) as { refId: number }) : { refId: -1 };

    if (failingRefIds.has(body.refId)) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "mock failure" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  setOutboxConfigForTest({ webhookUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 5000 });
});

afterAll(async () => {
  setOutboxConfigForTest(null);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(async () => {
  await resetDb();
  failingRefIds.clear();
});

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

describe("runSweepOnce", () => {
  it("整輪完成狀態轉移：成功/退避重試/轉死信/卡住回收皆各自正確，單筆失敗不中斷整批，並回傳正確計數", async () => {
    const successRefId = await insertUserAndTodo("sweep-success@example.com");
    const retryRefId = await insertUserAndTodo("sweep-retry@example.com");
    const deadRefId = await insertUserAndTodo("sweep-dead@example.com");
    const staleRefId = await insertUserAndTodo("sweep-stale@example.com");

    failingRefIds.add(retryRefId);
    failingRefIds.add(deadRefId);

    const [successRow] = await db
      .insert(outboxMessages)
      .values({ topic: "todo.completed", refId: successRefId })
      .returning();
    const [retryRow] = await db
      .insert(outboxMessages)
      .values({ topic: "todo.completed", refId: retryRefId, maxAttempts: 8 })
      .returning();
    const [deadRow] = await db
      .insert(outboxMessages)
      .values({ topic: "todo.completed", refId: deadRefId, maxAttempts: 1 })
      .returning();
    // 卡住的 processing：next_attempt_at 設在未來，確保恢復後本輪不會又被 claim 到，
    // 讓 recovered 與 done/retried/dead 的計數互不干擾。
    const [staleRow] = await db
      .insert(outboxMessages)
      .values({
        topic: "todo.completed",
        refId: staleRefId,
        status: "processing",
        lockedAt: new Date(Date.now() - 20 * 60_000),
        nextAttemptAt: new Date(Date.now() + 60 * 60_000),
      })
      .returning();

    if (!successRow || !retryRow || !deadRow || !staleRow) {
      throw new Error("建立測試 outbox 訊息失敗");
    }

    const result = await runSweepOnce();

    expect(result).toEqual({ recovered: 1, done: 1, retried: 1, dead: 1 });

    const [persistedSuccess] = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, successRow.id));
    expect(persistedSuccess?.status).toBe("done");

    const [persistedRetry] = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, retryRow.id));
    expect(persistedRetry?.status).toBe("pending");
    expect(persistedRetry?.attempts).toBe(1);

    const [persistedDead] = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, deadRow.id));
    expect(persistedDead?.status).toBe("dead");
    expect(persistedDead?.attempts).toBe(1);

    const [persistedStale] = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, staleRow.id));
    expect(persistedStale?.status).toBe("pending");
    expect(persistedStale?.lockedAt).toBeNull();
  });

  it("批次全數為 pending 但已被別的 worker 認領（無到期列）時，回傳全零計數", async () => {
    const result = await runSweepOnce();

    expect(result).toEqual({ recovered: 0, done: 0, retried: 0, dead: 0 });
  });
});
