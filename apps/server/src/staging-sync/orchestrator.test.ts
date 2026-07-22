// orchestrator.test.ts：涵蓋兩類此前缺乏測試覆蓋的行為。
//
// 1. 錯誤遮蔽保護：Phase 1 迴圈內任何一步失敗時，orchestrator 會呼叫
//    failPhaseOne 記錄失敗狀態；若 failPhaseOne 本身也失敗（最常見原因是
//    fence 已被別的流程搶走，例如另一個持鎖 worker 的 recoverActiveRun 已把
//    這個殘留 run 判死收尾），不能讓這第二個錯誤蓋掉呼叫端原本該看到的
//    原始錯誤。
// 2. currentSubPhase 歸因：迴圈內用來標記「究竟是 fetch/transform/stage_write
//    哪一步失敗」的粗粒度追蹤，此前只有 'fetch' 被測試驗證過，'stage_write'
//    與 'transform' 從未被斷言過。
//
// 兩者都不需要真的打 HTTP：直接 mock page-fetcher 的 streamCatalogPages，
// 固定產出一頁資料，讓測試聚焦在 orchestrator 對錯誤路徑與歸因標記的處理。
import { db, syncRuns } from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SYNC_RUN_PHASE, SYNC_TYPE_TEMPLATE_CATALOG } from "./constants";
import { FenceLostError } from "./errors";
import type { SyncLock } from "./mutex";
import { runPhaseOne } from "./orchestrator";
import { streamCatalogPages } from "./page-fetcher";
import { transformPage } from "./page-transformer";
import { failPhaseOne } from "./run-manager";
import { writePage } from "./staging-writer";
import type { SourceListRow, SourcePage } from "./types";
import { resetDb } from "../test/helpers";

// 只 mock 各自「一個」具名匯出，其餘沿用真正的實作（vi.fn(actual.xxx) 當底層
// 行為）；未在個別測試覆寫時，行為與 mock 前完全一致。
vi.mock("./page-fetcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./page-fetcher")>();
  return { ...actual, streamCatalogPages: vi.fn(actual.streamCatalogPages) };
});

vi.mock("./page-transformer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./page-transformer")>();
  return { ...actual, transformPage: vi.fn(actual.transformPage) };
});

vi.mock("./staging-writer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./staging-writer")>();
  return { ...actual, writePage: vi.fn(actual.writePage) };
});

vi.mock("./run-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./run-manager")>();
  return { ...actual, failPhaseOne: vi.fn(actual.failPhaseOne) };
});

/** 假的持鎖結果：runPhaseOne 本身只用得到 backendPid，client/release 不會被呼叫。 */
const fakeLock: SyncLock = {
  client: {
    query: async () => ({ rows: [] }),
    release: () => {},
  },
  backendPid: 1,
  release: async () => {},
};

/** 固定的一頁來源資料，供各測試組出穩定、可預期的 streamCatalogPages 產出。 */
const sampleRows: SourceListRow[] = [
  {
    sourceListId: 1,
    title: "清單1",
    description: "描述1",
    items: [{ sourceItemId: 10, title: "項目1", priority: 5, tags: ["A"] }],
  },
];

/** 組一個只 yield 一頁固定資料的 async generator，取代真實 streamCatalogPages。 */
function singlePageStream(rows: SourceListRow[]) {
  return async function* (): AsyncGenerator<SourcePage> {
    yield { pageIndex: 0, offset: 0, rows, count: rows.length };
  };
}

beforeEach(async () => {
  await resetDb();
  vi.mocked(streamCatalogPages).mockImplementation(singlePageStream(sampleRows));
  vi.mocked(transformPage).mockClear();
  vi.mocked(writePage).mockClear();
  vi.mocked(failPhaseOne).mockClear();
});

describe("runPhaseOne - 錯誤遮蔽保護（fence 被搶走時不能蓋掉原始錯誤）", () => {
  it(
    "writePage 失敗、且 failPhaseOne 本身也失敗（模擬 fence 已被別的流程搶走）：" +
      "runPhaseOne reject 的仍是原始錯誤，不是 failPhaseOne 拋出的 FenceLostError，且有記錄二次失敗",
    async () => {
      vi.mocked(writePage).mockRejectedValueOnce(new Error("ORIGINAL_STAGE_WRITE_FAILURE"));
      // 模擬「failPhaseOne 本身也失敗」：最貼近真實情境的原因是這段期間 fence
      // 已被別的流程搶走（例如另一個持有 advisory lock 的 worker 呼叫
      // recoverActiveRun，已經把這個殘留 run 判死收尾並換發新憑證）。這裡直接
      // mock 它拋錯，聚焦驗證「不能讓這第二個錯誤蓋掉第一個原始錯誤」。
      vi.mocked(failPhaseOne).mockRejectedValueOnce(
        new FenceLostError({
          runId: 0,
          expectedPhase: SYNC_RUN_PHASE.FETCHING,
          ownerToken: "stale-owner-token",
          leaseVersion: 999,
          operation: "failPhaseOne",
        }),
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const error = await runPhaseOne(fakeLock).catch((caught: unknown) => caught);

      // 呼叫端看到的必須是 writePage 拋出的原始錯誤，不是 failPhaseOne 的 FenceLostError
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("ORIGINAL_STAGE_WRITE_FAILURE");
      expect(error).not.toBeInstanceOf(FenceLostError);

      // 二次失敗必須被記錄下來，供事後追查
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnPayload = JSON.parse(warnSpy.mock.calls[0]?.[0] as string) as {
        event: string;
        runId: number;
        error: string;
      };
      expect(warnPayload.event).toBe("staging_sync_phase_one_failure_record_failed");
      expect(warnPayload.error).toBe("FenceLostError");

      warnSpy.mockRestore();
    },
  );
});

describe("runPhaseOne - currentSubPhase 歸因（last_error_phase）", () => {
  it("writePage 失敗（failPhaseOne 用真實實作）：run 收尾 fetch_failed 且 last_error_phase='stage_write'", async () => {
    vi.mocked(writePage).mockRejectedValueOnce(new Error("ORIGINAL_STAGE_WRITE_FAILURE"));

    await expect(runPhaseOne(fakeLock)).rejects.toThrow("ORIGINAL_STAGE_WRITE_FAILURE");

    const [run] = await db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.syncType, SYNC_TYPE_TEMPLATE_CATALOG));
    expect(run?.phase).toBe(SYNC_RUN_PHASE.FETCH_FAILED);
    expect(run?.lastErrorPhase).toBe("stage_write");
  });

  it("transformPage 失敗（failPhaseOne 用真實實作）：run 收尾 fetch_failed 且 last_error_phase='transform'", async () => {
    vi.mocked(transformPage).mockImplementationOnce(() => {
      throw new Error("ORIGINAL_TRANSFORM_FAILURE");
    });

    await expect(runPhaseOne(fakeLock)).rejects.toThrow("ORIGINAL_TRANSFORM_FAILURE");

    const [run] = await db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.syncType, SYNC_TYPE_TEMPLATE_CATALOG));
    expect(run?.phase).toBe(SYNC_RUN_PHASE.FETCH_FAILED);
    expect(run?.lastErrorPhase).toBe("transform");
  });
});
