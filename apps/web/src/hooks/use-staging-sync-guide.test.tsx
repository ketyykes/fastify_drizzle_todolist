import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchStagingSyncRunsMock = vi.fn();
const fetchStagingSyncCatalogMock = vi.fn();
const setMockSourceModeMock = vi.fn();
const resetMockSourceMock = vi.fn();
const triggerStagingSyncMock = vi.fn();
const abandonStagingSyncRunMock = vi.fn();

vi.mock("@/lib/staging-sync-api", () => ({
  fetchStagingSyncRuns: (...args: unknown[]) => fetchStagingSyncRunsMock(...args),
  fetchStagingSyncCatalog: (...args: unknown[]) => fetchStagingSyncCatalogMock(...args),
  setMockSourceMode: (...args: unknown[]) => setMockSourceModeMock(...args),
  resetMockSource: (...args: unknown[]) => resetMockSourceMock(...args),
  triggerStagingSync: (...args: unknown[]) => triggerStagingSyncMock(...args),
  abandonStagingSyncRun: (...args: unknown[]) => abandonStagingSyncRunMock(...args),
}));

import { useStagingSyncGuide } from "./use-staging-sync-guide";

const sampleRuns = [
  {
    id: 1,
    syncType: "template_catalog",
    phase: "done",
    leaseVersion: 1,
    lockBackendPid: null,
    heartbeatAt: null,
    lastOffset: 100,
    pageCount: 5,
    sourceCount: 100,
    stagedCounts: { lists: 5, items: 20, tags: 10 },
    peakMemoryBytes: 1024,
    fetchSeconds: "0.1234",
    swapSeconds: "0.0456",
    swapAttempts: 1,
    resultCode: "success",
    lastErrorPhase: null,
    errorMessage: null,
    abandonedBy: null,
    abandonedReason: null,
    abandonedAt: null,
    startedAt: "2026-07-20T00:00:00.000Z",
    stagedAt: "2026-07-20T00:00:01.000Z",
    finishedAt: "2026-07-20T00:00:02.000Z",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:02.000Z",
  },
];

const sampleCatalog = { lists: [] };

