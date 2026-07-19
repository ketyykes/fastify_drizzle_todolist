import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestApp, registerAndGetToken, resetDb } from "../test/helpers";

const app = createTestApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
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
