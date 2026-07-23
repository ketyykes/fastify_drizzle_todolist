import { describe, expect, it } from "vitest";

import { getErrorMessage } from "./errors";

/**
 * 建立一個符合 `axios.isAxiosError()` 判斷式的假錯誤物件。
 * axios.isAxiosError 只檢查 `isAxiosError === true`（見 axios 原始碼），
 * 不需要真的建立 AxiosError 實例。
 */
function fakeAxiosError(options: {
  status?: number;
  data?: { error?: string };
  message?: string;
}) {
  return {
    isAxiosError: true,
    message: options.message ?? "Request failed",
    response:
      options.status === undefined
        ? undefined
        : {
            status: options.status,
            data: options.data,
          },
  };
}

describe("getErrorMessage", () => {
  it("409_with_data_error_returns_backend_message", () => {
    // 情境：staging-sync 觸發同步遇鎖衝突，後端回 409 + 有意義的中文訊息
    const err = fakeAxiosError({
      status: 409,
      data: { error: "sync_type=template_catalog 的 advisory lock 目前被其他流程持有" },
    });

    expect(getErrorMessage(err)).toBe(
      "sync_type=template_catalog 的 advisory lock 目前被其他流程持有",
    );
  });

  it("409_without_data_error_falls_back_to_err_message", () => {
    const err = fakeAxiosError({ status: 409, data: undefined, message: "Conflict" });

    expect(getErrorMessage(err)).toBe("Conflict");
  });

  it("401_always_returns_fixed_chinese_message_regardless_of_data_error", () => {
    // 既有行為不變：401 一律顯示固定文案，不受後端 body 影響
    const err = fakeAxiosError({ status: 401, data: { error: "Invalid credentials" } });

    expect(getErrorMessage(err)).toBe("Email 或密碼錯誤");
  });

  it("other_status_with_data_error_returns_backend_message", () => {
    const err = fakeAxiosError({ status: 500, data: { error: "Failed to create user" } });

    expect(getErrorMessage(err)).toBe("Failed to create user");
  });

  it("other_status_without_data_error_falls_back_to_err_message", () => {
    const err = fakeAxiosError({ status: 500, data: undefined, message: "Internal Server Error" });

    expect(getErrorMessage(err)).toBe("Internal Server Error");
  });

  it("axios_error_without_response_falls_back_to_err_message", () => {
    // 例如網路中斷，axios 錯誤沒有 response
    const err = fakeAxiosError({ message: "Network Error" });

    expect(getErrorMessage(err)).toBe("Network Error");
  });

  it("plain_error_returns_its_message", () => {
    expect(getErrorMessage(new Error("此 Email 已被註冊"))).toBe("此 Email 已被註冊");
  });

  it("unknown_value_returns_generic_message", () => {
    expect(getErrorMessage("some string")).toBe("發生未知錯誤");
    expect(getErrorMessage(undefined)).toBe("發生未知錯誤");
  });
});
