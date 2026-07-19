import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  // 儲存 bcrypt 雜湊，非明文
  password: text("password").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
