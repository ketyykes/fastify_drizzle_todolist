import { db, users } from "@fastify_drizzle_todolist/db";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const BCRYPT_ROUNDS = 10;

const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid input" });
    }
    const { email, password } = parsed.data;

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing.length > 0) {
      return reply.code(409).send({ error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const [created] = await db
      .insert(users)
      .values({ email, password: passwordHash })
      .returning({ id: users.id });
    if (!created) {
      return reply.code(500).send({ error: "Failed to create user" });
    }

    const token = app.jwt.sign({ userId: created.id });
    return reply.code(201).send({ token });
  });

  app.post("/auth/login", async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      // 不洩漏是輸入格式還是帳密問題，一律視為認證失敗
      return reply.code(401).send({ error: "Invalid credentials" });
    }
    const { email, password } = parsed.data;

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    // 帳號不存在或密碼錯皆回一致的 401，不洩漏存在性
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const token = app.jwt.sign({ userId: user.id });
    return reply.code(200).send({ token });
  });

  app.get(
    "/auth/me",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { userId } = request.user;
      const [user] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      return reply.send(user);
    },
  );
}
