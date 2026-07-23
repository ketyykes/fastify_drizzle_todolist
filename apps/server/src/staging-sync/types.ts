// staging-sync 管線各階段共用的資料形狀（單一事實來源）：
// page-fetcher 產出 SourcePage → page-transformer 轉成 PageBuffers →
// staging-writer 寫入 staging 表。三個模組平行開發時以本檔為介面契約。

/** 來源 API 回傳的巢狀項目（原始形狀，來自 mock-source /template-catalog） */
export interface SourceItemRow {
  sourceItemId: number;
  title: string;
  priority: number;
  tags: string[];
}

/** 來源 API 回傳的單筆範本清單（原始形狀，含巢狀項目與標籤） */
export interface SourceListRow {
  sourceListId: number;
  title: string;
  description: string;
  items: SourceItemRow[];
}

/** page-fetcher 一次 yield 的一頁資料 */
export interface SourcePage {
  /** 0-based 頁序（floor(offset / pageSize)） */
  pageIndex: number;
  /** 本頁請求時使用的 offset */
  offset: number;
  rows: SourceListRow[];
  /** 來源回傳的 count（＝rows.length；overlap 模式下可能為 pageSize+1） */
  count: number;
}

// 以下三種 buffer row 對齊 staging 表的 payload 欄位（不含 syncRunId——
// 由 staging-writer 寫入時補上）；sourcePage/sourceRow 為除錯欄位。

export interface StagingListBufferRow {
  sourcePage: number;
  sourceRow: number;
  sourceListId: number;
  title: string;
  description: string | null;
}

export interface StagingItemBufferRow {
  sourcePage: number;
  sourceRow: number;
  sourceItemId: number;
  sourceListId: number;
  title: string;
  priority: number;
}

export interface StagingTagBufferRow {
  sourcePage: number;
  sourceRow: number;
  sourceItemId: number;
  tag: string;
}

/**
 * page-transformer 對「一頁」的產出：三個 buffer 皆已在頁內以 conflict key
 * 去重（last-row-wins）。即使該頁沒有任何資料，三個陣列也必須初始化為空陣列。
 */
export interface PageBuffers {
  lists: StagingListBufferRow[];
  items: StagingItemBufferRow[];
  tags: StagingTagBufferRow[];
}
