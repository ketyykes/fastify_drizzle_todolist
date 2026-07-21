// 四支 staging-sync CLI 的核心函式層測試（見設計簡報 §12「scripts/staging-sync-cli.test.ts」）。
// 比照 outbox-prune.test.ts／outbox-requeue-dead.test.ts：純參數解析函式直接單元
// 測試；需要 DB／HTTP 的部分（同步本體、abandon、prune）呼叫抽出的核心函式，
// 驗 exit code 語意與輸出形狀，不透過 spawn 子行程。mock-source 起法比照
// dispatcher.test.ts：ephemeral port + setStagingSyncConfigForTest。
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import { db, syncRuns } from "@fastify_drizzle_todolist/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getStagingSyncConfig,
  setStagingSyncConfigForTest,
  type StagingSyncConfig,
} from "../staging-sync/config";
import { RESULT_CODE, SYNC_RUN_PHASE, SYNC_TYPE_TEMPLATE_CATALOG } from "../staging-sync/constants";
import { createTestApp, resetDb } from "../test/helpers";
import { parseAbandonArgs, runStagingSyncAbandon } from "./staging-sync-abandon";
import { runStagingSyncPrune } from "./staging-sync-prune";
import { runStagingSyncOnce } from "./staging-sync-run";
import { parseStatusArgs, runStagingSyncStatus } from "./staging-sync-status";

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

function buildConfig(overrides: Partial<StagingSyncConfig> = {}): StagingSyncConfig {
  return { ...getStagingSyncConfig(), ...overrides };
}

async function setMockSourceMode(mode: string): Promise<void> {
  await app.inject({ method: "PUT", url: "/mock-source/mode", payload: { mode } });
}

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

describe("staging-sync-run", () => {
  it("成功：exit 0，summary.resultCode=success", async () => {
    setStagingSyncConfigForTest(buildConfig({ sourceUrl: `${baseSourceUrl}?total=6` }));

    const result = await runStagingSyncOnce();

    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 1) {
      expect(result.summary.resultCode).toBe(RESULT_CODE.SUCCESS);
    }
  });

  it("no_data 契約：mode=empty 時 exit 2（教學重點：排程不得視為成功）", async () => {
    await setMockSourceMode("empty");

    const result = await runStagingSyncOnce();

    expect(result.exitCode).toBe(2);
    if (result.exitCode !== 1) {
      expect(result.summary.resultCode).toBe(RESULT_CODE.NO_DATA);
    }
  });

  it("來源故障：exit 1，帶消毒過的錯誤訊息", async () => {
    await setMockSourceMode("fail");

    const result = await runStagingSyncOnce();

    expect(result.exitCode).toBe(1);
    if (result.exitCode === 1) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

describe("parseStatusArgs", () => {
  it("省略 --limit：預設 20", () => {
    expect(parseStatusArgs([])).toEqual({ ok: true, limit: 20 });
  });

  it("--limit=5：解析出指定筆數", () => {
    expect(parseStatusArgs(["--limit=5"])).toEqual({ ok: true, limit: 5 });
  });

  it("--limit=99999：封頂 100", () => {
    expect(parseStatusArgs(["--limit=99999"])).toEqual({ ok: true, limit: 100 });
  });

  it("--limit=0：回傳錯誤", () => {
    expect(parseStatusArgs(["--limit=0"]).ok).toBe(false);
  });

  it("--limit=abc：回傳錯誤", () => {
    expect(parseStatusArgs(["--limit=abc"]).ok).toBe(false);
  });
});

describe("runStagingSyncStatus", () => {
  it("成功：exit 0，輸出不含 owner_token", async () => {
    await insertSyncRun({ phase: SYNC_RUN_PHASE.STAGED });

    const result = await runStagingSyncStatus([]);

    expect(result.exitCode).toBe(0);
    if (result.exitCode === 0) {
      expect(result.runs.length).toBeGreaterThan(0);
      for (const run of result.runs) {
        expect(run).not.toHaveProperty("ownerToken");
      }
    }
  });

  it("參數不合法：exit 1", async () => {
    const result = await runStagingSyncStatus(["--limit=-1"]);

    expect(result.exitCode).toBe(1);
  });
});

describe("parseAbandonArgs", () => {
  it("缺少 runId：回傳錯誤", () => {
    expect(parseAbandonArgs(["--reason=x"]).ok).toBe(false);
  });

  it("runId 非數字：回傳錯誤", () => {
    expect(parseAbandonArgs(["abc", "--reason=x"]).ok).toBe(false);
  });

  it("缺少 --reason：回傳錯誤", () => {
    expect(parseAbandonArgs(["1"]).ok).toBe(false);
  });

  it("--reason 空值：回傳錯誤", () => {
    expect(parseAbandonArgs(["1", "--reason="]).ok).toBe(false);
  });

  it("兩參數皆合法：解析成功", () => {
    expect(parseAbandonArgs(["1", "--reason=手動放棄"])).toEqual({
      ok: true,
      runId: 1,
      reason: "手動放棄",
    });
  });
});

describe("runStagingSyncAbandon", () => {
  it("成功：exit 0，run 轉為 abandoned", async () => {
    const run = await insertSyncRun({ phase: SYNC_RUN_PHASE.STAGED });

    const result = await runStagingSyncAbandon([String(run.id), "--reason=CLI 人工放棄"]);

    expect(result.exitCode).toBe(0);
    if (result.exitCode === 0) {
      expect(result.run.phase).toBe(SYNC_RUN_PHASE.ABANDONED);
      expect(result.run.abandonedReason).toBe("CLI 人工放棄");
    }
  });

  it("run 非 staged 狀態：exit 1", async () => {
    const run = await insertSyncRun({
      phase: SYNC_RUN_PHASE.DONE,
      resultCode: RESULT_CODE.SUCCESS,
      ownerToken: null,
    });

    const result = await runStagingSyncAbandon([String(run.id), "--reason=x"]);

    expect(result.exitCode).toBe(1);
  });

  it("run 不存在：exit 1", async () => {
    const result = await runStagingSyncAbandon(["999999", "--reason=x"]);

    expect(result.exitCode).toBe(1);
  });

  it("參數不合法：exit 1", async () => {
    const result = await runStagingSyncAbandon(["--reason=x"]);

    expect(result.exitCode).toBe(1);
  });
});

describe("runStagingSyncPrune", () => {
  it("成功：exit 0，輸出清理統計形狀", async () => {
    const result = await runStagingSyncPrune();

    expect(result.exitCode).toBe(0);
    expect(typeof result.summary.doneStagingRunsCleaned).toBe("number");
    expect(typeof result.summary.failedStagingRunsCleaned).toBe("number");
    expect(typeof result.summary.runsDeleted).toBe("number");
  });
});
