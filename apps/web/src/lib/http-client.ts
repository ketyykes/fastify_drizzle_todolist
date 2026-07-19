import { env } from "@fastify_drizzle_todolist/env/web";
import axios from "axios";

import { clearStoredToken, getStoredToken } from "./auth";

const serverBaseURL = env.VITE_SERVER_URL;

export function createHttpClient(baseURL = serverBaseURL) {
  return axios.create({
    baseURL,
    headers: { "Content-Type": "application/json" },
    timeout: 10_000,
  });
}

export const httpClient = createHttpClient();

// 每個請求自動附上 Bearer token
httpClient.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// token 失效（401）時清除並導回登入頁
httpClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      clearStoredToken();
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  },
);
