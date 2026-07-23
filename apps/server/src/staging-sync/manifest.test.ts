// manifest.ts 是 staging-writer／merger／測試共用的單一事實來源，本檔驗證
// manifest 宣告的欄位確實存在於實際的 drizzle schema 上——避免手動打錯欄名
// 卻要到跑 staging-writer/merger 整合測試才發現。
import {
  templateItemTags,
  templateItemTagsStaging,
  templateItems,
  templateItemsStaging,
  templateLists,
  templateListsStaging,
} from "@fastify_drizzle_todolist/db";
import { describe, expect, it } from "vitest";

import { templateCatalogManifest } from "./manifest";

/**
 * 依欄名字串從 drizzle table 物件上取出對應的 column（column 會是 table 上的
 * 一個 own property）；欄名不存在時回傳 undefined。
 */
function getColumn(table: object, columnName: string): unknown {
  return (table as Record<string, unknown>)[columnName];
}

describe("templateCatalogManifest", () => {
  it("涵蓋 3 張表，且順序與命名固定", () => {
    expect(templateCatalogManifest).toHaveLength(3);
    expect(templateCatalogManifest.map((entry) => entry.name)).toEqual([
      "template_lists",
      "template_items",
      "template_item_tags",
    ]);
  });

  it("每個 entry 的 stagingTable/targetTable 物件參照與 schema 一致（同一個物件）", () => {
    const [lists, items, tags] = templateCatalogManifest;

    expect(lists?.stagingTable).toBe(templateListsStaging);
    expect(lists?.targetTable).toBe(templateLists);
    expect(items?.stagingTable).toBe(templateItemsStaging);
    expect(items?.targetTable).toBe(templateItems);
    expect(tags?.stagingTable).toBe(templateItemTagsStaging);
    expect(tags?.targetTable).toBe(templateItemTags);
  });

  it("stagingConflictColumns 宣告的每個欄名，在 staging 表上都實際存在", () => {
    for (const entry of templateCatalogManifest) {
      for (const columnName of entry.stagingConflictColumns) {
        expect(
          getColumn(entry.stagingTable, columnName),
          `${entry.name}.stagingTable.${columnName} 應存在`,
        ).toBeDefined();
      }
    }
  });

  it("targetConflictColumns 宣告的每個欄名，在目標表上都實際存在", () => {
    for (const entry of templateCatalogManifest) {
      for (const columnName of entry.targetConflictColumns) {
        expect(
          getColumn(entry.targetTable, columnName),
          `${entry.name}.targetTable.${columnName} 應存在`,
        ).toBeDefined();
      }
    }
  });

  it("payloadColumns 宣告的每個欄名，在 staging 表與目標表上都同時存在", () => {
    for (const entry of templateCatalogManifest) {
      for (const columnName of entry.payloadColumns) {
        expect(
          getColumn(entry.stagingTable, columnName),
          `${entry.name}.stagingTable.${columnName} 應存在`,
        ).toBeDefined();
        expect(
          getColumn(entry.targetTable, columnName),
          `${entry.name}.targetTable.${columnName} 應存在`,
        ).toBeDefined();
      }
    }
  });

  it("stagingConflictColumns 一律含 syncRunId（run 隔離＋跨頁重複 last-row-wins 的鍵）", () => {
    for (const entry of templateCatalogManifest) {
      expect(entry.stagingConflictColumns).toContain("syncRunId");
    }
  });

  it("targetConflictColumns 不含本地 id／syncRunId（純業務鍵，避免 PK 世代切換產生孤兒）", () => {
    for (const entry of templateCatalogManifest) {
      expect(entry.targetConflictColumns).not.toContain("id");
      expect(entry.targetConflictColumns).not.toContain("syncRunId");
    }
  });

  it("payloadColumns 不含 conflict key／is_active／position／timestamps／本地 id", () => {
    const forbiddenAlways = ["id", "isActive", "createdAt", "updatedAt"];
    for (const entry of templateCatalogManifest) {
      const forbidden = [...forbiddenAlways, ...entry.targetConflictColumns];
      for (const columnName of entry.payloadColumns) {
        expect(forbidden).not.toContain(columnName);
      }
    }
  });

  it("template_items 的 payload 不含 position（衍生欄位由 merger 交易內重算，不從 staging 搬移）", () => {
    const items = templateCatalogManifest.find((entry) => entry.name === "template_items");
    expect(items?.payloadColumns).not.toContain("position");
  });

  it("template_item_tags 的 conflict key 是複合鍵，且沒有額外 payload（業務鍵就是全部資料）", () => {
    const tags = templateCatalogManifest.find((entry) => entry.name === "template_item_tags");
    expect(tags?.targetConflictColumns).toEqual(["sourceItemId", "tag"]);
    expect(tags?.payloadColumns).toEqual([]);
  });
});
