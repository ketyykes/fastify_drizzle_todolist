import { useAtom } from "jotai";
import { useNavigate } from "react-router";

import { tokenAtom } from "@/lib/auth";
import { loginRequest, registerRequest } from "@/lib/auth-api";

/**
 * 認證操作 hook：登入／註冊成功後存 token 並導向 /todos；登出清 token 並導回 /login。
 */
export function useAuth() {
  const [token, setToken] = useAtom(tokenAtom);
  const navigate = useNavigate();

  async function login(email: string, password: string) {
    const nextToken = await loginRequest(email, password);
    setToken(nextToken);
    navigate("/todos");
  }

  async function register(email: string, password: string) {
    const nextToken = await registerRequest(email, password);
    setToken(nextToken);
    navigate("/todos");
  }

  function logout() {
    setToken(null);
    navigate("/login");
  }

  return {
    token,
    isAuthenticated: token !== null,
    login,
    register,
    logout,
  };
}
