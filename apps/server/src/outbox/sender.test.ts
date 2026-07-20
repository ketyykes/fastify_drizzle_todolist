import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { db, outboxMessages, todos, users } from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetDb } from "../test/helpers";
import { sendOutboxMessage } from "./sender";

interface ReceivedRequest {
  body: unknown;
}

// mock 外部 webhook 服務：以 node:http 起在 ephemeral port，依測試設定的模式回應。
let mode: "success" | "fail" | "timeout" = "success";
let timeoutDelayMs = 0;
const received: ReceivedRequest[] = [];
let callCount = 0;

const server = createServer((req, res) => {
  callCount += 1;
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf-8");
    received.push({ body: raw ? JSON.parse(raw) : null });

    if (mode === "timeout") {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }, timeoutDelayMs);
      return;
    }

    if (mode === "fail") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "mock failure" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});

let webhookUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  webhookUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(async () => {
  await resetDb();
  mode = "success";
  timeoutDelayMs = 0;
  received.length = 0;
  callCount = 0;
});

afterEach(() => {
  mode = "success";
});

async function insertUserAndTodo(email: string, title = "todo") {
  const [user] = await db
    .insert(users)
    .values({ email, password: "hashed" })
    .returning({ id: users.id });
  if (!user) {
    throw new Error("建立測試使用者失敗");
  }
  const [todo] = await db
    .insert(todos)
    .values({ userId: user.id, title })
    .returning({ id: todos.id });
  if (!todo) {
    throw new Error("建立測試 todo 失敗");
  }
  return todo.id;
}

async function insertOutboxRow(refId: number) {
  const [row] = await db
    .insert(outboxMessages)
    .values({ topic: "todo.completed", refId, status: "processing" })
    .returning();
  if (!row) {
    throw new Error("建立測試 outbox 訊息失敗");
  }
  return row;
}

describe("sendOutboxMessage", () => {
  it("依 refId 重抓最新 todo：入隊後改 title，送出的 payload 是新 title", async () => {
    const refId = await insertUserAndTodo("sender-refetch@example.com", "舊標題");
    const row = await insertOutboxRow(refId);

    await db.update(todos).set({ title: "新標題" }).where(eq(todos.id, refId));

    await sendOutboxMessage(row, { webhookUrl, timeoutMs: 5000 });

    expect(received).toHaveLength(1);
    const body = received[0]?.body as { todo: { title: string } };
    expect(body.todo.title).toBe("新標題");
  });

  it("ref 已刪（todo 不存在）→ 回傳 skipped，且不發出 HTTP 請求", async () => {
    const row = await insertOutboxRow(999_999);

    const result = await sendOutboxMessage(row, { webhookUrl, timeoutMs: 5000 });

    expect(result.skipped).toBe(true);
    expect(callCount).toBe(0);
  });

  it("外部服務回傳非 2xx → 拋出錯誤", async () => {
    const refId = await insertUserAndTodo("sender-fail@example.com");
    const row = await insertOutboxRow(refId);
    mode = "fail";

    await expect(sendOutboxMessage(row, { webhookUrl, timeoutMs: 5000 })).rejects.toThrow();
  });

  it("逾時 → 拋出錯誤", async () => {
    const refId = await insertUserAndTodo("sender-timeout@example.com");
    const row = await insertOutboxRow(refId);
    mode = "timeout";
    timeoutDelayMs = 300;

    await expect(sendOutboxMessage(row, { webhookUrl, timeoutMs: 50 })).rejects.toThrow();
  });
});
