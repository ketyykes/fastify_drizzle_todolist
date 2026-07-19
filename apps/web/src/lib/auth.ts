import { atom } from "jotai";

export const TOKEN_STORAGE_KEY = "todo-app-token";

// 供 axios interceptor 等 React 外部直接讀寫 token（純字串，不經 JSON 包裝）
export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

// 以 localStorage 現值初始化，供 React 元件響應
const tokenBaseAtom = atom<string | null>(getStoredToken());

/**
 * token 讀寫 atom：寫入時同步更新 localStorage（null 代表登出）。
 */
export const tokenAtom = atom(
  (get) => get(tokenBaseAtom),
  (_get, set, next: string | null) => {
    set(tokenBaseAtom, next);
    if (next === null) {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } else {
      localStorage.setItem(TOKEN_STORAGE_KEY, next);
    }
  },
);

export const isAuthenticatedAtom = atom((get) => get(tokenAtom) !== null);
