import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchOutboxStatsMock = vi.fn();
const fetchMockExternalStateMock = vi.fn();
const setMockExternalModeMock = vi.fn();
const sweepOutboxMock = vi.fn();
const requeueDeadOutboxMock = vi.fn();

vi.mock("@/lib/outbox-api", () => ({
  fetchOutboxStats: (...args: unknown[]) => fetchOutboxStatsMock(...args),
  fetchMockExternalState: (...args: unknown[]) => fetchMockExternalStateMock(...args),
  setMockExternalMode: (...args: unknown[]) => setMockExternalModeMock(...args),
  sweepOutbox: (...args: unknown[]) => sweepOutboxMock(...args),
  requeueDeadOutbox: (...args: unknown[]) => requeueDeadOutboxMock(...args),
}));

import { useOutboxStats } from "./use-outbox-stats";

const sampleStats = {
  counts: { pending: 1, processing: 0, done: 3, dead: 0 },
  recent: [],
};

describe("useOutboxStats", () => {
  beforeEach(() => {
    fetchOutboxStatsMock.mockReset();
    fetchMockExternalStateMock.mockReset();
    setMockExternalModeMock.mockReset();
    sweepOutboxMock.mockReset();
    requeueDeadOutboxMock.mockReset();
    fetchMockExternalStateMock.mockResolvedValue({ mode: "success", received: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads_stats_successfully", async () => {
    fetchOutboxStatsMock.mockResolvedValue(sampleStats);

    const { result } = renderHook(() => useOutboxStats());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.stats).toEqual(sampleStats);
    expect(result.current.error).toBeNull();
  });

  it("sets_error_on_fetch_failure", async () => {
    fetchOutboxStatsMock.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useOutboxStats());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("network down");
    expect(result.current.stats).toBeNull();
  });

  it("polls_on_interval_and_refetches", async () => {
    vi.useFakeTimers();
    fetchOutboxStatsMock.mockResolvedValue(sampleStats);

    renderHook(() => useOutboxStats(5000));

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchOutboxStatsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(fetchOutboxStatsMock).toHaveBeenCalledTimes(2);
  });

  it("switch_mode_calls_api_and_updates_state", async () => {
    fetchOutboxStatsMock.mockResolvedValue(sampleStats);
    setMockExternalModeMock.mockResolvedValue({ mode: "fail" });

    const { result } = renderHook(() => useOutboxStats());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.switchMode("fail");
    });

    expect(setMockExternalModeMock).toHaveBeenCalledWith("fail");
    expect(result.current.mode).toBe("fail");
  });

  it("sweep_calls_api_and_refetches_stats", async () => {
    fetchOutboxStatsMock.mockResolvedValue(sampleStats);
    sweepOutboxMock.mockResolvedValue({ recovered: 0, done: 1, retried: 0, dead: 0 });

    const { result } = renderHook(() => useOutboxStats());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let sweepResult;
    await act(async () => {
      sweepResult = await result.current.sweep();
    });

    expect(sweepOutboxMock).toHaveBeenCalledTimes(1);
    expect(sweepResult).toEqual({ recovered: 0, done: 1, retried: 0, dead: 0 });
    expect(fetchOutboxStatsMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("requeue_dead_calls_api_and_refetches_stats", async () => {
    fetchOutboxStatsMock.mockResolvedValue(sampleStats);
    requeueDeadOutboxMock.mockResolvedValue({ requeued: 2 });

    const { result } = renderHook(() => useOutboxStats());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let requeueResult;
    await act(async () => {
      requeueResult = await result.current.requeueDead();
    });

    expect(requeueDeadOutboxMock).toHaveBeenCalledTimes(1);
    expect(requeueResult).toEqual({ requeued: 2 });
    expect(fetchOutboxStatsMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
