import type {
  PageBuffers,
  SourceListRow,
  StagingItemBufferRow,
  StagingListBufferRow,
  StagingTagBufferRow,
} from "./types";

// page-transformer：把 page-fetcher 抓回來的「一頁」巢狀 rows 攤平成三個
// staging buffer（lists／items／tags）。純函式、不碰資料庫、不做任何 I/O——
// 只負責「形狀轉換＋頁內去重」，讓 staging-writer 可以直接拿 buffer 去批次寫入。
//
// 去重規則：**頁內**以 conflict key 去重、last-row-wins（用 Map 實作：後面的列
// 蓋過前面同 key 的列）。之所以要在這一層就去重，是因為同一頁理論上可能出現
// 重複的業務鍵（例如上游資料本身有重複、或未來 overlap 情境延伸到單頁內），
// staging-writer 對 (syncRunId, 業務鍵) 做 UPSERT 前，同一批 chunk insert 裡不能
// 有重複鍵，否則會撞 ON CONFLICT 的「同一陳述式內重複更新同一列」錯誤。
// 跨頁的重複則留給 staging-writer 的 ON CONFLICT DO UPDATE 處理（那才是真正的
// 跨頁 last-row-wins）。

/**
 * 將單一分頁的巢狀 rows 攤平成三個 staging buffer。
 *
 * @param pageIndex 這一頁的頁序（透傳到每個 buffer row 的 sourcePage 除錯欄位）
 * @param rows 這一頁的原始巢狀資料（來自 page-fetcher 的 SourcePage.rows）
 */
export function transformPage(pageIndex: number, rows: SourceListRow[]): PageBuffers {
  const listsByKey = new Map<number, StagingListBufferRow>();
  const itemsByKey = new Map<number, StagingItemBufferRow>();
  const tagsByKey = new Map<string, StagingTagBufferRow>();

  rows.forEach((row, sourceRow) => {
    // 清單本身：conflict key = sourceListId
    listsByKey.set(row.sourceListId, {
      sourcePage: pageIndex,
      sourceRow,
      sourceListId: row.sourceListId,
      title: row.title,
      // description 來源給什麼存什麼（含空字串），不做任何轉換或補預設值。
      description: row.description,
    });

    for (const item of row.items) {
      // 項目：conflict key = sourceItemId；沿用所屬清單的 sourceRow（除錯用，
      // 代表這筆項目是跟著哪一列清單一起從來源撈回來的）。
      itemsByKey.set(item.sourceItemId, {
        sourcePage: pageIndex,
        sourceRow,
        sourceItemId: item.sourceItemId,
        sourceListId: row.sourceListId,
        title: item.title,
        priority: item.priority,
      });

      for (const tag of item.tags) {
        // 標籤：複合 conflict key = (sourceItemId, tag)，用空白組字串當 Map key。
        const tagKey = `${item.sourceItemId} ${tag}`;
        tagsByKey.set(tagKey, {
          sourcePage: pageIndex,
          sourceRow,
          sourceItemId: item.sourceItemId,
          tag,
        });
      }
    }
  });

  // 即使該頁沒有任何資料（rows 為空陣列），三個 buffer 也必須初始化為空陣列，
  // 不可省略——staging-writer 依賴這個保證，才能安全地對「空 buffer」跳過批次寫入。
  return {
    lists: Array.from(listsByKey.values()),
    items: Array.from(itemsByKey.values()),
    tags: Array.from(tagsByKey.values()),
  };
}
