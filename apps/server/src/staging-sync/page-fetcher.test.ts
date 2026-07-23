// page-fetcher 透過全域 fetch 呼叫真實 HTTP：比照 outbox/sender.test.ts 的做法，
// 用 app.listen({ port: 0 }) 起一個 ephemeral port 的測試 app，讓 mock-source 路由
// 可以被當成「外部來源」打。全程用 setStagingSyncConfigForTest 覆寫設定。
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getStagingSyncConfig,
  setStagingSyncConfigForTest,
  type StagingSyncConfig,
} from "./config";
import { SourceFetchError } from "./errors";
import { streamCatalogPages } from "./page-fetcher";
import type { SourcePage } from "./types";
import { createTestApp } from "../test/helpers";

const app = createTestApp();

let baseSourceUrl: string;

beforeAll(async () => {
  await app.listen({ port: 0 });
  const address = app.server.address() as AddressInfo;
  baseSourceUrl = `http://127.0.0.1:${address.port}/mock-source/template-catalog`;
  setStagingSyncConfigForTest({
    sourceUrl: baseSourceUrl,
    pageSize: 3,
    fetchRetries: 3,
    fetchRetryDelayMs: 1000,
    fetchTimeoutMs: 3000,
    retention: { doneStagingDays: 1, failedStagingDays: 7, terminalRunDays: 90 },
  });
});

afterAll(async () => {
  setStagingSyncConfigForTest(null);
  await app.close();
});

