// 維運指令：手動觸發一次「範本目錄」全量同步。
// exit code 契約（教學重點：排程不得把 no_data 當成功寫「同步完成」）：
//   0 = success（真的同步到資料）
//   2 = no_data（來源目前 0 筆，流程本身正常結束，但**不是**「同步完成」）
//   1 = 其他（鎖衝突／來源故障／swap 失敗……），stderr 印消毒過的錯誤訊息
// 用法：pnpm --filter server staging-sync:run
import { fileURLToPath } from "node:url";

import { RESULT_CODE } from "../staging-sync/constants";
import { runTemplateCatalogSync, type SyncRunSummary } from "../staging-sync/dispatcher";

export type RunStagingSyncResult =
  | { exitCode: 0; summary: SyncRunSummary }
  | { exitCode: 2; summary: SyncRunSummary }
  | { exitCode: 1; error: string };

/**
 * 消毒錯誤訊息：只保留「錯誤類別名: 訊息前 300 字」（見設計簡報 §6，與
 * routes/staging-sync-admin.ts 的同名 helper 用途一致，各自獨立一份）。
 */
function sanitizeErrorMessage(error: unknown): string {
  const className = error instanceof Error ? error.constructor.name : typeof error;
  const rawMessage = error instanceof Error ? error.message : String(error);
  return `${className}: ${rawMessage.slice(0, 300)}`;
}

/**
 * 核心函式：跑一次同步並依結果決定 exit code。抽出來方便單元測試直接呼叫，
 * 不必透過 spawn 子行程。
 */
export async function runStagingSyncOnce(): Promise<RunStagingSyncResult> {
  try {
    const summary = await runTemplateCatalogSync();
    if (summary.resultCode === RESULT_CODE.NO_DATA) {
      return { exitCode: 2, summary };
    }
    return { exitCode: 0, summary };
  } catch (error) {
    return { exitCode: 1, error: sanitizeErrorMessage(error) };
  }
}

async function main(): Promise<void> {
  const result = await runStagingSyncOnce();

  if (result.exitCode === 1) {
    console.error(`[staging-sync-run] ${result.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(result.summary));
  if (result.exitCode === 2) {
    console.error("[staging-sync-run] 本輪來源 0 筆資料（no_data），視為非正常完成");
  }
  process.exitCode = result.exitCode;
}

// 只有直接執行本檔（tsx src/scripts/staging-sync-run.ts）才跑 main，
// 被測試檔 import 時不觸發（避免單元測試連到 DB／HTTP）。
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  void main();
}
