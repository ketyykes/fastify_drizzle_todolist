import { useCallback, useEffect, useState } from "react";

import { getErrorMessage } from "@/lib/errors";
import {
  abandonStagingSyncRun,
  fetchStagingSyncCatalog,
  fetchStagingSyncRuns,
  resetMockSource,
  setMockSourceMode,
  triggerStagingSync,
  type MockSourceMode,
  type SyncRunListItem,
  type TemplateCatalog,
  type TriggerSyncResult,
} from "@/lib/staging-sync-api";

const DEFAULT_POLL_INTERVAL_MS = 4000;
const DEFAULT_RUNS_LIMIT = 20;

export interface UseStagingSyncGuideResult {
  runs: SyncRunListItem[];
  runsLoading: boolean;
  runsError: string | null;
  refetchRuns: () => Promise<void>;

  catalog: TemplateCatalog | null;
  catalogLoading: boolean;
  catalogError: string | null;
  refetchCatalog: () => Promise<void>;

  mode: MockSourceMode | null;
  switchMode: (mode: MockSourceMode) => Promise<void>;
  switchingMode: boolean;
  resetMock: () => Promise<void>;
  resettingMock: boolean;

  triggerSync: () => Promise<TriggerSyncResult>;
  triggering: boolean;

  abandonRun: (runId: number, reason: string) => Promise<void>;
  abandoningRunId: number | null;
}

/**
 * Staging Sync 教學頁「即時演示區」的資料與操作邏輯：輪詢 runs 列表、手動／
 * 觸發後刷新目前生效目錄、切換或重置 mock 範本庫模式、觸發同步、放棄 staged
 * 執行。
 *
 * API 呼叫皆委派給 `@/lib/staging-sync-api`；操作方法（switchMode／resetMock／
 * triggerSync／abandonRun）失敗時往外拋出，由呼叫端（頁面）沿用專案既有
 * try/catch + sonner toast 慣例呈現錯誤，此 hook 只負責狀態管理。
 */
export function useStagingSyncGuide(
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  runsLimit: number = DEFAULT_RUNS_LIMIT,
): UseStagingSyncGuideResult {
  const [runs, setRuns] = useState<SyncRunListItem[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<TemplateCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // mock 範本庫沒有「讀取目前模式」的 GET 端點，初始狀態一律未知（null），
  // 只在切換／重置成功後才知道目前值（見 lib/staging-sync-api.ts 註解）。
  const [mode, setMode] = useState<MockSourceMode | null>(null);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [resettingMock, setResettingMock] = useState(false);

  const [triggering, setTriggering] = useState(false);
  const [abandoningRunId, setAbandoningRunId] = useState<number | null>(null);

  const refetchRuns = useCallback(async () => {
    try {
      const data = await fetchStagingSyncRuns(runsLimit);
      setRuns(data);
      setRunsError(null);
    } catch (err) {
      setRunsError(getErrorMessage(err));
    } finally {
      setRunsLoading(false);
    }
  }, [runsLimit]);

  const refetchCatalog = useCallback(async () => {
    try {
      const data = await fetchStagingSyncCatalog();
      setCatalog(data);
      setCatalogError(null);
    } catch (err) {
      setCatalogError(getErrorMessage(err));
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  // 輪詢 runs 列表
  useEffect(() => {
    void refetchRuns();
    const timer = setInterval(() => {
      void refetchRuns();
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [refetchRuns, pollIntervalMs]);

  // 目錄採手動／觸發後刷新為主，但頁面掛載時先讀一次讓卡片有初始內容
  useEffect(() => {
    void refetchCatalog();
  }, [refetchCatalog]);

  const switchMode = useCallback(async (nextMode: MockSourceMode) => {
    setSwitchingMode(true);
    try {
      const result = await setMockSourceMode(nextMode);
      setMode(result.mode);
    } finally {
      setSwitchingMode(false);
    }
  }, []);

  const resetMock = useCallback(async () => {
    setResettingMock(true);
    try {
      await resetMockSource();
      // resetMockSourceState() 固定把模式重置回 success（見後端 mock-source.ts）
      setMode("success");
    } finally {
      setResettingMock(false);
    }
  }, []);

  const triggerSync = useCallback(async () => {
    setTriggering(true);
    try {
      const result = await triggerStagingSync();
      await refetchRuns();
      // 只有真的切換成功（result=success）目錄才會變，no_data／其他結果不必重讀
      if (result.resultCode === "success") {
        await refetchCatalog();
      }
      return result;
    } finally {
      setTriggering(false);
    }
  }, [refetchRuns, refetchCatalog]);

  const abandonRun = useCallback(
    async (runId: number, reason: string) => {
      setAbandoningRunId(runId);
      try {
        await abandonStagingSyncRun(runId, reason);
        await refetchRuns();
      } finally {
        setAbandoningRunId(null);
      }
    },
    [refetchRuns],
  );

  return {
    runs,
    runsLoading,
    runsError,
    refetchRuns,
    catalog,
    catalogLoading,
    catalogError,
    refetchCatalog,
    mode,
    switchMode,
    switchingMode,
    resetMock,
    resettingMock,
    triggerSync,
    triggering,
    abandonRun,
    abandoningRunId,
  };
}
