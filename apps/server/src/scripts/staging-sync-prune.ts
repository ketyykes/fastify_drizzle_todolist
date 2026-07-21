// 維運指令：跑一次 staging-sync 的 retention 清理（見 staging-sync/pruner.ts）。
// 三道保留期門檻皆讀自 getStagingSyncConfig().retention，不接受命令列參數覆寫
// ——保留期是治理層的設定，刻意不讓單次執行臨時改動。
// 用法：pnpm --filter server staging-sync:prune
import { fileURLToPath } from "node:url";

import { pruneStagingSyncRuns } from "../staging-sync/pruner";

export interface RunStagingSyncPruneResult {
  exitCode: 0;
  summary: Awaited<ReturnType<typeof pruneStagingSyncRuns>>;
}

/**
 * 核心函式：跑一次清理。抽出來方便單元測試直接呼叫。
 */
export async function runStagingSyncPrune(): Promise<RunStagingSyncPruneResult> {
  const summary = await pruneStagingSyncRuns();
  return { exitCode: 0, summary };
}

async function main(): Promise<void> {
  const result = await runStagingSyncPrune();
  console.log(JSON.stringify(result.summary));
  process.exitCode = result.exitCode;
}

// 只有直接執行本檔（tsx src/scripts/staging-sync-prune.ts）才跑 main，
// 被測試檔 import 時不觸發（避免單元測試連到 DB）。
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  void main();
}
