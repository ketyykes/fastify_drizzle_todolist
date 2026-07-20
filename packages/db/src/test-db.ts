// 測試庫連線字串推導（單一來源）：測試 setup 與 schema 推送共用，
// 避免「換成 _test 庫」的邏輯散落多處而不一致。

/**
 * 由基礎連線字串推導「獨立測試庫」連線字串：把資料庫名稱換成 `<name>_test`。
 * 已是 `_test` 結尾則原樣回傳。其餘連線資訊（帳密、host、埠、query 參數）保留。
 */
export function resolveTestDatabaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const dbName = url.pathname.replace(/^\//, "");
  if (dbName.endsWith("_test")) {
    return baseUrl;
  }
  url.pathname = `/${dbName}_test`;
  return url.toString();
}

/**
 * 取出連線字串中的資料庫名稱（pathname 去掉開頭斜線）。
 */
export function getDatabaseNameFromUrl(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}
