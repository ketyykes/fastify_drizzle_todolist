import { env } from "@fastify_drizzle_todolist/env/server";

import { buildApp } from "./app";

const app = buildApp();

// host 綁 0.0.0.0，讓 Docker 容器外（host 映射埠）也能連入
app.listen({ port: env.PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`Server running on port ${env.PORT}`);
});
