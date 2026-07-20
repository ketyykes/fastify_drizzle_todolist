import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestApp } from "../test/helpers";

const app = createTestApp();

beforeEach(async () => {
  // 每個測試前把 mock 範本庫服務重置為初始狀態（mode=success、計數器歸零）
  await app.inject({ method: "POST", url: "/mock-source/reset" });
});

afterAll(async () => {
  await app.close();
});

async function setMode(mode: string) {
  return app.inject({ method: "PUT", url: "/mock-source/mode", payload: { mode } });
}

async function fetchPage(query: string) {
  return app.inject({ method: "GET", url: `/mock-source/template-catalog?${query}` });
}

describe("GET /mock-source/template-catalog：基本形狀與分頁契約", () => {
  it("回傳 rows / count，row 形狀符合規格", async () => {
    const res = await fetchPage("limit=5&offset=0");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(5);
    expect(body.rows).toHaveLength(5);

    const firstRow = body.rows[0];
    expect(firstRow.sourceListId).toBe(1000);
    expect(typeof firstRow.title).toBe("string");
    expect(typeof firstRow.description).toBe("string");
    expect(Array.isArray(firstRow.items)).toBe(true);
    expect(firstRow.items.length).toBeGreaterThan(0);

    const firstItem = firstRow.items[0];
    expect(typeof firstItem.sourceItemId).toBe("number");
    expect(typeof firstItem.title).toBe("string");
    expect(typeof firstItem.priority).toBe("number");
    expect(Array.isArray(firstItem.tags)).toBe(true);
  });

  it("sourceListId = 1000 + 索引；每清單項目數 = (i % 5) + 2；sourceItemId = sourceListId*100+j", async () => {
    const res = await fetchPage("limit=6&offset=0");
    const rows = res.json().rows;

    // i=0 → sourceListId=1000, itemCount=(0%5)+2=2
    expect(rows[0].sourceListId).toBe(1000);
    expect(rows[0].items).toHaveLength(2);
    expect(rows[0].items[0].sourceItemId).toBe(100000);
    expect(rows[0].items[1].sourceItemId).toBe(100001);

    // i=3 → sourceListId=1003, itemCount=(3%5)+2=5
    expect(rows[3].sourceListId).toBe(1003);
    expect(rows[3].items).toHaveLength(5);

    // i=5 → sourceListId=1005, itemCount=(5%5)+2=2（週期回到 2）
    expect(rows[5].sourceListId).toBe(1005);
    expect(rows[5].items).toHaveLength(2);
  });

  it("priority = (j*7) % 10", async () => {
    const res = await fetchPage("limit=1&offset=3&total=10");
    const row = res.json().rows[0];
    // i=3 → itemCount=5 個項目，j=0..4
    expect(row.items.map((it: { priority: number }) => it.priority)).toEqual([0, 7, 4, 1, 8]);
  });

  it("中段整頁：rows 長度 = limit，count = limit", async () => {
    const res = await fetchPage("limit=50&offset=0&total=120");
    const body = res.json();
    expect(body.rows).toHaveLength(50);
    expect(body.count).toBe(50);
  });

  it("尾頁：資料不足 limit 時 count < limit", async () => {
    const res = await fetchPage("limit=50&offset=100&total=120");
    const body = res.json();
    expect(body.rows).toHaveLength(20);
    expect(body.count).toBe(20);
  });

  it("剛好整除後的下一頁為空頁（count=0）", async () => {
    const full = await fetchPage("limit=25&offset=75&total=100");
    expect(full.json().rows).toHaveLength(25);
    expect(full.json().count).toBe(25);

    const empty = await fetchPage("limit=25&offset=100&total=100");
    expect(empty.json().rows).toHaveLength(0);
    expect(empty.json().count).toBe(0);
  });

  it("total 預設 120：offset 落在 120 之外回空頁", async () => {
    const res = await fetchPage("limit=10&offset=120");
    const body = res.json();
    expect(body.rows).toHaveLength(0);
    expect(body.count).toBe(0);
  });

  it("total 可覆寫縮小資料集", async () => {
    const res = await fetchPage("limit=100&offset=0&total=3");
    const body = res.json();
    expect(body.rows).toHaveLength(3);
    expect(body.count).toBe(3);
    expect(body.rows.map((r: { sourceListId: number }) => r.sourceListId)).toEqual([
      1000, 1001, 1002,
    ]);
  });
});

describe("GET /mock-source/template-catalog：決定性", () => {
  it("同樣的查詢參數呼叫兩次，結果完全相同", async () => {
    const first = await fetchPage("limit=10&offset=20&total=120");
    const second = await fetchPage("limit=10&offset=20&total=120");
    expect(second.json()).toEqual(first.json());
  });

  it("標籤從固定 12 名稱池以索引算術選出，且跨清單會重複", async () => {
    const res = await fetchPage("limit=120&offset=0&total=120");
    const rows = res.json().rows;
    const allTags = new Set<string>();
    for (const row of rows) {
      for (const item of row.items) {
        for (const tag of item.tags) {
          allTags.add(tag);
        }
      }
    }
    // 標籤池只有 12 個名稱，資料量遠大於 12，代表跨清單重複使用同一批標籤
    expect(allTags.size).toBeLessThanOrEqual(12);
    expect(allTags.size).toBeGreaterThan(0);
  });
});

