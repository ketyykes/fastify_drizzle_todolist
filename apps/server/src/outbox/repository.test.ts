import { db, outboxMessages, todos, users } from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { resetDb } from "../test/helpers";
import {
  claimDueBatch,
  enqueueOutbox,
  getOutboxStats,
  markDone,
  markFailed,
  pruneDone,
  recoverStaleProcessing,
  requeueDead,
} from "./repository";

beforeEach(async () => {
  await resetDb();
});

/**
 * 建立一個使用者與一筆 todo，回傳 todo id，供需要合法 refId 的測試使用。
 */
async function insertUserAndTodo(email: string, title = "todo") {
  const [user] = await db
    .insert(users)
    .values({ email, password: "hashed" })
    .returning({ id: users.id });
  if (!user) {
    throw new Error("建立測試使用者失敗");
  }
  const [todo] = await db
    .insert(todos)
    .values({ userId: user.id, title })
    .returning({ id: todos.id });
  if (!todo) {
    throw new Error("建立測試 todo 失敗");
  }
  return todo.id;
}

/**
 * 直接寫入一筆 outbox 訊息（略過 enqueueOutbox 的交易限制），供測試佈置初始狀態用。
 */
async function insertOutboxRow(overrides: Partial<typeof outboxMessages.$inferInsert> = {}) {
  const [row] = await db
    .insert(outboxMessages)
    .values({
      topic: "todo.completed",
      refId: 1,
      ...overrides,
    })
    .returning();
  if (!row) {
    throw new Error("建立測試 outbox 訊息失敗");
  }
  return row;
}

describe("enqueueOutbox", () => {
  it("必須在交易內執行 insert，並回傳新列 id", async () => {
    const refId = await insertUserAndTodo("enqueue@example.com");

    const id = await db.transaction(async (tx) => {
      return enqueueOutbox(tx, { topic: "todo.completed", refId });
    });

    const [row] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, id));
    expect(row?.topic).toBe("todo.completed");
    expect(row?.refId).toBe(refId);
    expect(row?.action).toBe("sync");
    expect(row?.status).toBe("pending");
  });
});

describe("claimDueBatch", () => {
  it("排除未到期與非 pending 的列，只認領到期的 pending", async () => {
    const now = new Date();
    const due = await insertOutboxRow({
      refId: 1,
      status: "pending",
      nextAttemptAt: new Date(now.getTime() - 1000),
    });
    await insertOutboxRow({
      refId: 2,
      status: "pending",
      nextAttemptAt: new Date(now.getTime() + 60_000), // 未到期
    });
    await insertOutboxRow({ refId: 3, status: "processing" });
    await insertOutboxRow({ refId: 4, status: "done" });
    await insertOutboxRow({ refId: 5, status: "dead" });

    const claimed = await claimDueBatch(100);

    expect(claimed.map((row) => row.id)).toEqual([due.id]);
  });

  it("認領後狀態轉為 processing 並記錄 locked_at", async () => {
    const row = await insertOutboxRow({ refId: 1, status: "pending" });

    const claimed = await claimDueBatch(100);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe("processing");
    expect(claimed[0]?.lockedAt).not.toBeNull();

    const [persisted] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, row.id));
    expect(persisted?.status).toBe("processing");
    expect(persisted?.lockedAt).not.toBeNull();
  });

  it("依 id 由舊到新排序", async () => {
    const first = await insertOutboxRow({ refId: 1, status: "pending" });
    const second = await insertOutboxRow({ refId: 2, status: "pending" });
    const third = await insertOutboxRow({ refId: 3, status: "pending" });

    const claimed = await claimDueBatch(100);

    expect(claimed.map((row) => row.id)).toEqual([first.id, second.id, third.id]);
  });

  it("遵守 limit 上限", async () => {
    await insertOutboxRow({ refId: 1, status: "pending" });
    await insertOutboxRow({ refId: 2, status: "pending" });
    await insertOutboxRow({ refId: 3, status: "pending" });

    const claimed = await claimDueBatch(2);

    expect(claimed).toHaveLength(2);
  });
});

describe("recoverStaleProcessing", () => {
  it("卡住超過 15 分鐘的 processing 退回 pending 並清除 locked_at", async () => {
    const staleAt = new Date(Date.now() - 20 * 60_000);
    const stale = await insertOutboxRow({ refId: 1, status: "processing", lockedAt: staleAt });

    const recovered = await recoverStaleProcessing();

    expect(recovered).toBe(1);
    const [persisted] = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, stale.id));
    expect(persisted?.status).toBe("pending");
    expect(persisted?.lockedAt).toBeNull();
  });

  it("未卡住（15 分鐘內）的 processing 不受影響", async () => {
    const recentAt = new Date(Date.now() - 5 * 60_000);
    const fresh = await insertOutboxRow({ refId: 1, status: "processing", lockedAt: recentAt });

    const recovered = await recoverStaleProcessing();

    expect(recovered).toBe(0);
    const [persisted] = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, fresh.id));
    expect(persisted?.status).toBe("processing");
  });

  it("非 processing 狀態不受影響", async () => {
    const staleAt = new Date(Date.now() - 20 * 60_000);
    await insertOutboxRow({ refId: 1, status: "pending", lockedAt: staleAt });

    const recovered = await recoverStaleProcessing();

    expect(recovered).toBe(0);
  });
});

