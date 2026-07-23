import axios from "axios";

/**
 * 從 axios 錯誤或一般錯誤取出可顯示的訊息。
 *
 * 409 不在此處寫死文案：此 helper 是全站共用的，同樣的 409 狀態碼在不同情境
 * 語意完全不同（例如 staging-sync 觸發同步遇鎖衝突、註冊撞 Email），一律顯示
 * 同一句「此 Email 已被註冊」會誤導其他呼叫端。優先信任後端 body 的
 * `data.error`，只有在該狀態碼沒有 `data.error` 時才 fallback。若某個呼叫端
 * 需要把特定狀態碼轉譯成更友善的文案（如註冊撞 Email），應在該呼叫端自行處理
 * （見 `auth-api.ts` 的 `registerRequest`），而不是加回這個共用 helper。
 */
export function getErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined;
    // 401（帳密錯誤）沿用固定文案：不洩漏後端訊息細節，維持既有行為不變
    if (err.response?.status === 401) {
      return "Email 或密碼錯誤";
    }
    if (data?.error) {
      return data.error;
    }
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "發生未知錯誤";
}
