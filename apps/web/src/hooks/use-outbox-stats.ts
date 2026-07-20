import { useCallback, useEffect, useState } from "react";

import { getErrorMessage } from "@/lib/errors";
import {
  fetchMockExternalState,
  fetchOutboxStats,
  requeueDeadOutbox,
  setMockExternalMode,
  sweepOutbox,
  type MockExternalMode,
  type OutboxStats,
  type SweepResult,
} from "@/lib/outbox-api";

const DEFAULT_POLL_INTERVAL_MS = 4000;

export interface UseOutboxStatsResult {
  stats: OutboxStats | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  mode: MockExternalMode | null;
  modeLoading: boolean;
  switchMode: (mode: MockExternalMode) => Promise<void>;
  switchingMode: boolean;
  sweep: () => Promise<SweepResult>;
  sweeping: boolean;
  requeueDead: () => Promise<{ requeued: number }>;
  requeuingDead: boolean;
}

/**
 * Outbox 教學頁「即時演示區」的資料與操作邏輯：輪詢佇列統計、讀取／切換
 * mock 外部服務模式、手動 sweep、requeue dead。
 *
 * API 呼叫皆委派給 `@/lib/outbox-api`；操作方法（switchMode / sweep /
 * requeueDead）失敗時往外拋出，由呼叫端（頁面）沿用專案既有
 * try/catch + sonner toast 慣例呈現錯誤，此 hook 只負責狀態管理。
 */
export function useOutboxStats(
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): UseOutboxStatsResult {
  const [stats, setStats] = useState<OutboxStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<MockExternalMode | null>(null);
  const [modeLoading, setModeLoading] = useState(true);

  const [switchingMode, setSwitchingMode] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [requeuingDead, setRequeuingDead] = useState(false);

  const refetch = useCallback(async () => {
    try {
      const data = await fetchOutboxStats();
      setStats(data);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // 輪詢 outbox 統計
  useEffect(() => {
    void refetch();
    const timer = setInterval(() => {
      void refetch();
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [refetch, pollIntervalMs]);

  // 初始讀取一次 mock 外部服務目前模式（失敗不阻擋頁面，維持 null）
  useEffect(() => {
    let active = true;
    fetchMockExternalState()
      .then((state) => {
        if (active) setMode(state.mode);
      })
      .catch(() => {
        // 靜默失敗：畫面顯示「未知」即可，不影響其他區塊
      })
      .finally(() => {
        if (active) setModeLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const switchMode = useCallback(async (nextMode: MockExternalMode) => {
    setSwitchingMode(true);
    try {
      const result = await setMockExternalMode(nextMode);
      setMode(result.mode);
    } finally {
      setSwitchingMode(false);
    }
  }, []);

  const sweep = useCallback(async () => {
    setSweeping(true);
    try {
      const result = await sweepOutbox();
      await refetch();
      return result;
    } finally {
      setSweeping(false);
    }
  }, [refetch]);

  const requeueDead = useCallback(async () => {
    setRequeuingDead(true);
    try {
      const result = await requeueDeadOutbox();
      await refetch();
      return result;
    } finally {
      setRequeuingDead(false);
    }
  }, [refetch]);

  return {
    stats,
    loading,
    error,
    refetch,
    mode,
    modeLoading,
    switchMode,
    switchingMode,
    sweep,
    sweeping,
    requeueDead,
    requeuingDead,
  };
}
