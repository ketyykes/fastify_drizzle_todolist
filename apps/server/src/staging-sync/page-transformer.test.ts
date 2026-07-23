// transformPage 是純函式（不碰資料庫、不做 I/O），因此本檔不需要 resetDb() 或
// 任何測試用 app，直接對輸入輸出斷言即可（比照 mutex.test.ts 不需要資料庫的做法）。
import { describe, expect, it } from "vitest";

import { transformPage } from "./page-transformer";
import type { SourceListRow } from "./types";

describe("transformPage", () => {
  it("把巢狀 rows 攤平成三個 buffer，含 tags 展開，且 sourcePage/sourceRow 正確", () => {
    const rows: SourceListRow[] = [
      {
        sourceListId: 1000,
        title: "範本清單 1000",
        description: "說明 1000",
        items: [
          { sourceItemId: 100001, title: "項目 100001", priority: 5, tags: ["general", "beta"] },
          { sourceItemId: 100002, title: "項目 100002", priority: 2, tags: [] },
        ],
      },
      {
        sourceListId: 1001,
        title: "範本清單 1001",
        description: "說明 1001",
        items: [{ sourceItemId: 100101, title: "項目 100101", priority: 9, tags: ["urgent"] }],
      },
    ];

    const buffers = transformPage(3, rows);

    expect(buffers.lists).toEqual([
      {
        sourcePage: 3,
        sourceRow: 0,
        sourceListId: 1000,
        title: "範本清單 1000",
        description: "說明 1000",
      },
      {
        sourcePage: 3,
        sourceRow: 1,
        sourceListId: 1001,
        title: "範本清單 1001",
        description: "說明 1001",
      },
    ]);

    expect(buffers.items).toEqual([
      {
        sourcePage: 3,
        sourceRow: 0,
        sourceItemId: 100001,
        sourceListId: 1000,
        title: "項目 100001",
        priority: 5,
      },
      {
        sourcePage: 3,
        sourceRow: 0,
        sourceItemId: 100002,
        sourceListId: 1000,
        title: "項目 100002",
        priority: 2,
      },
      {
        sourcePage: 3,
        sourceRow: 1,
        sourceItemId: 100101,
        sourceListId: 1001,
        title: "項目 100101",
        priority: 9,
      },
    ]);

    // 100001 有兩個標籤展開成兩列；100002 沒有標籤不會產生任何列
    expect(buffers.tags).toEqual([
      { sourcePage: 3, sourceRow: 0, sourceItemId: 100001, tag: "general" },
      { sourcePage: 3, sourceRow: 0, sourceItemId: 100001, tag: "beta" },
      { sourcePage: 3, sourceRow: 1, sourceItemId: 100101, tag: "urgent" },
    ]);
  });

  it("description 為空字串時照原樣存，不轉成 null 或補預設值", () => {
    const rows: SourceListRow[] = [
      { sourceListId: 2000, title: "無說明清單", description: "", items: [] },
    ];

    const buffers = transformPage(0, rows);

    expect(buffers.lists).toEqual([
      {
        sourcePage: 0,
        sourceRow: 0,
        sourceListId: 2000,
        title: "無說明清單",
        description: "",
      },
    ]);
    expect(buffers.items).toEqual([]);
    expect(buffers.tags).toEqual([]);
  });

  it("同頁重複 sourceListId 時 last-row-wins（只留最後一列的內容）", () => {
    const rows: SourceListRow[] = [
      { sourceListId: 1000, title: "舊標題", description: "舊說明", items: [] },
      { sourceListId: 1000, title: "新標題", description: "新說明", items: [] },
    ];

    const buffers = transformPage(0, rows);

    expect(buffers.lists).toHaveLength(1);
    expect(buffers.lists[0]).toEqual({
      sourcePage: 0,
      // sourceRow 也是「最後一列」的 index（=1），而非第一次出現的位置
      sourceRow: 1,
      sourceListId: 1000,
      title: "新標題",
      description: "新說明",
    });
  });

  it("同頁重複 sourceItemId 時 last-row-wins", () => {
    const rows: SourceListRow[] = [
      {
        sourceListId: 1000,
        title: "清單",
        description: "說明",
        items: [
          { sourceItemId: 100001, title: "舊項目標題", priority: 1, tags: [] },
          { sourceItemId: 100001, title: "新項目標題", priority: 9, tags: [] },
        ],
      },
    ];

    const buffers = transformPage(0, rows);

    expect(buffers.items).toHaveLength(1);
    expect(buffers.items[0]).toEqual({
      sourcePage: 0,
      sourceRow: 0,
      sourceItemId: 100001,
      sourceListId: 1000,
      title: "新項目標題",
      priority: 9,
    });
  });

  it("同頁重複 (sourceItemId, tag) 複合鍵時 last-row-wins（同一 item 內的重複 tag 只留一列）", () => {
    const rows: SourceListRow[] = [
      {
        sourceListId: 1000,
        title: "清單",
        description: "說明",
        items: [
          {
            sourceItemId: 100001,
            title: "項目",
            priority: 1,
            tags: ["general", "general", "beta"],
          },
        ],
      },
    ];

    const buffers = transformPage(0, rows);

    // "general" 出現兩次應只留一列（複合鍵相同），"beta" 各自一列
    expect(buffers.tags).toEqual([
      { sourcePage: 0, sourceRow: 0, sourceItemId: 100001, tag: "general" },
      { sourcePage: 0, sourceRow: 0, sourceItemId: 100001, tag: "beta" },
    ]);
  });

  it("跨清單的 (sourceItemId, tag) 不會誤判為同鍵（不同 sourceItemId 不衝突）", () => {
    const rows: SourceListRow[] = [
      {
        sourceListId: 1000,
        title: "清單 A",
        description: "說明 A",
        items: [{ sourceItemId: 100001, title: "項目 A", priority: 1, tags: ["general"] }],
      },
      {
        sourceListId: 1001,
        title: "清單 B",
        description: "說明 B",
        items: [{ sourceItemId: 100101, title: "項目 B", priority: 2, tags: ["general"] }],
      },
    ];

    const buffers = transformPage(0, rows);

    expect(buffers.tags).toHaveLength(2);
    expect(buffers.tags.map((t) => t.sourceItemId)).toEqual([100001, 100101]);
  });

  it("空 rows 時三個 buffer 仍初始化為空陣列（不是 undefined）", () => {
    const buffers = transformPage(0, []);

    expect(buffers.lists).toEqual([]);
    expect(buffers.items).toEqual([]);
    expect(buffers.tags).toEqual([]);
  });
});
