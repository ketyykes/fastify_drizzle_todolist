import { db, todos } from "@fastify_drizzle_todolist/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const createTodoSchema = z.object({
  title: z.string().min(1),
});

const updateTodoSchema = z.object({
  title: z.string().min(1).optional(),
  completed: z.boolean().optional(),
});

const paramsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export async function todoRoutes(app: FastifyInstance) {
  // 本群組所有 todos 端點都需登入
  app.addHook("preHandler", app.authenticate);

  app.get("/todos", async (request) => {
    const { userId } = request.user;
    return db
      .select()
      .from(todos)
      .where(eq(todos.userId, userId))
      .orderBy(todos.id);
  });

  app.post("/todos", async (request, reply) => {
    const parsed = createTodoSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid input" });
    }
    const { userId } = request.user;
    const [created] = await db
      .insert(todos)
      .values({ userId, title: parsed.data.title })
      .returning();
    return reply.code(201).send(created);
  });

  app.patch("/todos/:id", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid id" });
    }
    const body = updateTodoSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid input" });
    }
    if (body.data.title === undefined && body.data.completed === undefined) {
      return reply.code(400).send({ error: "No fields to update" });
    }

    const { userId } = request.user;
    // 查詢條件同時比對 id 與 userId：他人資源等同不存在
    const [updated] = await db
      .update(todos)
      .set(body.data)
      .where(and(eq(todos.id, params.data.id), eq(todos.userId, userId)))
      .returning();
    if (!updated) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.send(updated);
  });

  app.delete("/todos/:id", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid id" });
    }
    const { userId } = request.user;
    const [deleted] = await db
      .delete(todos)
      .where(and(eq(todos.id, params.data.id), eq(todos.userId, userId)))
      .returning({ id: todos.id });
    if (!deleted) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.code(204).send();
  });
}
