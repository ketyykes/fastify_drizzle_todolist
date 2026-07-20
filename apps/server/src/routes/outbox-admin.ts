import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getOutboxStats, requeueDead } from "../outbox/repository";
import { runSweepOnce } from "../outbox/sweeper";

const requeueDeadSchema = z.object({
  ids: z.array(z.number().int().positive()).optional(),
});

export async function outboxAdminRoutes(app: FastifyInstance) {
  // 本群組所有 outbox 管理端點都需登入
  app.addHook("preHandler", app.authenticate);

  app.get("/outbox/stats", async () => {
    return getOutboxStats();
  });

  app.post("/outbox/requeue-dead", async (request, reply) => {
    const parsed = requeueDeadSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid input" });
    }
    const requeued = await requeueDead(parsed.data.ids);
    return reply.send({ requeued });
  });

  app.post("/outbox/sweep", async () => {
    return runSweepOnce();
  });
}
