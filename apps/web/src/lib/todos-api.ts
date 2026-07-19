import { httpClient } from "./http-client";

export interface Todo {
  id: number;
  userId: number;
  title: string;
  completed: boolean;
  createdAt: string;
}

export async function fetchTodos(): Promise<Todo[]> {
  const { data } = await httpClient.get<Todo[]>("/todos");
  return data;
}

export async function createTodo(title: string): Promise<Todo> {
  const { data } = await httpClient.post<Todo>("/todos", { title });
  return data;
}

export async function updateTodo(
  id: number,
  patch: { title?: string; completed?: boolean },
): Promise<Todo> {
  const { data } = await httpClient.patch<Todo>(`/todos/${id}`, patch);
  return data;
}

export async function deleteTodo(id: number): Promise<void> {
  await httpClient.delete(`/todos/${id}`);
}
