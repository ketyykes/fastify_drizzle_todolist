import { db } from "@fastify_drizzle_todolist/db";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { resetDb } from "../test/helpers";
import { seedDevUser } from "./seed-dev-user";

beforeEach(async () => {
  await resetDb();
});

describe("seedDevUser", () => {
  it("seed_creates_user_when_absent", async () => {
    const email = "seed-absent@example.com";
    const password = "seed-password123";

    await seedDevUser({ email, password });

    const rows = await db.execute(
      sql`select password from users where email = ${email}`,
    );
    expect(rows.rows.length).toBe(1);

    const stored = rows.rows[0]?.password as string;
    expect(stored).not.toBe(password);
    expect(await bcrypt.compare(password, stored)).toBe(true);
  });
});
