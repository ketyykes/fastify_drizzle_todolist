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

export async function registerRequest(
  email: string,
  password: string,
): Promise<string> {
  const { data } = await httpClient.post<TokenResponse>("/auth/register", {
    email,
    password,
  });
  return data.token;
}
