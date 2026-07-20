import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getOutboxConfig } from "../outbox/config";

// timeout 模式的延遲緩衝：確保延遲時間必超過 sender 逾時設定，讓呼叫端一定先逾時。
const TIMEOUT_MODE_BUFFER_MS = 200;

type MockExternalMode = "success" | "fail" | "timeout";

// 模擬第三方外部服務：無認證，狀態存 module 層記憶體（供測試/示範觀察）。
let mode: MockExternalMode = "success";
const received: unknown[] = [];

const modeSchema = z.object({
  mode: z.enum(["success", "fail", "timeout"]),
});

/**
 * 測試專用：把 mock 外部服務的記憶體狀態（mode / received）重置為初始值。
 */
export function resetMockExternalState(): void {
  mode = "success";
  received.length = 0;
}

export async function mockExternalRoutes(app: FastifyInstance) {
  app.post("/mock-external/notifications", async (request, reply) => {
    if (mode === "fail") {
      return reply.code(500).send({ error: "mock failure" });
    }

    if (mode === "timeout") {
      const delayMs = getOutboxConfig().timeoutMs + TIMEOUT_MODE_BUFFER_MS;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return reply.code(200).send({ ok: true });
    }

    received.push(request.body);
    return reply.code(200).send({ ok: true });
  });

  app.get("/mock-external/notifications", async () => {
    return { mode, received };
  });

  app.put("/mock-external/mode", async (request, reply) => {
    const parsed = modeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid mode" });
    }
    mode = parsed.data.mode;
    return reply.send({ mode });
  });

  app.post("/mock-external/reset", async () => {
    received.length = 0;
    return { ok: true };
  });
}
