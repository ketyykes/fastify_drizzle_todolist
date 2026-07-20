import fastifyCors from "@fastify/cors";
import fastifyJwt from "@fastify/jwt";
import { env } from "@fastify_drizzle_todolist/env/server";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import { authRoutes } from "./routes/auth";
import { mockExternalRoutes } from "./routes/mock-external";
import { mockSourceRoutes } from "./routes/mock-source";
import { outboxAdminRoutes } from "./routes/outbox-admin";
import { todoRoutes } from "./routes/todos";

// JWT 的 payload 與驗證後掛在 request.user 的型別
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { userId: number };
    user: { userId: number };
  }
}

// buildApp 掛上的 authenticate preHandler 型別
declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const baseCorsConfig = {
  origin: env.CORS_ORIGIN,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  credentials: true,
  maxAge: 86400,
};

/**
 * 建立 Fastify 應用實例。抽成 factory 供 index.ts 啟動與整合測試 app.inject() 共用。
 */
export function buildApp() {
  // 測試時關閉 logger 以保持輸出乾淨
  const app = Fastify({ logger: env.NODE_ENV !== "test" });

  app.register(fastifyCors, baseCorsConfig);
  app.register(fastifyJwt, { secret: env.JWT_SECRET });

  // 受保護端點的 preHandler：驗證 Authorization: Bearer <token>
  app.decorate("authenticate", async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.get("/", async () => "OK");

  app.register(authRoutes);
  app.register(todoRoutes);
  app.register(mockExternalRoutes);
  app.register(mockSourceRoutes);
  app.register(outboxAdminRoutes);

  return app;
}
