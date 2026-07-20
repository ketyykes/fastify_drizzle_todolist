import { httpClient } from "./http-client";

// outbox 訊息狀態，對應後端 outbox_messages.status
export type OutboxStatus = "pending" | "processing" | "done" | "dead";

export interface OutboxMessage {
  id: number;
  topic: string;
  refId: number;
  action: string;
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxStats {
  counts: {
    pending: number;
    processing: number;
    done: number;
    dead: number;
  };
  recent: OutboxMessage[];
}

export interface SweepResult {
  recovered: number;
  done: number;
  retried: number;
  dead: number;
}

// mock 外部服務（無認證）的三種行為模式
export type MockExternalMode = "success" | "fail" | "timeout";

export interface MockExternalState {
  mode: MockExternalMode;
  received: unknown[];
}

export async function fetchOutboxStats(): Promise<OutboxStats> {
  const { data } = await httpClient.get<OutboxStats>("/outbox/stats");
  return data;
}

export async function sweepOutbox(): Promise<SweepResult> {
  const { data } = await httpClient.post<SweepResult>("/outbox/sweep");
  return data;
}

export async function requeueDeadOutbox(ids?: number[]): Promise<{ requeued: number }> {
  const { data } = await httpClient.post<{ requeued: number }>("/outbox/requeue-dead", {
    ids,
  });
  return data;
}

export async function fetchMockExternalState(): Promise<MockExternalState> {
  const { data } = await httpClient.get<MockExternalState>("/mock-external/notifications");
  return data;
}

export async function setMockExternalMode(
  mode: MockExternalMode,
): Promise<{ mode: MockExternalMode }> {
  const { data } = await httpClient.put<{ mode: MockExternalMode }>("/mock-external/mode", {
    mode,
  });
  return data;
}
