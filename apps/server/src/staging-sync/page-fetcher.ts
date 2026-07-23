import type { StagingSyncConfig } from "./config";
import { SourceFetchError } from "./errors";
import type { SourceListRow, SourcePage } from "./types";

// page-fetcher：Phase 1（逐頁抓取）唯一與外部來源互動的模組。
//
// 核心紀律（呼應設計簡報「分批的是記憶體，不是 commit」）：一次只抓一頁、yield 出去
// 之後本函式不再保留任何參照——呼叫端（orchestrator.ts）處理完一頁就該讓它被回收，
// 絕不能把所有頁的 rows 累積在陣列裡，否則又走回「全載入記憶體」的老路。

// 來源 API 回傳的原始分頁形狀（rows 的型別見 SourceListRow）
interface SourceCatalogPageResponse {
  rows: SourceListRow[];
  count: number;
}

export interface StreamCatalogPagesOptions {
  // 可注入的等待函式，供測試略過真實的重試等待時間；預設用真的 setTimeout。
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 組出單頁請求的完整 URL：以 `new URL(config.sourceUrl)` 為基底，保留其**既有**
 * query string（例如測試會在 sourceUrl 帶 `?overlap=1`），只覆寫 limit／offset。
 */
function buildPageUrl(sourceUrl: string, offset: number, pageSize: number): URL {
  const url = new URL(sourceUrl);
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("offset", String(offset));
  return url;
}

/**
 * 抓取單一分頁，內建重試：只重試「fetch 拋例外的網路錯誤」與「5xx」；
 * 4xx 一律視為呼叫端輸入錯誤，不重試、直接失敗。重試耗盡（或 4xx）一律
 * 轉譯成 SourceFetchError，帶上 pageIndex／status 供上層判斷與記錄。
 */
async function fetchPageWithRetry(
  config: StagingSyncConfig,
  pageIndex: number,
  offset: number,
  sleep: (ms: number) => Promise<void>,
): Promise<SourceListRow[]> {
  // fetchRetries 是「不含第一次嘗試」的重試次數（見 config.ts 註解），
  // 故總嘗試次數為 fetchRetries + 1。
  const maxAttempts = config.fetchRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const url = buildPageUrl(config.sourceUrl, offset, config.pageSize);
    const isLastAttempt = attempt === maxAttempts;

    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(config.fetchTimeoutMs) });
    } catch (error) {
      // fetch 本身拋例外＝網路層錯誤（連線失敗、逾時……），屬於可重試類別。
      if (!isLastAttempt) {
        await sleep(config.fetchRetryDelayMs);
        continue;
      }
      throw new SourceFetchError({
        pageIndex,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (response.ok) {
      const body = (await response.json()) as SourceCatalogPageResponse;
      return body.rows;
    }

    if (response.status >= 500) {
      // 5xx：伺服器端暫時性錯誤，可重試。
      if (!isLastAttempt) {
        await sleep(config.fetchRetryDelayMs);
        continue;
      }
      throw new SourceFetchError({
        pageIndex,
        status: response.status,
        message: `HTTP ${response.status}：重試 ${config.fetchRetries} 次後仍失敗`,
      });
    }

    // 4xx：視為呼叫端輸入錯誤（例如非法查詢參數），重試也不會成功，直接失敗。
    throw new SourceFetchError({
      pageIndex,
      status: response.status,
      message: `HTTP ${response.status}：用戶端錯誤，不重試`,
    });
  }

  // 理論上不會走到這裡：迴圈內每個分支都會 return 或 throw，
  // 保留此行只是為了讓 TypeScript 確認函式一定有回傳值／拋出例外。
  throw new SourceFetchError({ pageIndex, message: "未預期的重試迴圈結束" });
}

/**
 * 逐頁抓取範本目錄來源，一次只 yield 一頁。
 *
 * 終止條件：`rows.length < config.pageSize` 即代表這是最後一頁（尾頁可能不足一頁，
 * 也可能剛好 0 筆）。若來源總筆數恰好是 pageSize 的整數倍，最後一頁會是滿頁，
 * 這種情況下允許「多請求一次」拿到空頁才真正結束——但空頁（`rows.length === 0`）
 * 本身不會被 yield 出去，呼叫端看到的最後一頁永遠是有內容的。
 *
 * 注意：來源開啟 overlap 模式時，中間頁可能因為重複塞入上一頁最後一列而變成
 * `pageSize + 1` 列——這仍然「不小於」pageSize，不會被誤判成尾頁。
 */
export async function* streamCatalogPages(
  config: StagingSyncConfig,
  options: StreamCatalogPagesOptions = {},
): AsyncGenerator<SourcePage> {
  const sleep = options.sleep ?? defaultSleep;

  let offset = 0;
  for (;;) {
    const pageIndex = Math.floor(offset / config.pageSize);
    const rows = await fetchPageWithRetry(config, pageIndex, offset, sleep);

    if (rows.length === 0) {
      // 空頁不 yield，直接結束（涵蓋「來源總筆數恰為 pageSize 整數倍」的情境）。
      return;
    }

    yield { pageIndex, offset, rows, count: rows.length };

    if (rows.length < config.pageSize) {
      // 不足一頁＝尾頁，結束（不再多請求）。
      return;
    }

    offset += config.pageSize;
  }
}