describe("GET /mock-source/template-catalog：overlap 行為", () => {
  it("overlap=1 時第一頁（offset=0）不受影響", async () => {
    const withOverlap = await fetchPage("limit=10&offset=0&overlap=1&total=120");
    const withoutOverlap = await fetchPage("limit=10&offset=0&overlap=0&total=120");
    expect(withOverlap.json()).toEqual(withoutOverlap.json());
  });

  it("overlap=1 時第 2 頁起，頁首多出前一頁最後一列", async () => {
    const page1 = await fetchPage("limit=10&offset=0&overlap=0&total=120");
    const page2WithOverlap = await fetchPage("limit=10&offset=10&overlap=1&total=120");
    const page2WithoutOverlap = await fetchPage("limit=10&offset=10&overlap=0&total=120");

    const page1Rows = page1.json().rows;
    const page2OverlapRows = page2WithOverlap.json().rows;
    const page2PlainRows = page2WithoutOverlap.json().rows;

    // 多塞一列，不是佔用 limit 名額
    expect(page2OverlapRows).toHaveLength(11);
    expect(page2OverlapRows[0]).toEqual(page1Rows[page1Rows.length - 1]);
    // 其餘列與不重疊版本相同
    expect(page2OverlapRows.slice(1)).toEqual(page2PlainRows);
  });

  it("overlap=1 不會讓分頁停不下來：尾頁 count 仍小於 limit", async () => {
    // total=100, limit=25 → 頁界為 0,25,50,75,100；offset=100 是超出資料集的下一頁
    const tailWithOverlap = await fetchPage("limit=25&offset=100&overlap=1&total=100");
    const body = tailWithOverlap.json();
    // 頁首會塞入 index 99 的重複列，但列數仍遠小於 limit，分頁判斷仍會終止
    expect(body.rows.length).toBeLessThan(25);
    expect(body.count).toBeLessThan(25);
  });
});

describe("PUT /mock-source/mode", () => {
  it("預設 mode 為 success，可正常取得資料", async () => {
    const res = await fetchPage("limit=5&offset=0");
    expect(res.statusCode).toBe(200);
  });

  it("非法 mode 值回傳 400，且不影響目前模式", async () => {
    const res = await setMode("not-a-mode");
    expect(res.statusCode).toBe(400);

    // 模式仍是 success，資料照常回傳
    const followUp = await fetchPage("limit=5&offset=0");
    expect(followUp.statusCode).toBe(200);
  });

  it("fail 模式：所有頁一律 500", async () => {
    await setMode("fail");
    const page0 = await fetchPage("limit=10&offset=0");
    const page1 = await fetchPage("limit=10&offset=10");
    expect(page0.statusCode).toBe(500);
    expect(page1.statusCode).toBe(500);
  });

  it("fail_page_2 模式：只有 pageIndex===2 恆 500，其餘頁正常，重試也失敗", async () => {
    await setMode("fail_page_2");
    const page0 = await fetchPage("limit=10&offset=0");
    const page1 = await fetchPage("limit=10&offset=10");
    const page2First = await fetchPage("limit=10&offset=20");
    const page2Retry = await fetchPage("limit=10&offset=20");
    const page3 = await fetchPage("limit=10&offset=30");

    expect(page0.statusCode).toBe(200);
    expect(page1.statusCode).toBe(200);
    expect(page2First.statusCode).toBe(500);
    expect(page2Retry.statusCode).toBe(500);
    expect(page3.statusCode).toBe(200);
  });

  it("flaky_page_2 模式：pageIndex===2 第一次 500，之後成功", async () => {
    await setMode("flaky_page_2");
    const page2FirstAttempt = await fetchPage("limit=10&offset=20");
    const page2SecondAttempt = await fetchPage("limit=10&offset=20");
    const page2ThirdAttempt = await fetchPage("limit=10&offset=20");

    expect(page2FirstAttempt.statusCode).toBe(500);
    expect(page2SecondAttempt.statusCode).toBe(200);
    expect(page2SecondAttempt.json().rows).toHaveLength(10);
    expect(page2ThirdAttempt.statusCode).toBe(200);
  });

  it("empty 模式：回 0 列，不受 overlap/total 影響", async () => {
    await setMode("empty");
    const res = await fetchPage("limit=10&offset=20&overlap=1&total=120");
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.rows).toEqual([]);
    expect(body.count).toBe(0);
  });
});

describe("POST /mock-source/reset", () => {
  it("把 mode 重置回 success", async () => {
    await setMode("fail");
    const resetRes = await app.inject({ method: "POST", url: "/mock-source/reset" });
    expect(resetRes.statusCode).toBe(200);

    const res = await fetchPage("limit=5&offset=0");
    expect(res.statusCode).toBe(200);
  });

  it("把 flaky_page_2 的重試計數器也歸零", async () => {
    await setMode("flaky_page_2");
    // 觸發一次失敗，計數器變成 1
    const firstAttempt = await fetchPage("limit=10&offset=20");
    expect(firstAttempt.statusCode).toBe(500);

    await app.inject({ method: "POST", url: "/mock-source/reset" });
    await setMode("flaky_page_2");

    // reset 後計數器歸零，重新從第一次失敗開始
    const afterResetFirstAttempt = await fetchPage("limit=10&offset=20");
    expect(afterResetFirstAttempt.statusCode).toBe(500);

    const afterResetSecondAttempt = await fetchPage("limit=10&offset=20");
    expect(afterResetSecondAttempt.statusCode).toBe(200);
  });
});

describe("查詢參數驗證：無效參數回 400", () => {
  it.each([
    ["limit=0"],
    ["limit=-1"],
    ["limit=abc"],
    ["limit=10&offset=-1"],
    ["limit=10&overlap=2"],
    ["limit=10&total=0"],
    ["limit=10&total=-5"],
  ])("%s → 400", async (query) => {
    const res = await fetchPage(query);
    expect(res.statusCode).toBe(400);
  });
});
