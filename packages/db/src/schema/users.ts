import { pgEnum, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// RBAC 角色的唯一真實來源：pgEnum、Zod 驗證與 UserRole 型別都由此推導，
// 避免多處硬編角色清單而悄悄漂移。新增角色時只改這一行。
export const USER_ROLES = ["admin", "user"] as const;

// DB 端對應 PostgreSQL enum type `user_role`
export const userRoleEnum = pgEnum("user_role", USER_ROLES);

// 由列舉值推導出角色字面量聯集型別："admin" | "user"
export type UserRole = (typeof USER_ROLES)[number];

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  // 儲存 bcrypt 雜湊，非明文
  password: text("password").notNull(),
  // RBAC 角色，預設為一般使用者；權限判斷以此欄位為準
  role: userRoleEnum("role").notNull().default("user"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
