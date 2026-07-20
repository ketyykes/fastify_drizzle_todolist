import type { AddressInfo } from "node:net";

import { db, outboxMessages } from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setOutboxConfigForTest } from "../outbox/config";
import { createTestApp, registerAndGetToken, resetDb } from "../test/helpers";

const app = createTestApp();

// fast-path 會透過真實 HTTP 呼叫 mock 外部服務：整個測試檔一律把 outbox 設定指向
// 本測試 app 自己的 /mock-external/notifications（ephemeral port）。
// 若只在 outbox describe 內覆寫，前面的一般 PATCH 測試翻轉 completed 時
// 會打到 env 預設的 7529 dev server，測試結果取決於外部狀態（曾因 dev server
// 的 mock 停在 timeout 模式而逾時），故提升到檔案層級確保測試封閉。
beforeAll(async () => {
  await app.listen({ port: 0 });
  const address = app.server.address() as AddressInfo;
  setOutboxConfigForTest({
    webhookUrl: `http://127.0.0.1:${address.port}/mock-external/notifications`,
    timeoutMs: 3000,
  });
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  setOutboxConfigForTest(null);
  await app.close();
});

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createTodo(token: string, title: string) {
  return app.inject({
    method: "POST",
    url: "/todos",
    headers: auth(token),
    payload: { title },
  });
}

describe("POST /todos", () => {
  it("create_todo_persists_for_current_user", async () => {
    const token = await registerAndGetToken(app, "owner@example.com");
    const res = await createTodo(token, "Buy milk");

    expect(res.statusCode).toBe(201);
    const todo = res.json();
    expect(todo.title).toBe("Buy milk");
    expect(todo.completed).toBe(false);
    expect(typeof todo.id).toBe("number");

    const list = await app.inject({ method: "GET", url: "/todos", headers: auth(token) });
    expect(list.json()).toHaveLength(1);
  });

  it("create_todo_rejects_empty_title", async () => {
    const token = await registerAndGetToken(app, "empty@example.com");

    const missing = await app.inject({
      method: "POST",
      url: "/todos",
      headers: auth(token),
      payload: {},
    });
    expect(missing.statusCode).toBe(400);

    const blank = await createTodo(token, "");
    expect(blank.statusCode).toBe(400);
  });
});

describe("GET /todos", () => {
  it("list_todos_returns_only_own", async () => {
    const a = await registerAndGetToken(app, "list-a@example.com");
    const b = await registerAndGetToken(app, "list-b@example.com");
    await createTodo(a, "A task 1");
    await createTodo(a, "A task 2");
    await createTodo(b, "B task");

    const listA = await app.inject({ method: "GET", url: "/todos", headers: auth(a) });
    expect(listA.statusCode).toBe(200);
    const todos = listA.json();
    expect(todos).toHaveLength(2);
    expect(todos.every((t: { title: string }) => t.title.startsWith("A task"))).toBe(true);
  });
});

