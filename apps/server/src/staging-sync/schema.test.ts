// staging-sync schema 測試：驗證 drizzle schema 落地的資料庫層 invariant——
// 這些 invariant 是「最後防線」，即使上層邏輯（advisory lock、fencing）有漏洞，
// 資料庫層的 UNIQUE / partial unique index 仍要擋得住不合法的資料狀態。
//
// 涵蓋範圍（本檔只驗 schema 本身，不涉及 run-manager/merger 等業務邏輯）：
//   1. sync_runs 的 partial unique index（uq_sync_runs_active）：
//      同一 sync_type 同時只能有一個進行中（fetching/staged/swapping）的 run，
//      terminal（done/fetch_failed/abandoned）不受此限制。
//   2. 三張 staging 表的 (sync_run_id, 業務鍵) UNIQUE：同一 run 內業務鍵不可重複，
//      不同 run 之間彼此隔離（互不影響，示範 run 隔離）。
//   3. 三張目標表的業務鍵 UNIQUE：全量刷新 upsert 的 conflict target。
import {
  db,
  syncRuns,
  templateItemTags,
  templateItemTagsStaging,
  templateItems,
  templateItemsStaging,
  templateLists,
  templateListsStaging,
} from "@fastify_drizzle_todolist/db";
import { beforeEach, describe, expect, it } from "vitest";

import { resetDb } from "../test/helpers";

beforeEach(async () => {
  await resetDb();
});

/**
 * 取出 Postgres 錯誤碼（如 unique violation 為 23505）。
 * drizzle 會把底層 pg 的 DatabaseError 包成 DrizzleQueryError，
 * 真正帶 `code` 的錯誤在 `error.cause`，因此需要往下解包一層。
 */
function pgErrorCode(error: unknown): string | undefined {
  const target =
    error && typeof error === "object" && "cause" in error
      ? (error as { cause?: unknown }).cause
      : error;
  if (target && typeof target === "object" && "code" in target) {
    return (target as { code?: string }).code;
  }
  return undefined;
}

describe("sync_runs：partial unique index uq_sync_runs_active", () => {
  it("同一 sync_type 兩個進行中（active）run 撞 23505", async () => {
    await db.insert(syncRuns).values({ syncType: "template_catalog", phase: "fetching" });

    let code: string | undefined;
    try {
      await db.insert(syncRuns).values({ syncType: "template_catalog", phase: "staged" });
    } catch (error) {
      code = pgErrorCode(error);
    }

    expect(code).toBe("23505");
  });

  it("fetching 與 swapping 兩個 active phase 一樣互斥", async () => {
    await db.insert(syncRuns).values({ syncType: "template_catalog", phase: "swapping" });

    let code: string | undefined;
    try {
      await db.insert(syncRuns).values({ syncType: "template_catalog", phase: "fetching" });
    } catch (error) {
      code = pgErrorCode(error);
    }

    expect(code).toBe("23505");
  });

  it("active（fetching）與 terminal（done）可共存", async () => {
    await db.insert(syncRuns).values({ syncType: "template_catalog", phase: "done" });

    await expect(
      db.insert(syncRuns).values({ syncType: "template_catalog", phase: "fetching" }),
    ).resolves.not.toThrow();
  });

  it("多筆 terminal（done/fetch_failed/abandoned）可共存，不受唯一索引限制", async () => {
    await db.insert(syncRuns).values({ syncType: "template_catalog", phase: "done" });
    await db.insert(syncRuns).values({ syncType: "template_catalog", phase: "fetch_failed" });

    await expect(
      db.insert(syncRuns).values({ syncType: "template_catalog", phase: "abandoned" }),
    ).resolves.not.toThrow();

    const rows = await db.select().from(syncRuns);
    expect(rows).toHaveLength(3);
  });

  it("不同 sync_type 各自可以有一個進行中的 run", async () => {
    await db.insert(syncRuns).values({ syncType: "template_catalog", phase: "fetching" });

    await expect(
      db.insert(syncRuns).values({ syncType: "other_catalog", phase: "fetching" }),
    ).resolves.not.toThrow();
  });
});

describe("template_lists_staging：UNIQUE (sync_run_id, source_list_id)", () => {
  it("同一 run 內 source_list_id 重複撞 23505", async () => {
    await db
      .insert(templateListsStaging)
      .values({ syncRunId: 1, sourceListId: 1000, title: "清單 A" });

    let code: string | undefined;
    try {
      await db
        .insert(templateListsStaging)
        .values({ syncRunId: 1, sourceListId: 1000, title: "清單 A（重複）" });
    } catch (error) {
      code = pgErrorCode(error);
    }

    expect(code).toBe("23505");
  });

  it("不同 run 之間相同 source_list_id 不衝突（run 隔離）", async () => {
    await db
      .insert(templateListsStaging)
      .values({ syncRunId: 1, sourceListId: 1000, title: "清單 A" });

    await expect(
      db.insert(templateListsStaging).values({ syncRunId: 2, sourceListId: 1000, title: "清單 A" }),
    ).resolves.not.toThrow();
  });
});

