// outbox worker 獨立進入點：不掛在 Fastify server 內，用獨立程序輪詢 sweeper
// （見 docs/outbox/design.md §8）。本體只做組裝：讀 env、串 runSweepOnce、
// 接 SIGINT/SIGTERM 優雅退出；迴圈本身的排程邏輯在 sweep-loop.ts。

import { env } from "@fastify_drizzle_todolist/env/server";

import { createSweepLoop } from "./outbox/sweep-loop";
import type { SweepResult } from "./outbox/sweeper";
import { runSweepOnce } from "./outbox/sweeper";

const loop = createSweepLoop({
  sweep: runSweepOnce,
  intervalMs: env.OUTBOX_SWEEP_INTERVAL_MS,
  onResult: (result: SweepResult) => {
    console.log(
      `[outbox-worker] 本輪完成：recovered=${result.recovered} done=${result.done} ` +
        `retried=${result.retried} dead=${result.dead}`,
    );
  },
  onSkip: () => {
    console.warn("[outbox-worker] 上一輪 sweep 尚未完成，本輪跳過");
  },
});

console.log(`[outbox-worker] 啟動，輪詢間隔 ${env.OUTBOX_SWEEP_INTERVAL_MS}ms`);
loop.start();

let shuttingDown = false;

/**
 * 優雅退出：先停止排程（不再觸發新的一輪），等目前這輪跑完才結束程序。
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[outbox-worker] 收到 ${signal}，停止排程並等待目前這輪完成...`);
  await loop.stop();
  console.log("[outbox-worker] 已優雅退出");
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
