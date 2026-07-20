// 測試環境變數注入。此檔於任何模組載入 env 之前執行（vitest setupFiles）。
// JWT_SECRET 於 apps/server/.env 未提供，於此注入；
// CORS_ORIGIN 給一個合法預設以通過 env 驗證；
// DATABASE_URL 一律改指向「獨立測試庫」，避免 resetDb 的 TRUNCATE 清空開發庫。
import { config } from "dotenv";

import {
  getDatabaseNameFromUrl,
  resolveTestDatabaseUrl,
} from "@fastify_drizzle_todolist/db/test-db";

// 先載入 apps/server/.env（dotenv 預設不覆蓋既有環境變數），取得基礎 DATABASE_URL
config();

process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.CORS_ORIGIN ??= "http://localhost:5173";
process.env.NODE_ENV ??= "test";

// 測試一律連到獨立測試庫（<db>_test）。可用 TEST_DATABASE_URL 明確覆寫，
// 否則由開發用的 DATABASE_URL 自動推導。
const baseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!baseUrl) {
  throw new Error("測試需要 DATABASE_URL（或 TEST_DATABASE_URL）才能連到測試庫");
}
const testUrl = process.env.TEST_DATABASE_URL ?? resolveTestDatabaseUrl(baseUrl);

// 執行期防呆：測試庫名稱必須以 _test 結尾，否則中止——避免誤連開發／正式庫而被 TRUNCATE 清空。
// 【請勿移除此防呆】它是「測試不會洗掉開發庫」的最後一道防線。
const testDbName = getDatabaseNameFromUrl(testUrl);
if (!testDbName.endsWith("_test")) {
  throw new Error(`拒絕在非測試庫上跑測試：「${testDbName}」（資料庫名稱必須以 _test 結尾）`);
}

// 覆寫 DATABASE_URL；稍後 env 模組載入時的 dotenv/config 不會再蓋掉已存在的值
process.env.DATABASE_URL = testUrl;
