import {
  db,
  syncRuns,
  templateItems,
  templateItemTags,
  templateLists,
  users,
} from "@fastify_drizzle_todolist/db";
import { asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { idParamSchema } from "../schemas";
import { ActiveSyncRunError, LockConflictError, LockError } from "../staging-sync/errors";
import { abandon } from "../staging-sync/run-manager";
import { runTemplateCatalogSync } from "../staging-sync/dispatcher";

// staging-sync 的 admin 管理端點：比照 outbox-admin.ts 的寫法，全部端點都需登入
// （app.authenticate）。四支端點對應設計簡報 §9：
//   - POST /staging-sync/trigger：手動觸發一次同步
//   - GET  /staging-sync/runs：查最近幾輪的執行狀況（消毒過，絕不含 owner_token）
//   - POST /staging-sync/runs/:id/abandon：人工放棄一個卡在 staged 的 run
//   - GET  /staging-sync/catalog：查目前 active 的範本目錄巢狀內容（教學頁展示用）

type SyncRunRow = typeof syncRuns.$inferSelect;

/**
 * 消毒錯誤訊息：只保留「錯誤類別名: 訊息前 300 字」，不把完整 response
 * body／payload／token 回給呼叫端（見設計簡報 §6，與 run-manager.ts 的同名
 * private helper用途一致，各自獨立一份不互相依賴）。
 */
function sanitizeErrorForResponse(error: unknown): string {
  const className = error instanceof Error ? error.constructor.name : typeof error;
  const rawMessage = error instanceof Error ? error.message : String(error);
  return `${className}: ${rawMessage.slice(0, 300)}`;
}

/**
 * 把 sync_runs 的一列轉成對外輸出的形狀：逐欄位列舉，刻意不整列 spread——
 * owner_token 這個內部 fencing 憑證絕對不能外洩到 HTTP 回應（見設計簡報
 * §9「不含 owner_token」）。lease_version／lock_backend_pid 屬於觀測用途，
 * 可以給。
 */
function toRunView(run: SyncRunRow) {
  return {
    id: run.id,
    syncType: run.syncType,
    phase: run.phase,
    resultCode: run.resultCode,
    lastErrorPhase: run.lastErrorPhase,
    errorMessage: run.errorMessage,
    lastOffset: run.lastOffset,
    pageCount: run.pageCount,
    sourceCount: run.sourceCount,
    stagedCounts: run.stagedCounts,
    // 峰值記憶體是本範例的主題觀測資料（「分批的是記憶體」的實證），一併輸出
    peakMemoryBytes: run.peakMemoryBytes,
    fetchSeconds: run.fetchSeconds !== null ? Number(run.fetchSeconds) : null,
    swapSeconds: run.swapSeconds !== null ? Number(run.swapSeconds) : null,
    swapAttempts: run.swapAttempts,
    leaseVersion: run.leaseVersion,
    lockBackendPid: run.lockBackendPid,
    heartbeatAt: run.heartbeatAt,
    startedAt: run.startedAt,
    stagedAt: run.stagedAt,
    finishedAt: run.finishedAt,
    abandonedBy: run.abandonedBy,
    abandonedReason: run.abandonedReason,
    abandonedAt: run.abandonedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

const RUNS_LIMIT_DEFAULT = 20;
const RUNS_LIMIT_MAX = 100;

const runsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().default(RUNS_LIMIT_DEFAULT),
});

const abandonBodySchema = z.object({
  reason: z.string().trim().min(1),
});

/**
 * 依登入者 userId 查出 email 當作 abandon 的 operator。JWT payload 只有
 * userId（見 app.ts 的 FastifyJWT 型別宣告），要拿 email 得回查 users 表。
 */
async function resolveOperatorEmail(userId: number): Promise<string> {
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user?.email ?? `user:${userId}`;
}

export async function stagingSyncAdminRoutes(app: FastifyInstance) {
  // 本群組所有 staging-sync 管理端點都需登入
  app.addHook("preHandler", app.authenticate);

  app.post("/staging-sync/trigger", async (_request, reply) => {
    try {
      const summary = await runTemplateCatalogSync();
      return reply.code(200).send(summary);
    } catch (error) {
      // 鎖忙碌／同 sync_type 已有進行中 run：視為衝突，409
      if (error instanceof LockConflictError || error instanceof ActiveSyncRunError) {
        return reply.code(409).send({ error: error.message });
      }
      // 取鎖過程本身出錯（非「忙碌」）：503
      if (error instanceof LockError) {
        return reply.code(503).send({ error: error.message });
      }
      // 其餘（SourceFetchError／swap 交易失敗……）：502，訊息消毒過
      return reply.code(502).send({ error: sanitizeErrorForResponse(error) });
    }
  });

  app.get("/staging-sync/runs", async (request, reply) => {
    const parsed = runsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid query parameters" });
    }
    const limit = Math.min(parsed.data.limit, RUNS_LIMIT_MAX);

    const rows = await db.select().from(syncRuns).orderBy(desc(syncRuns.id)).limit(limit);
    return reply.send(rows.map(toRunView));
  });

  app.post("/staging-sync/runs/:id/abandon", async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid id" });
    }
    const body = abandonBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "reason 為必填，且不可為空白字串" });
    }

    const operator = await resolveOperatorEmail(request.user.userId);
    const updated = await abandon(params.data.id, body.data.reason, operator);
    if (!updated) {
      return reply.code(422).send({ error: "只有 staged 狀態的 run 可以放棄" });
    }
    return reply.send(toRunView(updated));
  });

  app.get("/staging-sync/catalog", async (_request, reply) => {
    // lists/items/tags 三個 SELECT 必須包在同一個 REPEATABLE READ 唯讀交易內
    // 一起執行，否則會撕裂快照：merger.swap() 是單一交易的原子切換，若它恰好
    // 在這三個查詢之間 commit，PostgreSQL READ COMMITTED（預設隔離級）下每個
    // 語句各自取自己的快照，回應就會拼接新舊兩個世代的資料（已用真實 PG 重現）。
    //
    // 注意：只是包一層 `db.transaction(...)` 而不指定隔離級是不夠的——
    // READ COMMITTED 隔離級下，同一個交易內的每一個語句仍然各自重新取得快照
    // （commit 前執行的其他交易一旦 commit，交易內下一個語句就看得到），
    // 撕裂的風險完全沒有被交易邊界本身排除。唯有 REPEATABLE READ（或更高）
    // 才會讓整個交易從第一個查詢開始固定在單一快照，之後的語句都只看得到
    // 那一刻的資料，才能真正保證 lists/items/tags 三者互相一致。
    const { lists, items, tags } = await db.transaction(
      async (tx) => {
        const lists = await tx
          .select()
          .from(templateLists)
          .where(eq(templateLists.isActive, true))
          .orderBy(asc(templateLists.sourceListId));

        const items = await tx
          .select()
          .from(templateItems)
          .where(eq(templateItems.isActive, true))
          .orderBy(asc(templateItems.sourceListId), asc(templateItems.position));

        const tags = await tx
          .select()
          .from(templateItemTags)
          .where(eq(templateItemTags.isActive, true))
          .orderBy(asc(templateItemTags.sourceItemId), asc(templateItemTags.tag));

        return { lists, items, tags };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );

    // 依 sourceItemId 分組標籤：查詢已依 (sourceItemId, tag) 排序，依序塞入陣列
    // 即天生保持字母序，不需要另外再排一次。
    const tagsByItem = new Map<number, string[]>();
    for (const tagRow of tags) {
      const bucket = tagsByItem.get(tagRow.sourceItemId);
      if (bucket) {
        bucket.push(tagRow.tag);
      } else {
        tagsByItem.set(tagRow.sourceItemId, [tagRow.tag]);
      }
    }

    // 依 sourceListId 分組項目：查詢已依 (sourceListId, position) 排序，依序
    // 塞入陣列即天生保持 position 序，不需要另外再排一次。
    const itemsByList = new Map<
      number,
      Array<{
        sourceItemId: number;
        title: string;
        priority: number;
        position: number;
        tags: string[];
      }>
    >();
    for (const itemRow of items) {
      const bucket = itemsByList.get(itemRow.sourceListId) ?? [];
      bucket.push({
        sourceItemId: itemRow.sourceItemId,
        title: itemRow.title,
        priority: itemRow.priority,
        position: itemRow.position,
        tags: tagsByItem.get(itemRow.sourceItemId) ?? [],
      });
      itemsByList.set(itemRow.sourceListId, bucket);
    }

    return reply.send({
      lists: lists.map((list) => ({
        sourceListId: list.sourceListId,
        title: list.title,
        description: list.description,
        items: itemsByList.get(list.sourceListId) ?? [],
      })),
    });
  });
}
