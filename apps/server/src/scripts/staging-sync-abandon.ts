// 維運指令：人工放棄一個卡在 staged 的 sync_runs（例如確認資料有問題、
// 不想讓它被下次 dispatch 重播 swap）。<runId> 與 --reason= 皆為必填，
// 避免打錯字或漏帶原因就誤觸放棄。
// 用法：pnpm --filter server staging-sync:abandon <runId> --reason="原因"
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";

import { syncRuns } from "@fastify_drizzle_todolist/db";

import { abandon } from "../staging-sync/run-manager";

export type ParseAbandonArgsResult =
  { ok: true; runId: number; reason: string } | { ok: false; error: string };

/**
 * 解析 `<runId> --reason=...`。純函式，方便單元測試邊界情況。
 */
export function parseAbandonArgs(argv: string[]): ParseAbandonArgsResult {
  const reasonArg = argv.find((arg) => arg.startsWith("--reason="));
  const positional = argv.find((arg) => !arg.startsWith("--"));

  if (!positional) {
    return { ok: false, error: "缺少必填參數 <runId>" };
  }
  if (!/^\d+$/.test(positional)) {
    return { ok: false, error: `<runId> 必須是正整數，收到：「${positional}」` };
  }
  const runId = Number(positional);
  if (runId < 1) {
    return { ok: false, error: `<runId> 必須 >= 1，收到：${runId}` };
  }

  if (!reasonArg) {
    return { ok: false, error: "缺少必填參數 --reason" };
  }
  const reason = reasonArg.slice("--reason=".length).trim();
  if (reason === "") {
    return { ok: false, error: "--reason 不可為空值" };
  }

  return { ok: true, runId, reason };
}

type SyncRunRow = typeof syncRuns.$inferSelect;

/**
 * 把 sync_runs 的一列轉成對外輸出的形狀（同 routes/staging-sync-admin.ts 的
 * 同名 helper，各自獨立一份，owner_token 絕不外洩）。
 */
function toRunView(run: SyncRunRow) {
  return {
    id: run.id,
    syncType: run.syncType,
    phase: run.phase,
    resultCode: run.resultCode,
    abandonedBy: run.abandonedBy,
    abandonedReason: run.abandonedReason,
    abandonedAt: run.abandonedAt,
    finishedAt: run.finishedAt,
  };
}

export type RunStagingSyncAbandonResult =
  { exitCode: 0; run: ReturnType<typeof toRunView> } | { exitCode: 1; error: string };

/**
 * 核心函式：解析參數＋呼叫 abandon＋組輸出。抽出來方便單元測試直接呼叫。
 * operator 用「cli:<OS 使用者名稱>」標記來源是人工 CLI 操作（區別於 admin
 * 路由用登入者 email）。
 */
export async function runStagingSyncAbandon(argv: string[]): Promise<RunStagingSyncAbandonResult> {
  const parsed = parseAbandonArgs(argv);
  if (!parsed.ok) {
    return { exitCode: 1, error: parsed.error };
  }

  const operator = `cli:${userInfo().username}`;
  const updated = await abandon(parsed.runId, parsed.reason, operator);
  if (!updated) {
    return {
      exitCode: 1,
      error: `run ${parsed.runId} 不存在或不是 staged 狀態，無法放棄`,
    };
  }

  return { exitCode: 0, run: toRunView(updated) };
}

async function main(): Promise<void> {
  const result = await runStagingSyncAbandon(process.argv.slice(2));
  if (result.exitCode === 1) {
    console.error(`[staging-sync-abandon] ${result.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(result.run));
  process.exitCode = 0;
}

// 只有直接執行本檔（tsx src/scripts/staging-sync-abandon.ts）才跑 main，
// 被測試檔 import 時不觸發（避免單元測試連到 DB）。
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  void main();
}
