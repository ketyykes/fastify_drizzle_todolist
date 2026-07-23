import { describe, expect, it, vi } from "vitest";

const postMock = vi.fn();

vi.mock("./http-client", () => ({
  httpClient: {
    post: (...args: unknown[]) => postMock(...args),
  },
}));

import { loginRequest, registerRequest } from "./auth-api";

function fakeAxiosError(status: number, data?: { error?: string }) {
  return {
    isAxiosError: true,
    message: "Request failed",
    response: { status, data },
  };
}

describe("registerRequest", () => {
  it("resolves_with_token_on_success", async () => {
    postMock.mockResolvedValue({ data: { token: "abc" } });

    const token = await registerRequest("a@example.com", "password123");

    expect(token).toBe("abc");
    expect(postMock).toHaveBeenCalledWith("/auth/register", {
      email: "a@example.com",
      password: "password123",
    });
  });

  it("translates_409_email_already_registered_to_chinese_message", async () => {
    // 後端 409 body 是英文「Email already registered」，註冊流程必須轉譯成
    // 清楚的中文文案，不能讓全站共用的 getErrorMessage 直接顯示英文原文。
    postMock.mockRejectedValue(fakeAxiosError(409, { error: "Email already registered" }));

    await expect(registerRequest("a@example.com", "password123")).rejects.toThrow(
      "此 Email 已被註冊",
    );
  });

  it("rethrows_original_error_for_other_status_codes", async () => {
    const original = fakeAxiosError(400, { error: "Invalid input" });
    postMock.mockRejectedValue(original);

    await expect(registerRequest("a@example.com", "password123")).rejects.toBe(original);
  });
});

describe("loginRequest", () => {
  it("resolves_with_token_on_success", async () => {
    postMock.mockResolvedValue({ data: { token: "xyz" } });

    const token = await loginRequest("a@example.com", "password123");

    expect(token).toBe("xyz");
  });

  it("rethrows_original_error_unchanged", async () => {
    // login 不做任何轉譯，401 沿用既有 getErrorMessage 的固定文案邏輯
    const original = fakeAxiosError(401, { error: "Invalid credentials" });
    postMock.mockRejectedValue(original);

    await expect(loginRequest("a@example.com", "password123")).rejects.toBe(original);
  });
});
