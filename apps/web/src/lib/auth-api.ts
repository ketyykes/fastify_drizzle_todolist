import axios from "axios";

import { httpClient } from "./http-client";

interface TokenResponse {
  token: string;
}

export async function loginRequest(email: string, password: string): Promise<string> {
  const { data } = await httpClient.post<TokenResponse>("/auth/login", {
    email,
    password,
  });
  return data.token;
}

export async function registerRequest(email: string, password: string): Promise<string> {
  try {
    const { data } = await httpClient.post<TokenResponse>("/auth/register", {
      email,
      password,
    });
    return data.token;
  } catch (err) {
    // 後端 409 body 是英文訊息「Email already registered」，直接顯示對註冊 UX
    // 是退步；此處只在註冊流程把它轉譯成清楚的中文文案，不動全站共用的
    // getErrorMessage（見該檔註解），避免影響其他呼叫端（如 staging-sync 的
    // 鎖衝突 409）。
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      throw new Error("此 Email 已被註冊", { cause: err });
    }
    throw err;
  }
}
