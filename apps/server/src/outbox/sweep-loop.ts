// 可注入、可測試的輪詢迴圈：worker.ts 只做組裝（讀 env、接訊號），
// 「先跑一輪 → 固定間隔 tick → in-flight 防重疊」的邏輯集中於此純模組。

export interface SweepLoopOptions<T> {
  // 每一輪要執行的動作（例如 runSweepOnce）
  sweep: () => Promise<T>;
  // tick 間隔（毫秒）
  intervalMs: number;
  // 一輪成功完成後的回呼（例如 log 計數）
  onResult?: (result: T) => void;
  // 上一輪尚未完成、本輪被跳過時的回呼（例如 log 警告）
  onSkip?: () => void;
}

export interface SweepLoop {
  // 立即先跑一輪，之後每 intervalMs 觸發一次 tick
  start: () => void;
  // 停止排程（不再觸發新的 tick），並等待目前正在跑的這一輪完成
  stop: () => Promise<void>;
}

/**
 * 建立輪詢迴圈。以固定間隔（setInterval）觸發 tick，而非「上一輪跑完再排下一輪」，
 * 因此需要 in-flight 旗標避免同一時間重疊執行兩輪 sweep：上一輪還沒完成時，
 * 新的 tick 會直接跳過（呼叫 onSkip），不會排隊等待。
 */
export function createSweepLoop<T>(options: SweepLoopOptions<T>): SweepLoop {
  const { sweep, intervalMs, onResult, onSkip } = options;

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let currentRun: Promise<void> = Promise.resolve();

  function tick(): void {
    if (inFlight) {
      onSkip?.();
      return;
    }

    inFlight = true;
    currentRun = sweep()
      .then((result) => {
        onResult?.(result);
      })
      .finally(() => {
        inFlight = false;
      });
  }

  function start(): void {
    if (timer !== null) {
      // 已啟動，重複呼叫不做任何事
      return;
    }
    tick(); // 啟動即先跑一輪
    timer = setInterval(tick, intervalMs);
  }

  async function stop(): Promise<void> {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    await currentRun;
  }

  return { start, stop };
}
