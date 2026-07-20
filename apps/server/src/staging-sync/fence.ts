import type { SyncRunPhase } from "./constants";

// fencing 憑證：全程隨 sync_runs 狀態轉移一起傳遞（見設計簡報 §13 教學重點 3）。
//
// 為什麼光有 advisory lock 還不夠：advisory lock 綁定在 PostgreSQL session 上，
// session 斷線（worker crash、連線被砍）鎖會自動釋放，但舊 worker 的程序可能還
// 活著、還在往下執行、繼續對 sync_runs／staging 表寫入（stale writer）。
// owner_token（每一輪換發的識別碼）＋ lease_version（每次狀態轉移遞增的版本號）
// 就是用來擋下這種 stale writer：每一次狀態轉移都必須「連同上一輪拿到的憑證」
// 一起送出，資料庫端用 `WHERE id AND phase AND owner_token AND lease_version`
// 做 CAS（compare-and-swap），憑證對不上就直接拒絕（見 run-manager.ts 的
// FenceLostError）。
export interface SyncRunFence {
  // sync_runs.id
  runId: number;
  // 呼叫端「預期」目前所在的 phase（用於檢查，不驅動狀態機本身）
  phase: SyncRunPhase;
  // 目前這一輪的 owner_token（uuid）
  ownerToken: string;
  // 目前這一輪的 lease_version
  leaseVersion: number;
}