beforeEach(async () => {
  await app.inject({ method: "POST", url: "/mock-source/reset" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 以目前 setStagingSyncConfigForTest 的設定為底，套用逐測試的覆寫值。 */
function buildConfig(overrides: Partial<StagingSyncConfig> = {}): StagingSyncConfig {
  return { ...getStagingSyncConfig(), ...overrides };
}

async function setMockSourceMode(mode: string): Promise<void> {
  await app.inject({ method: "PUT", url: "/mock-source/mode", payload: { mode } });
}

async function collectPages(config: StagingSyncConfig, sleep?: (ms: number) => Promise<void>) {
  const pages: SourcePage[] = [];
  for await (const page of streamCatalogPages(config, sleep ? { sleep } : {})) {
    pages.push(page);
  }
  return pages;
}

/** 包一層可計數的 fetch spy：呼叫次數可斷言，但行為原樣透傳給真實 fetch。 */
function spyOnFetch() {
  const originalFetch = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation((...args) => originalFetch(...args));
}

describe("streamCatalogPages", () => {
  it("多頁惰性逐頁抓取，每頁內容決定性可比對", async () => {
    const config = buildConfig({ sourceUrl: `${baseSourceUrl}?total=7`, pageSize: 3 });

    const pages = await collectPages(config);

    expect(pages).toHaveLength(3);

    expect(pages[0]?.pageIndex).toBe(0);
    expect(pages[0]?.offset).toBe(0);
    expect(pages[0]?.count).toBe(3);
    expect(pages[0]?.rows.map((r) => r.sourceListId)).toEqual([1000, 1001, 1002]);

    expect(pages[1]?.pageIndex).toBe(1);
    expect(pages[1]?.offset).toBe(3);
    expect(pages[1]?.count).toBe(3);
    expect(pages[1]?.rows.map((r) => r.sourceListId)).toEqual([1003, 1004, 1005]);

    // 尾頁：count(1) < pageSize(3) 觸發終止，且是最後一頁
    expect(pages[2]?.pageIndex).toBe(2);
    expect(pages[2]?.offset).toBe(6);
    expect(pages[2]?.count).toBe(1);
    expect(pages[2]?.rows.map((r) => r.sourceListId)).toEqual([1006]);
  });

  it("提前中止不多抓：for-await 拿到第一頁就 break，只會發出一次 HTTP 請求（驗證惰性）", async () => {
    const config = buildConfig({ sourceUrl: `${baseSourceUrl}?total=7`, pageSize: 3 });
    const fetchSpy = spyOnFetch();

    for await (const page of streamCatalogPages(config)) {
      expect(page.pageIndex).toBe(0);
      break;
    }

    // 若實作不是惰性（例如內部預先抓好下一頁），這裡會超過 1 次。
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("count 剛好等於整頁時，多請求一次拿到空頁後結束，空頁本身不被 yield", async () => {
    const config = buildConfig({ sourceUrl: `${baseSourceUrl}?total=6`, pageSize: 3 });
    const fetchSpy = spyOnFetch();

    const pages = await collectPages(config);

    // 兩頁皆滿頁（3+3=6），第三次請求會拿到空頁，但不算進 yield 出的頁數
    expect(pages).toHaveLength(2);
    expect(pages.every((p) => p.count === 3)).toBe(true);
    expect(pages[1]?.rows.map((r) => r.sourceListId)).toEqual([1003, 1004, 1005]);

    // 驗證確實多打了一次請求（page0 + page1 + 尾端空頁 = 3 次）
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("overlap=1 時中間頁可能是 pageSize+1 列，不可誤判為終止", async () => {
    const config = buildConfig({
      sourceUrl: `${baseSourceUrl}?total=7&overlap=1`,
      pageSize: 3,
    });

    const pages = await collectPages(config);

    expect(pages).toHaveLength(3);

    // 第一頁 offset=0，overlap 邏輯只在 offset>0 時生效，維持原本 3 列
    expect(pages[0]?.count).toBe(3);
    expect(pages[0]?.rows.map((r) => r.sourceListId)).toEqual([1000, 1001, 1002]);

    // 中間頁：正常 3 列 + 重複上一頁最後一列 = 4 列（pageSize+1），
    // 4 並未小於 pageSize(3)，不能被誤判為尾頁而提早停止
    expect(pages[1]?.count).toBe(4);
    expect(pages[1]?.rows.map((r) => r.sourceListId)).toEqual([1002, 1003, 1004, 1005]);

    // 尾頁：1 列真實資料 + 1 列重複 = 2 列，2 < pageSize(3)，正確終止
    expect(pages[2]?.count).toBe(2);
    expect(pages[2]?.rows.map((r) => r.sourceListId)).toEqual([1005, 1006]);
  });

  it("flaky_page_2：第 2 頁第一次失敗、重試後成功，且有實際等待（注入假 sleep 驗證）", async () => {
    await setMockSourceMode("flaky_page_2");
    const config = buildConfig({ sourceUrl: `${baseSourceUrl}?total=10`, pageSize: 3 });
    const fetchSpy = spyOnFetch();
    const fakeSleep = vi.fn(async () => {});

    const pages = await collectPages(config, fakeSleep);

    expect(pages).toHaveLength(4);
    expect(pages[2]?.pageIndex).toBe(2);
    expect(pages[2]?.rows.map((r) => r.sourceListId)).toEqual([1006, 1007, 1008]);

    // 重試確實有等待，且等待時長就是設定的 fetchRetryDelayMs
    expect(fakeSleep).toHaveBeenCalledTimes(1);
    expect(fakeSleep).toHaveBeenCalledWith(config.fetchRetryDelayMs);

    // page0(1) + page1(1) + page2(失敗1次+重試成功1次=2) + page3(1) = 5 次請求
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it("fail_page_2：第 2 頁重試耗盡，拋出 SourceFetchError 且帶 pageIndex/status", async () => {
    await setMockSourceMode("fail_page_2");
    const config = buildConfig({
      sourceUrl: `${baseSourceUrl}?total=10`,
      pageSize: 3,
      fetchRetries: 3,
    });
    const fakeSleep = vi.fn(async () => {});

    let caught: unknown;
    try {
      await collectPages(config, fakeSleep);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SourceFetchError);
    const error = caught as SourceFetchError;
    expect(error.pageIndex).toBe(2);
    expect(error.status).toBe(500);

    // fetchRetries=3：共嘗試 4 次，前 3 次失敗後各等待一次，第 4 次失敗直接拋錯不再等待
    expect(fakeSleep).toHaveBeenCalledTimes(3);
  });

  it("4xx（非法查詢參數）不重試，直接失敗且不等待", async () => {
    // overlap 只允許 0 或 1，帶 2 觸發 zod 驗證失敗 → 400
    const config = buildConfig({ sourceUrl: `${baseSourceUrl}?overlap=2`, pageSize: 3 });
    const fetchSpy = spyOnFetch();
    const fakeSleep = vi.fn(async () => {});

    let caught: unknown;
    try {
      await collectPages(config, fakeSleep);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SourceFetchError);
    const error = caught as SourceFetchError;
    expect(error.pageIndex).toBe(0);
    expect(error.status).toBe(400);

    // 4xx 不重試：只打了一次請求、完全沒有等待
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fakeSleep).not.toHaveBeenCalled();
  });
});
