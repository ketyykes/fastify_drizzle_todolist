// staging-sync-admin 路由測試：涵蓋設計簡報 §12「routes/staging-sync-admin.test.ts」列。
// 比照 outbox-admin.test.ts 的做法：mock-source 與被測路由掛在同一個 app 實例上，
// app.listen({ port: 0 }) 起一個真實埠，把 config.sourceUrl 指向自己的 ephemeral
// port，藉此讓 page-fetcher 的真實 fetch 打得到 mock-source（同一支 process 內）。
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import { db, pool, syncRuns } from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getStagingSyncConfig,
  setStagingSyncConfigForTest,
  type StagingSyncConfig,
} from "../staging-sync/config";
import { RESULT_CODE, SYNC_RUN_PHASE, SYNC_TYPE_TEMPLATE_CATALOG } from "../staging-sync/constants";
import { acquireSyncLock } from "../staging-sync/mutex";
import type { SourceListRow } from "../staging-sync/types";
import { createTestApp, registerAndGetToken, resetDb } from "../test/helpers";

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
    // 刻意設很短，即使觸發重試（fetch 失敗情境）測試也不會被拖慢
    fetchRetryDelayMs: 10,
    fetchTimeoutMs: 3000,
    retention: { doneStagingDays: 1, failedStagingDays: 7, terminalRunDays: 90 },
  });
});

afterAll(async () => {
  setStagingSyncConfigForTest(null);
  await app.close();
});