describe("template_items_staging：UNIQUE (sync_run_id, source_item_id)", () => {
  it("同一 run 內 source_item_id 重複撞 23505", async () => {
    await db.insert(templateItemsStaging).values({
      syncRunId: 1,
      sourceItemId: 100000,
      sourceListId: 1000,
      title: "項目 A",
      priority: 5,
    });

    let code: string | undefined;
    try {
      await db.insert(templateItemsStaging).values({
        syncRunId: 1,
        sourceItemId: 100000,
        sourceListId: 1000,
        title: "項目 A（重複）",
        priority: 5,
      });
    } catch (error) {
      code = pgErrorCode(error);
    }

    expect(code).toBe("23505");
  });

  it("不同 run 之間相同 source_item_id 不衝突（run 隔離）", async () => {
    await db.insert(templateItemsStaging).values({
      syncRunId: 1,
      sourceItemId: 100000,
      sourceListId: 1000,
      title: "項目 A",
      priority: 5,
    });

    await expect(
      db.insert(templateItemsStaging).values({
        syncRunId: 2,
        sourceItemId: 100000,
        sourceListId: 1000,
        title: "項目 A",
        priority: 5,
      }),
    ).resolves.not.toThrow();
  });
});

describe("template_item_tags_staging：UNIQUE (sync_run_id, source_item_id, tag)", () => {
  it("同一 run 內相同 (source_item_id, tag) 重複撞 23505", async () => {
    await db
      .insert(templateItemTagsStaging)
      .values({ syncRunId: 1, sourceItemId: 100000, tag: "紅色" });

    let code: string | undefined;
    try {
      await db
        .insert(templateItemTagsStaging)
        .values({ syncRunId: 1, sourceItemId: 100000, tag: "紅色" });
    } catch (error) {
      code = pgErrorCode(error);
    }

    expect(code).toBe("23505");
  });

  it("同一 run 內相同 source_item_id 但不同 tag 不衝突（複合鍵）", async () => {
    await db
      .insert(templateItemTagsStaging)
      .values({ syncRunId: 1, sourceItemId: 100000, tag: "紅色" });

    await expect(
      db
        .insert(templateItemTagsStaging)
        .values({ syncRunId: 1, sourceItemId: 100000, tag: "藍色" }),
    ).resolves.not.toThrow();
  });

  it("不同 run 之間相同 (source_item_id, tag) 不衝突（run 隔離）", async () => {
    await db
      .insert(templateItemTagsStaging)
      .values({ syncRunId: 1, sourceItemId: 100000, tag: "紅色" });

    await expect(
      db
        .insert(templateItemTagsStaging)
        .values({ syncRunId: 2, sourceItemId: 100000, tag: "紅色" }),
    ).resolves.not.toThrow();
  });
});

describe("template_lists：業務鍵唯一 uq_template_lists_source", () => {
  it("source_list_id 重複撞 23505", async () => {
    await db.insert(templateLists).values({ sourceListId: 1000, title: "清單 A" });

    let code: string | undefined;
    try {
      await db.insert(templateLists).values({ sourceListId: 1000, title: "清單 A（重複）" });
    } catch (error) {
      code = pgErrorCode(error);
    }

    expect(code).toBe("23505");
  });

  it("預設值：is_active 預設 true", async () => {
    const [row] = await db
      .insert(templateLists)
      .values({ sourceListId: 1000, title: "清單 A" })
      .returning();

    expect(row?.isActive).toBe(true);
  });
});

describe("template_items：業務鍵唯一 uq_template_items_source", () => {
  it("source_item_id 重複撞 23505", async () => {
    await db
      .insert(templateItems)
      .values({ sourceItemId: 100000, sourceListId: 1000, title: "項目 A" });

    let code: string | undefined;
    try {
      await db
        .insert(templateItems)
        .values({ sourceItemId: 100000, sourceListId: 1000, title: "項目 A（重複）" });
    } catch (error) {
      code = pgErrorCode(error);
    }

    expect(code).toBe("23505");
  });

  it("預設值：priority 與 position 預設 0，is_active 預設 true", async () => {
    const [row] = await db
      .insert(templateItems)
      .values({ sourceItemId: 100000, sourceListId: 1000, title: "項目 A" })
      .returning();

    expect(row?.priority).toBe(0);
    expect(row?.position).toBe(0);
    expect(row?.isActive).toBe(true);
  });
});

describe("template_item_tags：複合業務鍵唯一 uq_template_item_tags_source", () => {
  it("相同 (source_item_id, tag) 重複撞 23505", async () => {
    await db.insert(templateItemTags).values({ sourceItemId: 100000, tag: "紅色" });

    let code: string | undefined;
    try {
      await db.insert(templateItemTags).values({ sourceItemId: 100000, tag: "紅色" });
    } catch (error) {
      code = pgErrorCode(error);
    }

    expect(code).toBe("23505");
  });

  it("相同 source_item_id 不同 tag 不衝突", async () => {
    await db.insert(templateItemTags).values({ sourceItemId: 100000, tag: "紅色" });

    await expect(
      db.insert(templateItemTags).values({ sourceItemId: 100000, tag: "藍色" }),
    ).resolves.not.toThrow();
  });
});
