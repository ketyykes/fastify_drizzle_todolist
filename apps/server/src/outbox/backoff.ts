// 退避查表（非公式）：第 1~4 次失敗後分別等 1 / 5 / 15 / 60 分鐘，第 5 次起封頂 360 分鐘。
const BACKOFF_TABLE_MINUTES: Record<number, number> = {
  1: 1,
  2: 5,
  3: 15,
  4: 60,
};

const MAX_BACKOFF_MINUTES = 360;

/**
 * 依失敗次數（第幾次失敗，非索引）計算下次可重送時間。純函式，無 jitter。
 *
 * @param attempts 累計失敗次數（第 1 次失敗傳 1，以此類推）
 * @param now 計算基準時間
 */
export function computeNextAttemptAt(attempts: number, now: Date): Date {
  const minutes = BACKOFF_TABLE_MINUTES[attempts] ?? MAX_BACKOFF_MINUTES;
  return new Date(now.getTime() + minutes * 60_000);
}
