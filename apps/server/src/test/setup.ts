// 測試環境變數注入。此檔於任何模組載入 env 之前執行（vitest setupFiles）。
// JWT_SECRET 於 apps/server/.env 未提供，於此注入；
// CORS_ORIGIN 給一個合法預設以通過 env 驗證；
// DATABASE_URL 交由 apps/server/.env（dotenv）提供，此處不覆蓋。
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.CORS_ORIGIN ??= "http://localhost:5173";
