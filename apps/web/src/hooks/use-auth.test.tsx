import { act, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigateMock = vi.fn();
vi.mock("react-router", () => ({ useNavigate: () => navigateMock }));

import { TOKEN_STORAGE_KEY, tokenAtom } from "../lib/auth";
import { useAuth } from "./use-auth";

describe("useAuth", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    localStorage.clear();
  });

  it("logout_clears_token_and_redirects", () => {
    const store = createStore();
    // 先進入已登入態
    store.set(tokenAtom, "fake-token");
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("fake-token");

    const wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });

    act(() => {
      result.current.logout();
    });

    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(store.get(tokenAtom)).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith("/login");
  });
});