beforeEach(async () => {
  await resetDb();
  await app.inject({ method: "POST", url: "/mock-source/reset" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** 以目前 setStagingSyncConfigForTest 的設定為底，套用逐測試的覆寫值。 */
function buildConfig(overrides: Partial<StagingSyncConfig> = {}): StagingSyncConfig {
  return { ...getStagingSyncConfig(), ...overrides };
}

async function setMockSourceMode(mode: string): Promise<void> {
  await app.inject({ method: "PUT", url: "/mock-source/mode", payload: { mode } });
}

/** 直接向 mock-source 要「一整頁」拿到全部資料，做為驗證用的基準真相。 */
async function fetchGroundTruth(total: number): Promise<SourceListRow[]> {
  const url = new URL(baseSourceUrl);
  url.searchParams.set("limit", String(total));
  url.searchParams.set("offset", "0");
  url.searchParams.set("total", String(total));
  const response = await fetch(url);
  const body = (await response.json()) as { rows: SourceListRow[]; count: number };
  return body.rows;
}

/**
 * 依設計簡報 §7 的規則（partition 依 source_list_id、priority DESC、
 * source_item_id ASC）算出「catalog 端點應輸出」的巢狀結構，供比對用。
 */
function computeExpectedCatalog(rows: SourceListRow[]) {
  return [...rows]
    .sort((a, b) => a.sourceListId - b.sourceListId)
    .map((row) => ({
      sourceListId: row.sourceListId,
      title: row.title,
      description: row.description,
      items: [...row.items]
        .sort((a, b) => {
          if (b.priority !== a.priority) {
            return b.priority - a.priority;
          }
          return a.sourceItemId - b.sourceItemId;
        })
        .map((item, index) => ({
          sourceItemId: item.sourceItemId,
          title: item.title,
          priority: item.priority,
          position: index + 1,
          tags: [...item.tags].sort(),
        })),
    }));
}

/**
 * 直接寫入一列 sync_runs（略過 startFetching 的 insert 限制），供測試佈置
 * abandon 情境用（比照 run-manager.test.ts 的 insertSyncRun）。
 */
async function insertSyncRun(overrides: Partial<typeof syncRuns.$inferInsert> = {}) {
  const [row] = await db
    .insert(syncRuns)
    .values({
      syncType: SYNC_TYPE_TEMPLATE_CATALOG,
      phase: SYNC_RUN_PHASE.FETCHING,
      ownerToken: randomUUID(),
      leaseVersion: 1,
      ...overrides,
    })
    .returning();
  if (!row) {
    throw new Error("建立測試 sync_runs 失敗");
  }
  return row;
}

describe("認證", () => {
  it("未帶 token 呼叫四支端點皆回 401", async () => {
    const trigger = await app.inject({ method: "POST", url: "/staging-sync/trigger" });
    expect(trigger.statusCode).toBe(401);

    const runs = await app.inject({ method: "GET", url: "/staging-sync/runs" });
    expect(runs.statusCode).toBe(401);

    const abandon = await app.inject({
      method: "POST",
      url: "/staging-sync/runs/1/abandon",
      payload: { reason: "test" },
    });
    expect(abandon.statusCode).toBe(401);

    const catalog = await app.inject({ method: "GET", url: "/staging-sync/catalog" });
    expect(catalog.statusCode).toBe(401);
  });
});

describe("POST /staging-sync/trigger", () => {
  it("成功：200，body 是消毒過的 SyncRunSummary（resultCode=success）", async () => {
    const token = await registerAndGetToken(app, "trigger-success@example.com");
    setStagingSyncConfigForTest(buildConfig({ sourceUrl: `${baseSourceUrl}?total=6` }));

    const res = await app.inject({
      method: "POST",
      url: "/staging-sync/trigger",
      headers: auth(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resultCode).toBe(RESULT_CODE.SUCCESS);
    expect(typeof body.runId).toBe("number");
    expect(body.pageCount).toBeGreaterThan(0);
    expect(body).not.toHaveProperty("ownerToken");
  });

  it("鎖衝突：其他流程持有 advisory lock 時回 409", async () => {
    const token = await registerAndGetToken(app, "trigger-lock-conflict@example.com");
    setStagingSyncConfigForTest(buildConfig({ sourceUrl: `${baseSourceUrl}?total=6` }));

    const externalLock = await acquireSyncLock(SYNC_TYPE_TEMPLATE_CATALOG);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/staging-sync/trigger",
        headers: auth(token),
      });

      expect(res.statusCode).toBe(409);
      expect(typeof res.json().error).toBe("string");
    } finally {
      await externalLock.release();
    }
  });

  it("取鎖過程本身出錯（連線池故障）：503，且回應形狀為 { error }", async () => {
    const token = await registerAndGetToken(app, "trigger-lock-error@example.com");
    setStagingSyncConfigForTest(buildConfig({ sourceUrl: `${baseSourceUrl}?total=6` }));
    vi.spyOn(pool, "connect").mockRejectedValueOnce(new Error("模擬連線池耗盡"));

    const res = await app.inject({
      method: "POST",
      url: "/staging-sync/trigger",
      headers: auth(token),
    });

    expect(res.statusCode).toBe(503);
    expect(typeof res.json().error).toBe("string");
  });

  it("來源故障：502，且 run 收尾 fetch_failed", async () => {
    const token = await registerAndGetToken(app, "trigger-source-fail@example.com");
    await setMockSourceMode("fail");

    const res = await app.inject({
      method: "POST",
      url: "/staging-sync/trigger",
      headers: auth(token),
    });

    expect(res.statusCode).toBe(502);
    expect(typeof res.json().error).toBe("string");

    const [run] = await db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.syncType, SYNC_TYPE_TEMPLATE_CATALOG));
    expect(run?.phase).toBe(SYNC_RUN_PHASE.FETCH_FAILED);
    expect(run?.resultCode).toBe(RESULT_CODE.FETCH_FAILED);
  });
});

describe("GET /staging-sync/runs", () => {
  it("輸出不含 owner_token，且逐欄位涵蓋設計簡報要求的欄位", async () => {
    const token = await registerAndGetToken(app, "runs-list@example.com");
    await insertSyncRun({ phase: SYNC_RUN_PHASE.STAGED, resultCode: null });

    const res = await app.inject({
      method: "GET",
      url: "/staging-sync/runs",
      headers: auth(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    for (const row of body) {
      expect(row).not.toHaveProperty("ownerToken");
      expect(row).not.toHaveProperty("owner_token");
      expect(row).toHaveProperty("id");
      expect(row).toHaveProperty("phase");
      expect(row).toHaveProperty("leaseVersion");
      expect(row).toHaveProperty("lockBackendPid");
    }
  });

  it("limit 參數受尊重，且上限封頂 100", async () => {
    const token = await registerAndGetToken(app, "runs-limit@example.com");
    // 只能有一個 active（fetching/staged/swapping）run（partial unique index），
    // 故這裡插入已收尾的終態列，才能一次插入多筆而不撞 uq_sync_runs_active。
    for (let i = 0; i < 3; i++) {
      await insertSyncRun({
        phase: SYNC_RUN_PHASE.DONE,
        resultCode: RESULT_CODE.SUCCESS,
        ownerToken: null,
      });
    }

    const limited = await app.inject({
      method: "GET",
      url: "/staging-sync/runs?limit=2",
      headers: auth(token),
    });
    expect(limited.statusCode).toBe(200);
    expect(limited.json()).toHaveLength(2);

    const capped = await app.inject({
      method: "GET",
      url: "/staging-sync/runs?limit=99999",
      headers: auth(token),
    });
    expect(capped.statusCode).toBe(200);
    expect(capped.json().length).toBeLessThanOrEqual(100);
  });
});

describe("POST /staging-sync/runs/:id/abandon", () => {
  it("reason 缺漏：400", async () => {
    const token = await registerAndGetToken(app, "abandon-missing-reason@example.com");
    const run = await insertSyncRun({ phase: SYNC_RUN_PHASE.STAGED });

    const res = await app.inject({
      method: "POST",
      url: `/staging-sync/runs/${run.id}/abandon`,
      headers: auth(token),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it("reason 為空白字串：400", async () => {
    const token = await registerAndGetToken(app, "abandon-blank-reason@example.com");
    const run = await insertSyncRun({ phase: SYNC_RUN_PHASE.STAGED });

    const res = await app.inject({
      method: "POST",
      url: `/staging-sync/runs/${run.id}/abandon`,
      headers: auth(token),
      payload: { reason: "   " },
    });

    expect(res.statusCode).toBe(400);
  });

  it("run 非 staged 狀態：422", async () => {
    const token = await registerAndGetToken(app, "abandon-not-staged@example.com");
    const run = await insertSyncRun({
      phase: SYNC_RUN_PHASE.DONE,
      resultCode: RESULT_CODE.SUCCESS,
      ownerToken: null,
    });

    const res = await app.inject({
      method: "POST",
      url: `/staging-sync/runs/${run.id}/abandon`,
      headers: auth(token),
      payload: { reason: "資料有問題" },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "只有 staged 狀態的 run 可以放棄" });
  });

  it("run 不存在：422", async () => {
    const token = await registerAndGetToken(app, "abandon-not-found@example.com");

    const res = await app.inject({
      method: "POST",
      url: "/staging-sync/runs/999999/abandon",
      headers: auth(token),
      payload: { reason: "不存在" },
    });

    expect(res.statusCode).toBe(422);
  });

  it("成功：200，operator 記為登入者 email，輸出不含 owner_token", async () => {
    const email = "abandon-success@example.com";
    const token = await registerAndGetToken(app, email);
    const run = await insertSyncRun({ phase: SYNC_RUN_PHASE.STAGED });

    const res = await app.inject({
      method: "POST",
      url: `/staging-sync/runs/${run.id}/abandon`,
      headers: auth(token),
      payload: { reason: "資料有問題，人工放棄" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.phase).toBe(SYNC_RUN_PHASE.ABANDONED);
    expect(body.resultCode).toBe(RESULT_CODE.ABANDONED);
    expect(body.abandonedBy).toBe(email);
    expect(body.abandonedReason).toBe("資料有問題，人工放棄");
    expect(body).not.toHaveProperty("ownerToken");

    const [persisted] = await db.select().from(syncRuns).where(eq(syncRuns.id, run.id));
    expect(persisted?.phase).toBe(SYNC_RUN_PHASE.ABANDONED);
    expect(persisted?.ownerToken).toBeNull();
  });
});

describe("GET /staging-sync/catalog", () => {
  it("巢狀輸出，lists 依 sourceListId、items 依 position、tags 依字母排序", async () => {
    const token = await registerAndGetToken(app, "catalog-view@example.com");
    const total = 6;
    setStagingSyncConfigForTest(buildConfig({ sourceUrl: `${baseSourceUrl}?total=${total}` }));
    const groundTruth = await fetchGroundTruth(total);
    const expected = computeExpectedCatalog(groundTruth);

    const trigger = await app.inject({
      method: "POST",
      url: "/staging-sync/trigger",
      headers: auth(token),
    });
    expect(trigger.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: "/staging-sync/catalog",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lists: expected });
  });

  it("三個查詢包在同一個 REPEATABLE READ 唯讀交易內執行（防撕裂快照回歸測試）", async () => {
    const token = await registerAndGetToken(app, "catalog-transaction-options@example.com");
    const originalTransaction = db.transaction.bind(db);
    let capturedConfig: unknown;
    const transactionSpy = vi
      .spyOn(db, "transaction")
      .mockImplementation((callback: Parameters<typeof db.transaction>[0], config?: unknown) => {
        capturedConfig = config;
        return originalTransaction(callback, config as never);
      });

    const res = await app.inject({
      method: "GET",
      url: "/staging-sync/catalog",
      headers: auth(token),
    });

    expect(res.statusCode).toBe(200);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(capturedConfig).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });
  });
});
