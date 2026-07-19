import { env } from "@fastify_drizzle_todolist/env/web";
import axios from "axios";

const serverBaseURL = env.VITE_SERVER_URL;

export function createHttpClient(baseURL = serverBaseURL) {
  return axios.create({
    baseURL,
    headers: { "Content-Type": "application/json" },
    timeout: 10_000,
  });
}

export const httpClient = createHttpClient();
