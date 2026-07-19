import axios from "axios";

/**
 * 從 axios 錯誤或一般錯誤取出可顯示的訊息。
 */
export function getErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined;
    if (err.response?.status === 401) {
      return "Email 或密碼錯誤";
    }
    if (err.response?.status === 409) {
      return "此 Email 已被註冊";
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
