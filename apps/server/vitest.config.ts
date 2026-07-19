import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // 於載入 env 前注入測試環境變數
    setupFiles: ["./src/test/setup.ts"],
    // 整合測試共用同一個 Postgres，關閉檔案層級平行以避免互相污染
    fileParallelism: false,
    // 排除 tsc -b（composite）emit 到 dist 的編譯產物，避免測試被重複執行
    exclude: [...configDefaults.exclude, "**/dist/**"],
  },
});
