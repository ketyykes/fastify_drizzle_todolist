import { db } from "@fastify_drizzle_todolist/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestApp, registerAndGetToken, resetDb } from "../test/helpers";

const app = createTestApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await app.close();
});

describe("POST /auth/register", () => {
  it("register_creates_user_and_returns_token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "alice@example.com", password: "password123" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);

    const rows = await db.execute(
      sql`select count(*)::int as count from users where email = 'alice@example.com'`,
    );
    expect(rows.rows[0]?.count).toBe(1);
  });

  it("register_hashes_password_not_plaintext", async () => {
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "bob@example.com", password: "password123" },
    });

    const rows = await db.execute(
      sql`select password from users where email = 'bob@example.com'`,
    );
    const stored = rows.rows[0]?.password as string;
    expect(stored).not.toBe("password123");
    expect(stored.startsWith("$2")).toBe(true);
  });

  it("register_rejects_duplicate_email", async () => {
    const payload = { email: "dup@example.com", password: "password123" };
    await app.inject({ method: "POST", url: "/auth/register", payload });
    const res = await app.inject({ method: "POST", url: "/auth/register", payload });

    expect(res.statusCode).toBe(409);
    const rows = await db.execute(
      sql`select count(*)::int as count from users where email = 'dup@example.com'`,
    );
    expect(rows.rows[0]?.count).toBe(1);
  });

  it("register_rejects_invalid_input", async () => {
    const missingPassword = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "no-password@example.com" },
    });
    expect(missingPassword.statusCode).toBe(400);

    const badEmail = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "not-an-email", password: "password123" },
    });
    expect(badEmail.statusCode).toBe(400);

    const shortPassword = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "shortpw@example.com", password: "123" },
    });
    expect(shortPassword.statusCode).toBe(400);
  });
});

describe("POST /auth/login", () => {
  it("login_returns_token_on_valid_credentials", async () => {
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "carol@example.com", password: "password123" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "carol@example.com", password: "password123" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);

    // token 應可用於受保護端點且對應到同一使用者
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe("carol@example.com");
  });

  it("login_rejects_wrong_credentials", async () => {
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "dave@example.com", password: "password123" },
    });

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "dave@example.com", password: "wrong-password" },
    });
    expect(wrongPassword.statusCode).toBe(401);

    const noSuchUser = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody@example.com", password: "password123" },
    });
    expect(noSuchUser.statusCode).toBe(401);
  });
});

describe("authenticate preHandler (透過 GET /auth/me)", () => {
  it("authenticate_allows_valid_token", async () => {
    const token = await registerAndGetToken(app, "erin@example.com");
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("authenticate_blocks_invalid_token", async () => {
    const noToken = await app.inject({ method: "GET", url: "/auth/me" });
    expect(noToken.statusCode).toBe(401);

    const badToken = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(badToken.statusCode).toBe(401);
  });
});

describe("GET /auth/me", () => {
  it("me_returns_current_user_without_password", async () => {
    const token = await registerAndGetToken(app, "frank@example.com");
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBe("frank@example.com");
    expect(typeof body.id).toBe("number");
    expect(body).not.toHaveProperty("password");
  });

  it("me_rejects_missing_or_invalid_token", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/me" });
    expect(res.statusCode).toBe(401);
  });
});