describe("useStagingSyncGuide", () => {
  beforeEach(() => {
    fetchStagingSyncRunsMock.mockReset();
    fetchStagingSyncCatalogMock.mockReset();
    setMockSourceModeMock.mockReset();
    resetMockSourceMock.mockReset();
    triggerStagingSyncMock.mockReset();
    abandonStagingSyncRunMock.mockReset();
    fetchStagingSyncCatalogMock.mockResolvedValue(sampleCatalog);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads_runs_successfully", async () => {
    fetchStagingSyncRunsMock.mockResolvedValue(sampleRuns);

    const { result } = renderHook(() => useStagingSyncGuide());

    await waitFor(() => expect(result.current.runsLoading).toBe(false));

    expect(result.current.runs).toEqual(sampleRuns);
    expect(result.current.runsError).toBeNull();
  });

  it("sets_error_on_runs_fetch_failure", async () => {
    fetchStagingSyncRunsMock.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useStagingSyncGuide());

    await waitFor(() => expect(result.current.runsLoading).toBe(false));

    expect(result.current.runsError).toBe("network down");
    expect(result.current.runs).toEqual([]);
  });

  it("polls_runs_on_interval_and_refetches", async () => {
    vi.useFakeTimers();
    fetchStagingSyncRunsMock.mockResolvedValue(sampleRuns);

    renderHook(() => useStagingSyncGuide(5000));

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchStagingSyncRunsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(fetchStagingSyncRunsMock).toHaveBeenCalledTimes(2);
  });

  it("loads_catalog_on_mount", async () => {
    fetchStagingSyncRunsMock.mockResolvedValue([]);
    fetchStagingSyncCatalogMock.mockResolvedValue({ lists: [{ sourceListId: 1000 }] });

    const { result } = renderHook(() => useStagingSyncGuide());

    await waitFor(() => expect(result.current.catalogLoading).toBe(false));

    expect(result.current.catalog).toEqual({ lists: [{ sourceListId: 1000 }] });
  });

  it("switch_mode_calls_api_and_updates_state", async () => {
    fetchStagingSyncRunsMock.mockResolvedValue([]);
    setMockSourceModeMock.mockResolvedValue({ mode: "fail" });

    const { result } = renderHook(() => useStagingSyncGuide());
    await waitFor(() => expect(result.current.runsLoading).toBe(false));

    await act(async () => {
      await result.current.switchMode("fail");
    });

    expect(setMockSourceModeMock).toHaveBeenCalledWith("fail");
    expect(result.current.mode).toBe("fail");
  });

  it("reset_mock_calls_api_and_sets_mode_to_success", async () => {
    fetchStagingSyncRunsMock.mockResolvedValue([]);
    resetMockSourceMock.mockResolvedValue({ ok: true });

    const { result } = renderHook(() => useStagingSyncGuide());
    await waitFor(() => expect(result.current.runsLoading).toBe(false));

    await act(async () => {
      await result.current.resetMock();
    });

    expect(resetMockSourceMock).toHaveBeenCalledTimes(1);
    expect(result.current.mode).toBe("success");
  });

  it("trigger_sync_refetches_runs_and_catalog_on_success", async () => {
    fetchStagingSyncRunsMock.mockResolvedValue(sampleRuns);
    triggerStagingSyncMock.mockResolvedValue({
      runId: 1,
      resultCode: "success",
      replayed: false,
      pageCount: 5,
      sourceCount: 100,
      stagedCounts: { lists: 5, items: 20, tags: 10 },
      fetchSeconds: 0.1234,
      swapSeconds: 0.0456,
    });

    const { result } = renderHook(() => useStagingSyncGuide());
    await waitFor(() => expect(result.current.runsLoading).toBe(false));
    await waitFor(() => expect(result.current.catalogLoading).toBe(false));

    fetchStagingSyncRunsMock.mockClear();
    fetchStagingSyncCatalogMock.mockClear();

    let triggerResult;
    await act(async () => {
      triggerResult = await result.current.triggerSync();
    });

    expect(triggerStagingSyncMock).toHaveBeenCalledTimes(1);
    expect(triggerResult).toMatchObject({ resultCode: "success" });
    expect(fetchStagingSyncRunsMock).toHaveBeenCalledTimes(1);
    expect(fetchStagingSyncCatalogMock).toHaveBeenCalledTimes(1);
  });

  it("trigger_sync_skips_catalog_refetch_when_no_data", async () => {
    fetchStagingSyncRunsMock.mockResolvedValue([]);
    triggerStagingSyncMock.mockResolvedValue({
      runId: 2,
      resultCode: "no_data",
      replayed: false,
      pageCount: 0,
      sourceCount: 0,
      stagedCounts: null,
      fetchSeconds: 0.01,
      swapSeconds: null,
    });

    const { result } = renderHook(() => useStagingSyncGuide());
    await waitFor(() => expect(result.current.runsLoading).toBe(false));
    await waitFor(() => expect(result.current.catalogLoading).toBe(false));

    fetchStagingSyncCatalogMock.mockClear();

    await act(async () => {
      await result.current.triggerSync();
    });

    expect(fetchStagingSyncCatalogMock).not.toHaveBeenCalled();
  });

  it("abandon_run_calls_api_and_refetches_runs", async () => {
    fetchStagingSyncRunsMock.mockResolvedValue(sampleRuns);
    abandonStagingSyncRunMock.mockResolvedValue({ ...sampleRuns[0], phase: "abandoned" });

    const { result } = renderHook(() => useStagingSyncGuide());
    await waitFor(() => expect(result.current.runsLoading).toBe(false));

    fetchStagingSyncRunsMock.mockClear();

    await act(async () => {
      await result.current.abandonRun(1, "手動測試放棄");
    });

    expect(abandonStagingSyncRunMock).toHaveBeenCalledWith(1, "手動測試放棄");
    expect(fetchStagingSyncRunsMock).toHaveBeenCalledTimes(1);
    expect(result.current.abandoningRunId).toBeNull();
  });
});
