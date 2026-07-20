import { BATCH_LIMIT } from "./constants";
import { getOutboxConfig } from "./config";
import { claimDueBatch, markDone, markFailed, recoverStaleProcessing } from "./repository";
import { sendOutboxMessage } from "./sender";

export interface SweepResult {
  // 卡住回收筆數
  recovered: number;
  // 本輪成功（含 ref 已刪 skipped）筆數
  done: number;
  // 本輪失敗但未達上限、退回 pending 筆數
  retried: number;
  // 本輪失敗且達上限、轉 dead 筆數
  dead: number;
}

/**
 * 跑一輪 sweep：卡住回收 → 認領到期批次 → 逐筆送出（交易外）。
 * 單筆處理若拋出非預期例外，只記錄警告並讓該列留在 processing
 * （交給下一輪卡住回收接手），不中斷整批其餘筆數的處理。
 */
export async function runSweepOnce(): Promise<SweepResult> {
  const recovered = await recoverStaleProcessing();
  const batch = await claimDueBatch(BATCH_LIMIT);
  const config = getOutboxConfig();

  let done = 0;
  let retried = 0;
  let dead = 0;

  for (const row of batch) {
    try {
      let sendError: unknown = null;
      try {
        await sendOutboxMessage(row, config);
      } catch (error) {
        sendError = error;
      }

      if (sendError === null) {
        await markDone(row.id);
        done += 1;
      } else {
        const message = sendError instanceof Error ? sendError.message : String(sendError);
        const outcome = await markFailed(row, message);
        if (outcome === "dead") {
          dead += 1;
        } else {
          retried += 1;
        }
      }
    } catch (unexpectedError) {
      // 單筆意外例外（例如 markDone/markFailed 本身失敗）：不中斷整批，
      // 該列留在 processing，交由下一輪卡住回收接手。
      console.warn(
        `[outbox] 處理 id=${row.id} 時發生非預期錯誤，該列留在 processing 待卡住回收接手`,
        unexpectedError,
      );
    }
  }

  return { recovered, done, retried, dead };
}
