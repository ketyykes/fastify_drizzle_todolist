import type { FastifyInstance } from "fastify";
import { z } from "zod";

// mock 外部範本庫（template catalog provider）：無認證，狀態存 process 內記憶體，
// 供測試／教學觀察與模式切換使用（比照 mock-external.ts 的寫法）。
//
// 資料集採「決定性生成」（純函式，禁用 Math.random / Date.now）：同一組查詢參數
// 不論呼叫幾次都回傳完全相同的內容，這是 staging-sync 教學範例能在測試中穩定
// 重播（重試、swap 失敗後重播……）的關鍵前提。

// 清單總量預設值，可用 ?total= 覆寫（測試用來縮小資料集）
const DEFAULT_TOTAL = 120;

// 固定 12 個標籤名稱池，跨清單重複使用（示範合併時「跨頁重複資料」的情境）
const TAG_POOL = [
  "general",
  "priority",
  "review",
  "draft",
  "archived",
  "featured",
  "internal",
  "external",
  "beta",
  "legacy",
  "urgent",
  "reference",
] as const;

type MockSourceMode = "success" | "fail" | "fail_page_2" | "flaky_page_2" | "empty";

interface MockTemplateItem {
  sourceItemId: number;
  title: string;
  priority: number;
  tags: string[];
}

interface MockTemplateListRow {
  sourceListId: number;
  title: string;
  description: string;
  items: MockTemplateItem[];
}

// process 內狀態：目前模式、flaky_page_2 第 2 頁的重試計數器
let mode: MockSourceMode = "success";
let flakyPage2Attempts = 0;

const modeSchema = z.object({
  mode: z.enum(["success", "fail", "fail_page_2", "flaky_page_2", "empty"]),
});

const templateCatalogQuerySchema = z.object({
  limit: z.coerce.number().int().positive().default(20),
  offset: z.coerce.number().int().min(0).default(0),
  // 0 或 1；zod 用 min/max 限制範圍，非 0/1 一律視為無效參數
  overlap: z.coerce.number().int().min(0).max(1).default(0),
  total: z.coerce.number().int().positive().optional(),
});

/**
 * 依索引 i（0-based，等同該筆在資料集中的位置）決定性產生一筆範本清單
 * （含巢狀項目與標籤）。純函式：同一個 i 永遠回傳完全相同的內容。
 */
function generateList(i: number): MockTemplateListRow {
  const sourceListId = 1000 + i;
  const itemCount = (i % 5) + 2;

  const items: MockTemplateItem[] = [];
  for (let j = 0; j < itemCount; j++) {
    const sourceItemId = sourceListId * 100 + j;
    const priority = (j * 7) % 10;

    // 0~3 個標籤，索引以 (i+j) 與 sourceItemId 做算術決定，跨清單會重複選到同一批標籤
    const tagCount = (i + j) % 4;
    const tagStart = sourceItemId % TAG_POOL.length;
    const tags: string[] = [];
    for (let k = 0; k < tagCount; k++) {
      // 索引恆落在 [0, TAG_POOL.length) 範圍內，故此處保證非 undefined
      const tag = TAG_POOL[(tagStart + k) % TAG_POOL.length];
      if (tag !== undefined) {
        tags.push(tag);
      }
    }

    items.push({
      sourceItemId,
      title: `項目 ${sourceItemId}`,
      priority,
      tags,
    });
  }

  return {
    sourceListId,
    title: `範本清單 ${sourceListId}`,
    description: `這是第 ${sourceListId} 號範本清單的說明文字`,
    items,
  };
}

/**
 * 依 offset/limit 切出一頁資料。overlap=true 時，offset>0 的頁會在頁首多塞一列
 * 「上一頁的最後一列」，模擬 offset 分頁在 live 資料上的微漂移。
 *
 * 實作選擇（重複列「多塞」而非「佔用 limit 名額」）：
 * - rows 長度在有 overlap 時可能是 limit+1，count 一律等於 rows.length；
 * - 這樣重複列不會讓 count 意外小於 limit、被分頁邏輯誤判成尾頁而提早停止；
 * - 尾頁（真實資料不足 limit）時，即使多塞一列，count 通常仍 < limit，
 *   分頁一樣能正常終止，不會無限分頁下去（見同名測試鎖住此行為）。
 */
function getPage(
  offset: number,
  limit: number,
  overlap: boolean,
  total: number,
): MockTemplateListRow[] {
  const start = Math.min(offset, total);
  const end = Math.min(offset + limit, total);

  const rows: MockTemplateListRow[] = [];
  for (let i = start; i < end; i++) {
    rows.push(generateList(i));
  }

  if (overlap && offset > 0 && offset - 1 < total) {
    rows.unshift(generateList(offset - 1));
  }

  return rows;
}

/**
 * 測試專用：把 mock 範本庫服務的記憶體狀態（mode／重試計數器）重置為初始值。
 */
export function resetMockSourceState(): void {
  mode = "success";
  flakyPage2Attempts = 0;
}

export async function mockSourceRoutes(app: FastifyInstance) {
  app.get("/mock-source/template-catalog", async (request, reply) => {
    const parsed = templateCatalogQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid query parameters" });
    }
    const { limit, offset, overlap, total } = parsed.data;

    if (mode === "fail") {
      return reply.code(500).send({ error: "mock source failure" });
    }

    if (mode === "empty") {
      return reply.send({ rows: [], count: 0 });
    }

    // pageIndex 定義：floor(offset / limit)，與 staging-sync fetcher 的分頁邏輯一致
    const pageIndex = Math.floor(offset / limit);

    if (mode === "fail_page_2" && pageIndex === 2) {
      return reply.code(500).send({ error: "mock source failure (page 2)" });
    }

    if (mode === "flaky_page_2" && pageIndex === 2) {
      flakyPage2Attempts += 1;
      if (flakyPage2Attempts === 1) {
        return reply
          .code(500)
          .send({ error: "mock source flaky failure (page 2, first attempt)" });
      }
      // 第二次（含）以後視為重試成功，繼續往下走正常回傳資料
    }

    const datasetTotal = total ?? DEFAULT_TOTAL;
    const rows = getPage(offset, limit, overlap === 1, datasetTotal);

    return reply.send({ rows, count: rows.length });
  });

  app.put("/mock-source/mode", async (request, reply) => {
    const parsed = modeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid mode" });
    }
    mode = parsed.data.mode;
    return reply.send({ mode });
  });

  app.post("/mock-source/reset", async () => {
    resetMockSourceState();
    return { ok: true };
  });
}
