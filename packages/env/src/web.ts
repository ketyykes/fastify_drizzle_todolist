import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

type ImportMetaEnvRecord = Record<string, string | boolean | undefined>;

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    // 預設指向 Docker 後端的 host 映射埠（前端本機 vite dev 直連）
    VITE_SERVER_URL: z.url().default("http://localhost:3001"),
  },
  runtimeEnv: (import.meta as ImportMeta & { env: ImportMetaEnvRecord }).env,
  emptyStringAsUndefined: true,
});
