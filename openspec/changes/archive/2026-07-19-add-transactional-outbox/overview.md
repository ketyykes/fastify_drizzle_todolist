# Overview: add-transactional-outbox

<!--
  ASCII 人類版摘要。所有圖包在三引號程式碼區塊內。
  框內盡量用英文標籤以維持等寬對齊；中文註解放框外，用 ← 對齊。
-->

## Scope

在既有 todolist（登入 + per-user todos CRUD）之上，加一個獨立的教學情境：todo 被標記
完成時，用 **transactional outbox** 模式可靠地通知一個 mock 外部 webhook 服務。涵蓋
交易內入隊、commit 後 fast-path、獨立 worker 背景 sweeper（含退避重試與死信）、維運端點
與 CLI、以及一個可即時操作觀察狀態流轉的前端教學頁。

**Size**: large — 依 schema「取最大命中」，本 change 的 tasks.md 有 71 個 checkbox
（遠超 large 門檻的 tasks > 20），故判定為 large。雖然對外只新增 1 個 capability
（`transactional-outbox`），但實作橫跨 DB schema（新表）、server 新模組（`outbox/`
8 個檔案）、獨立 worker 進程、2 支維運 CLI、2 支新路由群組，以及前端新頁面／hook／
API 封裝。
**Frontend involved**: yes — `/outbox-guide` 頁面含即時統計輪詢、mock 模式切換、
手動 sweep／requeue dead 操作與對應的載入/錯誤狀態，故含 UI Mockups 區塊。

---

## What Changes

- 新增 `outbox_messages` 表；`PATCH /todos/:id` 在 `completed: false→true` 時於同一
  交易內入隊一筆事件（只存 `refId`，不存 payload）。
- commit 後 fast-path best-effort 立即試送一次；失敗留給獨立 worker 的背景 sweeper
  依退避查表（1/5/15/60 分鐘，第 5 次起封頂 360 分鐘）重試，達上限轉死信。
- 新增維運端點（`/outbox/stats`、`/outbox/requeue-dead`、`/outbox/sweep`，需登入）與
  CLI（`outbox:prune`、`outbox:requeue-dead`）。
- 新增無認證的 mock 外部服務（`/mock-external/*`），可切換 success/fail/timeout 模式。
- 新增前端 `/outbox-guide` 教學頁：雙寫問題說明、架構圖、狀態機圖、退避表、即時佇列
  統計與操作按鈕。

目前狀態與變更後的對照：

```
=== Before ===
todos  : PATCH 只更新 completed/title，回應後即結束
notify : 無外部通知
ops    : 無 outbox 相關端點/CLI
web    : 無 outbox 相關頁面

=== After ===
todos  : PATCH completed false->true 時，同交易內多寫一筆 outbox_messages
notify : commit 後 fast-path 試送；失敗交給獨立 worker 的 sweeper 背景重試
ops    : GET/POST /outbox/* 端點 + outbox:prune / outbox:requeue-dead CLI
web    : /outbox-guide 頁面，可觀察佇列狀態、切模式、手動 sweep/requeue
```

---

## UI Mockups

`/outbox-guide` 是既有 header 新增的一個受保護頁籤，聚焦在「即時演示區」（其餘為靜態
說明區塊：雙寫問題、架構圖、狀態機圖、關鍵設計說明，內容固定不隨操作變化）。以下畫出
即時演示區的幾個關鍵 state。

```
=== State 1: 進入頁面，讀取中 (loading) ===

┌──────────────────────────────────────┐
│ Todo App  alice [Todos][Outbox][Out]  │ ← header 新增 Outbox Guide 頁籤
├──────────────────────────────────────┤
│ Transactional Outbox 教學              │
│ [static: 雙寫問題/架構圖/狀態機/設計說明] │
│                                        │
│ 5. 即時演示區                           │
│ [pending][processing][done][dead]     │
│  ...       ...          ...   ...      │ ← Skeleton 載入中
└──────────────────────────────────────┘

=== State 2: 統計載入完成 (loaded) ===

│ [pending][processing][done][dead]     │
│    0          0         3     0       │
│                                        │
│ mock mode: [success]                   │
│ [success*] [fail] [timeout]           │ ← * 記號＝目前 active
│ [手動 Sweep] [Requeue Dead] disabled   │ ← dead=0 時 Requeue 停用
└──────────────────────────────────────┘
              │
              │ 點 [fail] 切換 mock 模式
              ▼

=== State 3: 切換模式中 (switching) ===

│ [success] [fail spinner] [timeout]    │ ← 被點的按鈕顯示 loading 圖示
              │
              │ 切換成功 → toast「已切換為 fail」
              │ 到 /todos 完成一筆 todo → fast-path 送出失敗
              ▼

=== State 4: pending 累積失敗 (fast-path failed) ===

│ [pending][processing][done][dead]     │
│    1          0         3     0       │
│                                        │
│ 最近訊息: id=12 todo.completed         │
│  refId=7 status=pending attempts=1/8  │
│  lastError=HTTP 500 (truncate+title)  │
└──────────────────────────────────────┘
              │
              │ 切回 success → 按 [手動 Sweep]
              ▼

=== State 5: Sweep 完成 (recovered) ===

│ [pending][processing][done][dead]     │
│    0          0         4     0       │
│ toast: 卡住回收0/成功1/重試0/轉死信0     │
└──────────────────────────────────────┘

=== State 6: 統計讀取失敗 (error，不阻擋其餘區塊) ===

│ 統計讀取失敗: Network Error             │ ← 紅字錯誤提示
│ [pending][processing][done][dead]     │
│    0          0         0     0       │ ← 沿用上次成功值/初始值
│ 操作按鈕仍可點擊，不因此鎖死整頁          │
└──────────────────────────────────────┘
```

