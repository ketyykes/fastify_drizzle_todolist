import {
  getDatabaseNameFromUrl,
  resolveTestDatabaseUrl,
} from "@fastify_drizzle_todolist/db/test-db";
import { describe, expect, it } from "vitest";

describe("resolveTestDatabaseUrl", () => {
  it("把資料庫名稱換成 <name>_test，並保留帳密／host／埠", () => {
    const result = resolveTestDatabaseUrl(
      "postgresql://postgres:secret@localhost:5432/fastify_drizzle_todolist",
    );
    expect(result).toBe(
      "postgresql://postgres:secret@localhost:5432/fastify_drizzle_todolist_test",
    );
  });

  it("已是 _test 結尾時原樣回傳（不重複加後綴）", () => {
    const url = "postgresql://postgres:secret@localhost:5432/app_test";
    expect(resolveTestDatabaseUrl(url)).toBe(url);
  });

  it("保留 query 參數（例如 sslmode）", () => {
    const result = resolveTestDatabaseUrl(
      "postgresql://u:p@db.example.com:5432/app?sslmode=require",
    );
    expect(result).toBe("postgresql://u:p@db.example.com:5432/app_test?sslmode=require");
  });
});

describe("getDatabaseNameFromUrl", () => {
  it("取出連線字串中的資料庫名稱", () => {
    expect(getDatabaseNameFromUrl("postgresql://postgres:x@localhost:5432/my_db")).toBe("my_db");
  });
});
