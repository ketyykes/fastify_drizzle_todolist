// 維運指令：清理保留天數外已完成（done）的 outbox 訊息。--days=30 預設 30 天，
// 小於 1 或非數字一律報錯退出。dead/pending/processing 一律保留（見 repository.pruneDone）。
// 用法：pnpm --filter server outbox:prune [--days=30]

import { fileURLToPath } from "node:url";

import { pruneDone } from "../outbox/repository";

export type ParsePruneArgsResult = { ok: true; days: number } | { ok: false; error: string };

const DEFAULT_RETENTION_DAYS = 30;

/**
 * 解析 --days=N 參數。純函式，方便單元測試邊界情況。
 */
export function parsePruneArgs(argv: string[]): ParsePruneArgsResult {
  const daysArg = argv.find((arg) => arg.startsWith("--days="));
  if (!daysArg) {
    return { ok: true, days: DEFAULT_RETENTION_DAYS };
  }

  const raw = daysArg.slice("--days=".length).trim();
  if (!/^\d+$/.test(raw)) {
    return { ok: false, error: `--days 必須是正整數，收到：「${raw}」` };
  }

  const days = Number(raw);
  if (days < 1) {
    return { ok: false, error: `--days 必須 >= 1，收到：${days}` };
  }

  return { ok: true, days };
}

async function main(): Promise<void> {
  const parsed = parsePruneArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`[outbox-prune] ${parsed.error}`);
    process.exitCode = 1;
    return;
  }

  const pruned = await pruneDone(parsed.days);
  console.log(`[outbox-prune] 已刪除 ${pruned} 筆超過 ${parsed.days} 天的 done 訊息`);
}

// 只有直接執行本檔（tsx src/scripts/outbox-prune.ts）才跑 main，
// 被測試檔 import 時不觸發（避免單元測試連到 DB）。
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  void main();
}