---

## Architecture

正常路徑：`PATCH /todos/:id` 交易內入隊 → commit 後 fast-path 立即試送。
失敗兜底：留在 pending，交由獨立 worker 的 sweeper 每隔固定間隔輪詢認領、送出、
依結果轉移狀態。維運端點與前端頁面皆讀寫同一張 outbox_messages 表。

```
┌──────────────────────────────────────────┐
│ server (Fastify)                          │
│                                            │
│ PATCH /todos/:id                          │
│  | db.transaction:                        │
│  |  UPDATE todos + INSERT outbox_msg      │
│  v                                        │
│ commit -> flushOutboxFastPath()           │  ← 交易外送出 HTTP
│  | HTTP POST                              │
│  | 失敗 -> markFailed (pending,attempts=1) │
│  v                                        │
│ outbox_messages 表                         │
│ (pending/processing/done/dead)            │
│  ^                                        │
│ outbox-admin 路由 [需登入]:                 │
│  GET stats / POST sweep / requeue-dead    │
│  ^                                        │
│ CLI: outbox:prune / outbox:requeue-dead   │
└─────────────────┬──────────────────────────┘
                   │ claimDueBatch
                   │ FOR UPDATE SKIP LOCKED
                   │ 送出 -> markDone/markFailed
┌─────────────────┴──────────────────────────┐
│ worker [獨立進程 worker.ts]                  │
│  createSweepLoop: 先跑一輪，之後每隔          │
│  OUTBOX_SWEEP_INTERVAL_MS 觸發一次           │
│  runSweepOnce: recoverStale->claim->送出     │
└────────────────────────────────────────────┘

┌────────────────────────────────────────────┐
│ mock-external 路由 [無認證，模擬第三方]        │
│  success / fail / timeout 三種回應模式        │
└────────────────────────────────────────────┘

┌────────────────────────────────────────────┐
│ web /outbox-guide [受保護路由]               │
│  useOutboxStats: 輪詢 stats、切模式、         │
│  手動 sweep / requeue dead                   │
└────────────────────────────────────────────┘
```

---

## Task Tree

tasks.md 各群組的依賴關係（`Depends on:` 為現成標註）。§0 為前置基礎建設，其後
各能力群組逐層堆疊，§11 端到端驗證收斂在最後。以縮排表示「依賴於上層」。

```
§0 前置基礎建設 (schema/env/constants/config/測試基礎)
├── §1 退避查表 (backoff)                    depends §0
│   └── §2 Repository (入隊/認領/狀態轉移/統計) depends §0,§1
├── §3 Sender (重抓最新資料送出)              depends §0
├── §7 Mock 外部 webhook 服務                depends §0
│
├── §4 Fast-path (commit 後 best-effort 試送)  depends §2,§3
├── §5 Sweeper (一輪 sweep 狀態轉移)          depends §2,§3
│   └── §6 Worker 輪詢迴圈 (sweep-loop)        depends §5
├── §8 維運端點 (stats/sweep/requeue-dead)     depends §2,§5
│   └── §10 前端 (hook + /outbox-guide 頁面)   depends §8
├── §9 維運 CLI (prune/requeue-dead 參數解析)   depends §2
│
└── §11 手動端到端驗證                        depends §4,§5,§6,§7,§8,§10
```

---

## Cross-Cutting Impact

受影響的檔案／模組矩陣（由 proposal.md 的 Impact 段整理）。

| 檔案 / 模組 | 變更類型 | 風險 |
|-------------|----------|------|
| `packages/db/src/schema/outbox.ts` | new（`outbox_messages` 表 + 2 索引） | low |
| `packages/db/src/schema/index.ts` | modify（匯出 outbox） | low |
| `packages/env/src/server.ts` | modify（3 個 OUTBOX_* 變數） | low |
| `.env.example`（根／server 兩份） | modify | low |
| `apps/server/src/outbox/*.ts`（8 模組 + 測試） | new | medium |
| `apps/server/src/routes/mock-external.ts` | new | low |
| `apps/server/src/routes/outbox-admin.ts` | new | medium |
| `apps/server/src/routes/todos.ts` | modify（PATCH 入隊 + fast-path） | medium |
| `apps/server/src/app.ts` | modify（註冊新路由群組） | low |
| `apps/server/src/worker.ts` | new（獨立 worker 進入點） | medium |
| `apps/server/src/scripts/outbox-*.ts`（2 支 + 測試） | new | low |
| `apps/server/package.json` | modify（worker / outbox:* scripts） | low |
| `apps/web/src/lib/outbox-api.ts` | new | low |
| `apps/web/src/hooks/use-outbox-stats.ts`（+ 測試） | new | medium |
| `apps/web/src/routes/outbox-guide.tsx` | new | medium |
| `apps/web/src/router.tsx` | modify（受保護路由） | low |
| `apps/web/src/components/header.tsx` | modify（導覽連結） | low |
| `docker-compose.yml` | modify（新增 worker 服務） | medium |