describe("PATCH /todos/:id", () => {
  it("patch_todo_updates_completed", async () => {
    const token = await registerAndGetToken(app, "patch@example.com");
    const created = (await createTodo(token, "Toggle me")).json();

    const res = await app.inject({
      method: "PATCH",
      url: `/todos/${created.id}`,
      headers: auth(token),
      payload: { completed: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().completed).toBe(true);
  });

  it("patch_todo_returns_404_when_missing", async () => {
    const token = await registerAndGetToken(app, "patch404@example.com");
    const res = await app.inject({
      method: "PATCH",
      url: "/todos/999999",
      headers: auth(token),
      payload: { completed: true },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /todos/:id", () => {
  it("delete_todo_removes_own", async () => {
    const token = await registerAndGetToken(app, "del@example.com");
    const created = (await createTodo(token, "Delete me")).json();

    const res = await app.inject({
      method: "DELETE",
      url: `/todos/${created.id}`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(204);

    const list = await app.inject({ method: "GET", url: "/todos", headers: auth(token) });
    expect(list.json()).toHaveLength(0);
  });
});

describe("跨使用者隔離", () => {
  it("patch_others_todo_returns_404", async () => {
    const a = await registerAndGetToken(app, "iso-a@example.com");
    const b = await registerAndGetToken(app, "iso-b@example.com");
    const bTodo = (await createTodo(b, "B private")).json();

    const res = await app.inject({
      method: "PATCH",
      url: `/todos/${bTodo.id}`,
      headers: auth(a),
      payload: { completed: true },
    });
    expect(res.statusCode).toBe(404);

    // B 的資料未被更動
    const listB = await app.inject({ method: "GET", url: "/todos", headers: auth(b) });
    expect(listB.json()[0].completed).toBe(false);
  });

  it("delete_others_todo_returns_404", async () => {
    const a = await registerAndGetToken(app, "iso-a2@example.com");
    const b = await registerAndGetToken(app, "iso-b2@example.com");
    const bTodo = (await createTodo(b, "B private 2")).json();

    const res = await app.inject({
      method: "DELETE",
      url: `/todos/${bTodo.id}`,
      headers: auth(a),
    });
    expect(res.statusCode).toBe(404);

    // B 的資料仍在
    const listB = await app.inject({ method: "GET", url: "/todos", headers: auth(b) });
    expect(listB.json()).toHaveLength(1);
  });

  it("list_excludes_other_users_todos", async () => {
    const a = await registerAndGetToken(app, "iso-a3@example.com");
    const b = await registerAndGetToken(app, "iso-b3@example.com");
    await createTodo(b, "B only");

    const listA = await app.inject({ method: "GET", url: "/todos", headers: auth(a) });
    expect(listA.json()).toHaveLength(0);
  });
});

describe("PATCH /todos/:id — outbox 事件（transactional outbox）", () => {
  // webhook 指向與逾時設定已在檔案層級的 beforeAll 統一覆寫
  beforeEach(async () => {
    await app.inject({ method: "POST", url: "/mock-external/reset" });
    await app.inject({
      method: "PUT",
      url: "/mock-external/mode",
      payload: { mode: "success" },
    });
  });

  async function findOutboxRows(refId: number) {
    return db.select().from(outboxMessages).where(eq(outboxMessages.refId, refId));
  }

  it("completed false→true 入隊一筆，fast-path 成功後列變 done 且 mock 收到 payload", async () => {
    const token = await registerAndGetToken(app, "outbox-flip@example.com");
    const created = (await createTodo(token, "Ship it")).json();

    const res = await app.inject({
      method: "PATCH",
      url: `/todos/${created.id}`,
      headers: auth(token),
      payload: { completed: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().completed).toBe(true);

    const rows = await findOutboxRows(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.topic).toBe("todo.completed");
    expect(rows[0]?.status).toBe("done");

    const mockList = await app.inject({ method: "GET", url: "/mock-external/notifications" });
    const received = mockList.json().received as Array<{
      refId: number;
      topic: string;
      todo: { title: string; completed: boolean };
    }>;
    expect(received).toHaveLength(1);
    expect(received[0]?.refId).toBe(created.id);
    expect(received[0]?.topic).toBe("todo.completed");
    expect(received[0]?.todo.title).toBe("Ship it");
    expect(received[0]?.todo.completed).toBe(true);
  });

  it("completed true→true 不重複入隊", async () => {
    const token = await registerAndGetToken(app, "outbox-notrans@example.com");
    const created = (await createTodo(token, "Already done")).json();

    await app.inject({
      method: "PATCH",
      url: `/todos/${created.id}`,
      headers: auth(token),
      payload: { completed: true },
    });
    expect(await findOutboxRows(created.id)).toHaveLength(1);

    // 再次 PATCH completed: true（true→true，非狀態轉移）不應再入隊
    const res = await app.inject({
      method: "PATCH",
      url: `/todos/${created.id}`,
      headers: auth(token),
      payload: { completed: true },
    });
    expect(res.statusCode).toBe(200);
    expect(await findOutboxRows(created.id)).toHaveLength(1);
  });

  it("只改 title 不入隊", async () => {
    const token = await registerAndGetToken(app, "outbox-titleonly@example.com");
    const created = (await createTodo(token, "Rename me")).json();

    const res = await app.inject({
      method: "PATCH",
      url: `/todos/${created.id}`,
      headers: auth(token),
      payload: { title: "Renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe("Renamed");
    expect(await findOutboxRows(created.id)).toHaveLength(0);
  });

  it("他人 todo 仍回 404，且不入隊", async () => {
    const a = await registerAndGetToken(app, "outbox-iso-a@example.com");
    const b = await registerAndGetToken(app, "outbox-iso-b@example.com");
    const bTodo = (await createTodo(b, "B private outbox")).json();

    const res = await app.inject({
      method: "PATCH",
      url: `/todos/${bTodo.id}`,
      headers: auth(a),
      payload: { completed: true },
    });
    expect(res.statusCode).toBe(404);
    expect(await findOutboxRows(bTodo.id)).toHaveLength(0);
  });

  it("fast-path 失敗（mode=fail）→ 列留 pending、attempts=1、有 last_error 與 next_attempt_at，PATCH 回應仍 200", async () => {
    await app.inject({
      method: "PUT",
      url: "/mock-external/mode",
      payload: { mode: "fail" },
    });

    const token = await registerAndGetToken(app, "outbox-fail@example.com");
    const created = (await createTodo(token, "Will fail")).json();

    const before = new Date();
    const res = await app.inject({
      method: "PATCH",
      url: `/todos/${created.id}`,
      headers: auth(token),
      payload: { completed: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().completed).toBe(true);

    const rows = await findOutboxRows(created.id);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBeTruthy();
    expect(row?.nextAttemptAt).toBeTruthy();
    expect((row?.nextAttemptAt as Date).getTime()).toBeGreaterThan(before.getTime());
  });
});
