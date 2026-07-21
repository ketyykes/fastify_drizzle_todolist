// 維運指令：列出 staging-sync 最近 N 筆 sync_runs（依 id desc）。
// --limit=N（預設 20，上限 100；同 routes/staging-sync-admin.ts 的上限規則）。
// 恆 exit 0（查詢／參數成功時皆然）；只有解析參數失敗或查詢本身出錯才 exit 1。
// 用法：pnpm --filter server staging-sync:status [--limit=20]
import { fileURLToPath } from "node:url";

import { db, syncRuns } from "@fastify_drizzle_todolist/db";
import { desc } from "drizzle-orm";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export type ParseStatusArgsResult = { ok: true; limit: number } | { ok: false; error: string };

/**
 * 解析 --limit=N 參數。純函式，方便單元測試邊界情況（比照 outbox-prune.ts 的
 * parsePruneArgs）。
 */
export function parseStatusArgs(argv: string[]): ParseStatusArgsResult {
  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  if (!limitArg) {
    return { ok: true, limit: DEFAULT_LIMIT };
  }

  const raw = limitArg.slice("--limit=".length).trim();
  if (!/^\d+$/.test(raw)) {
    return { ok: false, error: `--limit 必須是正整數，收到：「${raw}」` };
  }

  const limit = Number(raw);
  if (limit < 1) {
    return { ok: false, error: `--limit 必須 >= 1，收到：${limit}` };
  }

  return { ok: true, limit: Math.min(limit, MAX_LIMIT) };
}

type SyncRunRow = typeof syncRuns.$inferSelect;

/**
 * 把 sync_runs 的一列轉成對外輸出的形狀：逐欄位列舉，刻意不整列 spread——
 * owner_token 絕不能出現在輸出（同 routes/staging-sync-admin.ts 的同名 helper，
 * 各自獨立一份）。
 */
function toRunView(run: SyncRunRow) {
  return {
    id: run.id,
    syncType: run.syncType,
    phase: run.phase,
    resultCode: run.resultCode,
    lastErrorPhase: run.lastErrorPhase,
    errorMessage: run.errorMessage,
    pageCount: run.pageCount,
    sourceCount: run.sourceCount,
    stagedCounts: run.stagedCounts,
    fetchSeconds: run.fetchSeconds !== null ? Number(run.fetchSeconds) : null,
    swapSeconds: run.swapSeconds !== null ? Number(run.swapSeconds) : null,
    swapAttempts: run.swapAttempts,
    leaseVersion: run.leaseVersion,
    lockBackendPid: run.lockBackendPid,
    startedAt: run.startedAt,
    stagedAt: run.stagedAt,
    finishedAt: run.finishedAt,
    abandonedBy: run.abandonedBy,
    abandonedReason: run.abandonedReason,
    abandonedAt: run.abandonedAt,
  };
}

export type RunStagingSyncStatusResult =
  { exitCode: 0; runs: ReturnType<typeof toRunView>[] } | { exitCode: 1; error: string };

/**
 * 核心函式：解析參數＋查詢＋組輸出。抽出來方便單元測試直接呼叫。
 */
export async function runStagingSyncStatus(argv: string[]): Promise<RunStagingSyncStatusResult> {
  const parsed = parseStatusArgs(argv);
  if (!parsed.ok) {
    return { exitCode: 1, error: parsed.error };
  }

  try {
    const rows = await db.select().from(syncRuns).orderBy(desc(syncRuns.id)).limit(parsed.limit);
    return { exitCode: 0, runs: rows.map(toRunView) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, error: `查詢 sync_runs 失敗：${message}` };
  }
}

async function main(): Promise<void> {
  const result = await runStagingSyncStatus(process.argv.slice(2));
  if (result.exitCode === 1) {
    console.error(`[staging-sync-status] ${result.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(result.runs));
  process.exitCode = 0;
}

// 只有直接執行本檔（tsx src/scripts/staging-sync-status.ts）才跑 main，
// 被測試檔 import 時不觸發（避免單元測試連到 DB）。
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  void main();
}