describe("markDone", () => {
  it("標記為 done 並清除 locked_at", async () => {
    const row = await insertOutboxRow({ refId: 1, status: "processing", lockedAt: new Date() });

    await markDone(row.id);

    const [persisted] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, row.id));
    expect(persisted?.status).toBe("done");
    expect(persisted?.lockedAt).toBeNull();
  });
});

describe("markFailed", () => {
  it("未達上限：attempts+1、退回 pending、依查表設定 next_attempt_at", async () => {
    const row = await insertOutboxRow({
      refId: 1,
      status: "processing",
      attempts: 0,
      maxAttempts: 8,
      lockedAt: new Date(),
    });

    const outcome = await markFailed(row, "連線逾時");

    expect(outcome).toBe("retried");
    const [persisted] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, row.id));
    expect(persisted?.status).toBe("pending");
    expect(persisted?.attempts).toBe(1);
    expect(persisted?.lastError).toBe("連線逾時");
    expect(persisted?.lockedAt).toBeNull();
    // 第 1 次失敗 → 等待 1 分鐘
    expect(persisted?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(persisted?.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000 + 5_000);
  });

  it("達上限：轉 dead", async () => {
    const row = await insertOutboxRow({
      refId: 1,
      status: "processing",
      attempts: 7,
      maxAttempts: 8,
      lockedAt: new Date(),
    });

    const outcome = await markFailed(row, "外部服務持續 500");

    expect(outcome).toBe("dead");
    const [persisted] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, row.id));
    expect(persisted?.status).toBe("dead");
    expect(persisted?.attempts).toBe(8);
    expect(persisted?.lastError).toBe("外部服務持續 500");
    expect(persisted?.lockedAt).toBeNull();
  });
});

describe("requeueDead", () => {
  it("指定 id：只重排指定的 dead 訊息並重置欄位", async () => {
    const a = await insertOutboxRow({
      refId: 1,
      status: "dead",
      attempts: 8,
      lastError: "boom-a",
      lockedAt: new Date(),
    });
    const b = await insertOutboxRow({
      refId: 2,
      status: "dead",
      attempts: 8,
      lastError: "boom-b",
      lockedAt: new Date(),
    });

    const requeued = await requeueDead([a.id]);

    expect(requeued).toBe(1);
    const [persistedA] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, a.id));
    expect(persistedA?.status).toBe("pending");
    expect(persistedA?.attempts).toBe(0);
    expect(persistedA?.lastError).toBeNull();
    expect(persistedA?.lockedAt).toBeNull();
    expect(persistedA?.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const [persistedB] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, b.id));
    expect(persistedB?.status).toBe("dead");
    expect(persistedB?.attempts).toBe(8);
  });

  it("省略 id：重排全部 dead 訊息", async () => {
    const a = await insertOutboxRow({ refId: 1, status: "dead", attempts: 8 });
    const b = await insertOutboxRow({ refId: 2, status: "dead", attempts: 8 });
    await insertOutboxRow({ refId: 3, status: "pending" });

    const requeued = await requeueDead();

    expect(requeued).toBe(2);
    const [persistedA] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, a.id));
    const [persistedB] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, b.id));
    expect(persistedA?.status).toBe("pending");
    expect(persistedB?.status).toBe("pending");
  });
});

describe("pruneDone", () => {
  it("只硬刪過期的 done，dead/pending/processing 一律保留", async () => {
    const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const recently = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

    const expiredDone = await insertOutboxRow({ refId: 1, status: "done", updatedAt: longAgo });
    const freshDone = await insertOutboxRow({ refId: 2, status: "done", updatedAt: recently });
    const oldDead = await insertOutboxRow({ refId: 3, status: "dead", updatedAt: longAgo });
    const oldPending = await insertOutboxRow({ refId: 4, status: "pending", updatedAt: longAgo });

    const pruned = await pruneDone(30);

    expect(pruned).toBe(1);
    const remainingIds = (await db.select({ id: outboxMessages.id }).from(outboxMessages)).map(
      (row) => row.id,
    );
    expect(remainingIds).not.toContain(expiredDone.id);
    expect(remainingIds).toContain(freshDone.id);
    expect(remainingIds).toContain(oldDead.id);
    expect(remainingIds).toContain(oldPending.id);
  });
});

describe("getOutboxStats", () => {
  it("回傳各狀態計數與最近 20 列（id desc）", async () => {
    await insertOutboxRow({ refId: 1, status: "pending" });
    await insertOutboxRow({ refId: 2, status: "processing" });
    await insertOutboxRow({ refId: 3, status: "done" });
    await insertOutboxRow({ refId: 4, status: "done" });
    await insertOutboxRow({ refId: 5, status: "dead" });

    const stats = await getOutboxStats();

    expect(stats.counts).toEqual({ pending: 1, processing: 1, done: 2, dead: 1 });
    expect(stats.recent[0]?.refId).toBe(5);
    expect(stats.recent).toHaveLength(5);
  });
});
