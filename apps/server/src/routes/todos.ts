import { db, todos } from "@fastify_drizzle_todolist/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { flushOutboxFastPath } from "../outbox/fast-path";
import { enqueueOutbox } from "../outbox/repository";
import { idParamSchema } from "../schemas";

const createTodoSchema = z.object({
  title: z.string().min(1),
});

const updateTodoSchema = z.object({
  title: z.string().min(1).optional(),
  completed: z.boolean().optional(),
});

export async function todoRoutes(app: FastifyInstance) {
  // 本群組所有 todos 端點都需登入
  app.addHook("preHandler", app.authenticate);

  app.get("/todos", async (request) => {
    const { userId } = request.user;
    return db.select().from(todos).where(eq(todos.userId, userId)).orderBy(todos.id);
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
    const params = idParamSchema.safeParse(request.params);
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
    let outboxId: number | null = null;

    // 查詢條件同時比對 id 與 userId：他人資源等同不存在
    const updated = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(todos)
        .where(and(eq(todos.id, params.data.id), eq(todos.userId, userId)))
        .limit(1);
      if (!existing) {
        return undefined;
      }

      const [row] = await tx
        .update(todos)
        .set(body.data)
        .where(and(eq(todos.id, params.data.id), eq(todos.userId, userId)))
        .returning();

      // completed 由 false→true 才算「完成」事件（true→true、只改 title 皆不算狀態轉移）
      if (existing.completed === false && row?.completed === true) {
        outboxId = await enqueueOutbox(tx, { topic: "todo.completed", refId: params.data.id });
      }

      return row;
    });

    if (!updated) {
      return reply.code(404).send({ error: "Not found" });
    }

    if (outboxId !== null) {
      // commit 後才 best-effort 試送，且整段包 try/catch：任何失敗都不影響已提交的回應
      try {
        await flushOutboxFastPath(outboxId);
      } catch (error) {
        console.warn(`[outbox] PATCH /todos/${params.data.id} fast-path 觸發失敗`, error);
      }
    }

    return reply.send(updated);
  });

  app.delete("/todos/:id", async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
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
