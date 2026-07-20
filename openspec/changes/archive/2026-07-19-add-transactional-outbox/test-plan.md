# Test Plan: add-transactional-outbox

<!--
  回溯記錄：本 change 為已實作完成並全綠之後補寫的 RED-phase 委諾文件。
  下表的測試皆已實際存在於 codebase 並通過；欄位內容依實際 .test.ts 檔案回填，
  非事先規劃。Tier 欄位每列必填（unit | integration | e2e）。
  後端整合測試以 Fastify `app.inject()`（或起真實 port 供 fast-path/sweeper 打 HTTP）
  對測試用 Postgres 驗證；前端 hook 測試以 mock `@/lib/outbox-api` 模組驗證狀態管理，屬 unit。
-->

## transactional-outbox

### Requirement: 完成事件於交易內入隊

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `completed false→true 入隊一筆，fast-path 成功後列變 done 且 mock 收到 payload`（`todos.test.ts`） | 完成狀態轉移入隊一筆事件 | PATCH `completed:false→true` → 交易內新增一筆 `outbox_messages`（topic=`todo.completed`、refId=該 todo id） | golden path | integration |
| `completed true→true 不重複入隊`（`todos.test.ts`） | 已完成再次確認完成不重複入隊 | 已 `completed:true` 的 todo 再 PATCH `completed:true` → 不新增任何 outbox 訊息 | 邊界：避免非轉移誤觸發 | integration |
| `只改 title 不入隊`（`todos.test.ts`） | 只變更 title 不入隊 | 只 PATCH `title` → 不新增任何 outbox 訊息 | 邊界：非 completed 欄位變更不算事件 | integration |
| `他人 todo 仍回 404，且不入隊`（`todos.test.ts`） | 操作他人 todo 不入隊 | A 對 B 的 todo PATCH `completed:true` → 404 且不新增任何 outbox 訊息 | 安全邊界：隔離規則對新副作用同樣適用 | integration |
| `enqueueOutbox` 必須在交易內執行 insert，並回傳新列 id（`repository.test.ts`） | 完成狀態轉移入隊一筆事件 | 於 `db.transaction` 內呼叫 `enqueueOutbox` → 新增列 `topic`/`refId`/`action='sync'`/`status='pending'` 皆正確 | golden path（元件層） | integration |

### Requirement: Commit 後 fast-path 立即試送

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `completed false→true 入隊一筆，fast-path 成功後列變 done 且 mock 收到 payload`（`todos.test.ts`） | fast-path 送出成功 | 送出成功 → 該列狀態變 `done`、mock 服務收到含最新 todo 的 payload、PATCH 回應仍 200 | golden path | integration |
| `fast-path 失敗（mode=fail）→ 列留 pending、attempts=1、有 last_error 與 next_attempt_at，PATCH 回應仍 200`（`todos.test.ts`） | fast-path 送出失敗 | mock 回 500 → 該列維持 `pending`、`attempts=1`、`lastError` 有值、`nextAttemptAt` 已依退避往後設；PATCH 仍回 200 | 安全邊界：fast-path 失敗不可拖累主流程 | integration |

### Requirement: Sweeper 背景輪詢認領、重試與死信轉移

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `排除未到期與非 pending 的列，只認領到期的 pending`（`repository.test.ts`） | 認領到期訊息並轉為 processing | 到期 pending 被認領；未到期/processing/done/dead 皆不被認領 | 邊界：認領條件正確性 | integration |
| `認領後狀態轉為 processing 並記錄 locked_at`（`repository.test.ts`） | 認領到期訊息並轉為 processing | 認領後回傳與持久化狀態皆為 `processing`，`lockedAt` 非空 | golden path | integration |
| `依 id 由舊到新排序`（`repository.test.ts`） | 認領到期訊息並轉為 processing | 多筆到期訊息依 id 由舊到新被認領 | 邊界：處理順序 | integration |
| `遵守 limit 上限`（`repository.test.ts`） | 認領到期訊息並轉為 processing | 超過 limit 的到期訊息只認領 limit 筆 | 邊界：批次上限 | integration |
| `整輪完成狀態轉移：成功/退避重試/轉死信/卡住回收皆各自正確，單筆失敗不中斷整批，並回傳正確計數`（`sweeper.test.ts`） | 認領到期訊息並轉為 processing／送出成功轉為 done／送出失敗未達上限依查表退避重排／送出失敗達上限轉為死信／單筆意外失敗不中斷整批 | 一輪 sweep 同時涵蓋成功→done、失敗未達上限→pending 退避、失敗達上限→dead、卡住 processing→回收；回傳計數 `{recovered:1, done:1, retried:1, dead:1}` | golden path（整合層），一次驗證整條狀態機 | integration |
| `批次全數為 pending 但已被別的 worker 認領（無到期列）時，回傳全零計數`（`sweeper.test.ts`） | 認領到期訊息並轉為 processing | 無到期訊息時 `runSweepOnce()` 回傳全零計數，不誤判 | edge case | integration |
| `markDone` 標記為 done 並清除 locked_at（`repository.test.ts`） | 送出成功轉為 done | `markDone` 後狀態為 `done`、`lockedAt` 清空 | golden path（元件層） | integration |
| `markFailed` 未達上限：attempts+1、退回 pending、依查表設定 next_attempt_at（`repository.test.ts`） | 送出失敗未達上限依查表退避重排 | `attempts` 加一、狀態回 `pending`、`nextAttemptAt` 落在第 1 次退避（約 1 分鐘）區間內 | golden path（元件層） | integration |
| `markFailed` 達上限：轉 dead（`repository.test.ts`） | 送出失敗達上限轉為死信 | `attempts` 達 `maxAttempts` → 狀態轉 `dead` | golden path（元件層） | integration |
| `外部服務回傳非 2xx → 拋出錯誤`（`sender.test.ts`） | 送出失敗未達上限依查表退避重排 | 非 2xx 回應 → `sendOutboxMessage` 拋出錯誤，供呼叫端轉為 `markFailed` | 底層機制：失敗必須可偵測 | integration |
| `逾時 → 拋出錯誤`（`sender.test.ts`） | 送出失敗未達上限依查表退避重排 | 逾時 → `sendOutboxMessage` 拋出錯誤 | 底層機制：逾時視同失敗 | integration |
| `啟動即先跑一輪，不必等第一個 interval tick`（`sweep-loop.test.ts`） | 輪詢迴圈啟動立即先跑一輪 | `start()` 後不必等 interval，立刻呼叫一次 `sweep` | golden path | unit |
| `之後每隔 intervalMs 觸發一輪`（`sweep-loop.test.ts`） | 輪詢迴圈依固定間隔觸發 | 每經過一個 `intervalMs` 多呼叫一次 `sweep` | golden path | unit |
| `上一輪尚未完成時，tick 應跳過本輪（呼叫 onSkip）且不重疊執行`（`sweep-loop.test.ts`） | 前一輪未完成時跳過本輪 | 前一輪未 resolve 時新 tick 不呼叫 `sweep`、改呼叫 `onSkip` | 安全邊界：避免重疊執行 | unit |
| `stop 後不再觸發任何一輪`（`sweep-loop.test.ts`） | 停止時等待進行中的一輪完成 | `stop()` 後即使時間繼續前進也不再呼叫 `sweep` | golden path | unit |
| `stop 會等待目前這輪完成才 resolve，並在完成後呼叫 onResult`（`sweep-loop.test.ts`） | 停止時等待進行中的一輪完成 | 進行中的一輪未完成時 `stop()` 不 resolve；完成後才 resolve 並觸發 `onResult` | 安全邊界：優雅停止不可中斷進行中的一輪 | unit |

### Requirement: 送出前依 refId 重抓最新業務資料

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `依 refId 重抓最新 todo：入隊後改 title，送出的 payload 是新 title`（`sender.test.ts`） | 送出的是最新資料而非入隊當下的舊資料 | 入隊後修改 `title` → 送出的 payload `todo.title` 為修改後的新值 | golden path，核心設計決策 | integration |
| `ref 已刪（todo 不存在）→ 回傳 skipped，且不發出 HTTP 請求`（`sender.test.ts`） | 對應資料已刪除則視為送出成功並跳過 | `refId` 查無資料 → 回傳 `{skipped:true}`，`callCount` 為 0（未發出 HTTP） | edge case | integration |

### Requirement: 卡住 processing 自動回收

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `卡住超過 15 分鐘的 processing 退回 pending 並清除 locked_at`（`repository.test.ts`） | 卡住超過 15 分鐘自動退回 pending | `lockedAt` 早於 20 分鐘前的 processing → 退回 pending、`lockedAt` 清空 | golden path | integration |
| `未卡住（15 分鐘內）的 processing 不受影響`（`repository.test.ts`） | 未卡住的 processing 不受影響 | `lockedAt` 為 5 分鐘前的 processing → 不受影響，仍為 processing | 邊界：避免誤回收正在處理中的訊息 | integration |
| `非 processing 狀態不受影響`（`repository.test.ts`） | 卡住超過 15 分鐘自動退回 pending | 非 processing 狀態即使 `lockedAt` 已久遠也不受影響、回收筆數為 0 | 邊界：回收只作用於 processing | integration |

### Requirement: 維運端點與 CLI

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `未帶 token 呼叫三支端點皆回 401`（`outbox-admin.test.ts`） | 未登入呼叫維運端點回 401 | `/outbox/stats`、`/outbox/requeue-dead`、`/outbox/sweep` 未帶 token 皆回 401 | 安全邊界 | integration |
| `回傳各狀態計數與最近 20 列`（`outbox-admin.test.ts`） | 查詢佇列統計 | `GET /outbox/stats` → 200，`counts` 各狀態正確、`recent` 長度 ≤20 | golden path | integration |
| `getOutboxStats` 回傳各狀態計數與最近 20 列（id desc）（`repository.test.ts`） | 查詢佇列統計 | 各狀態計數正確、`recent[0]` 為最新一筆 | golden path（元件層） | integration |
| `實際觸發一輪 sweep：到期 pending 轉為 done`（`outbox-admin.test.ts`） | 手動觸發一輪 sweep | `POST /outbox/sweep` → 200，回傳 `done:1`，該列狀態實際變為 `done` | golden path | integration |
| `指定 ids 只重排該幾筆`（`outbox-admin.test.ts`） | 指定 id 重排死信 | 帶 `ids:[a]` → 只有 a 被重排回 pending，b 不受影響 | golden path | integration |
| `省略 ids 時重排全部 dead`（`outbox-admin.test.ts`） | 省略 id 重排全部死信 | 不帶 `ids` → 全部 dead 皆重排 | golden path | integration |
| `body 格式不合法回 400`（`outbox-admin.test.ts`） | requeue-dead 請求格式不合法回 400 | `ids` 非陣列 → 400 | 驗證守門 | integration |
| `requeueDead` 指定 id：只重排指定的 dead 訊息並重置欄位（`repository.test.ts`） | 指定 id 重排死信 | 指定 id → `attempts`歸零、`lastError`清空、`nextAttemptAt`設為當下，未指定者不變 | golden path（元件層） | integration |
| `requeueDead` 省略 id：重排全部 dead 訊息（`repository.test.ts`） | 省略 id 重排全部死信 | 全部 dead 皆轉 pending | golden path（元件層） | integration |
| `pruneDone` 只硬刪過期的 done，dead/pending/processing 一律保留（`repository.test.ts`） | CLI 清理已完成訊息且保留其他狀態 | 過期 done 被刪；新鮮 done、過期 dead、過期 pending 皆保留 | golden path（元件層） | integration |
| `parsePruneArgs` 省略 --days：預設 30 天／--days=10／--days=1 邊界值合法／其他不相干參數不影響解析（`outbox-prune.test.ts`） | CLI 清理已完成訊息且保留其他狀態 | 解析出正確天數；邊界值 1 合法 | golden path + 邊界 | unit |
| `parsePruneArgs` --days=0／--days=-5／--days=abc／--days= 空值（`outbox-prune.test.ts`） | CLI 清理天數參數不合法時報錯退出 | 皆回傳 `{ok:false}` 並附錯誤訊息 | 驗證守門 | unit |
| `parseRequeueDeadArgs` 省略 --id／--id=1／--id=1,2,3／--id=1, 2 ,3 容許空白／其他不相干參數（`outbox-requeue-dead.test.ts`） | CLI 重排死信指令依 --id 篩選或全部重排 | 正確解析出 `ids` 陣列或 `undefined`（省略時） | golden path + 邊界 | unit |
| `parseRequeueDeadArgs` --id= 空值／--id=1,,2／--id=abc／--id=1,abc,2／--id=0 或負數（`outbox-requeue-dead.test.ts`） | CLI 重排死信參數不合法時報錯退出 | 皆回傳 `{ok:false}` 並附錯誤訊息，避免誤觸全部重排 | 驗證守門 | unit |

### Requirement: Mock 外部 webhook 服務

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `預設 mode 為 success 且 received 為空陣列`（`mock-external.test.ts`） | success 模式記錄收到的 payload | 初始狀態 `mode=success`、`received=[]` | golden path | integration |
| `success 模式：回 200 並記錄收到的 payload`（`mock-external.test.ts`） | success 模式記錄收到的 payload | `mode=success` 時 POST → 200，`received` 含該次 payload | golden path | integration |
| `fail 模式：回 500 且不記錄 received`（`mock-external.test.ts`） | fail 模式回 500 且不記錄 | `mode=fail` 時 POST → 500，`received` 長度不變 | golden path | integration |
| `timeout 模式：延遲需超過 sender timeout 才回應 200`（`mock-external.test.ts`） | timeout 模式延遲超過逾時設定才回應 | `mode=timeout` 時回應延遲時間大於 sender timeout | golden path | integration |
| `可切換 mode 為 fail / timeout / success`（`mock-external.test.ts`） | 切換模式驗證輸入值 | `PUT /mock-external/mode` 合法值皆可成功切換並反映在 GET 狀態 | golden path | integration |
| `非法 mode 值回傳 400`（`mock-external.test.ts`） | 切換模式驗證輸入值 | 非法值 → 400 | 驗證守門 | integration |
| `清空 received 清單`（`mock-external.test.ts`） | 重置端點清空已收清單 | `POST /mock-external/reset` 後 `received` 變空陣列 | golden path | integration |

### Requirement: 前端 outbox 教學頁即時觀測

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `loads_stats_successfully`（`use-outbox-stats.test.tsx`） | 頁面載入時輪詢並顯示統計 | 初次載入呼叫 `fetchOutboxStats`，`stats` 更新為回傳值、`loading` 變 false | golden path | unit |
| `sets_error_on_fetch_failure`（`use-outbox-stats.test.tsx`） | 統計讀取失敗時顯示錯誤訊息 | `fetchOutboxStats` 拋錯 → `error` 被設定為錯誤訊息 | 安全邊界：讀取失敗不可讓頁面整體崩潰 | unit |
| `polls_on_interval_and_refetches`（`use-outbox-stats.test.tsx`） | 頁面載入時輪詢並顯示統計 | 經過一個輪詢間隔後再次呼叫 `fetchOutboxStats` | golden path：確認輪詢機制存在 | unit |
| `switch_mode_calls_api_and_updates_state`（`use-outbox-stats.test.tsx`） | 切換 mock 模式更新顯示狀態 | 呼叫 `switchMode` → 呼叫 `setMockExternalMode`，成功後 `mode` 狀態更新 | golden path | unit |
| `sweep_calls_api_and_refetches_stats`（`use-outbox-stats.test.tsx`） | 手動 sweep 後重新整理統計 | 呼叫 `sweep` → 呼叫 `sweepOutbox`，完成後再次呼叫 `fetchOutboxStats` | golden path | unit |
| `requeue_dead_calls_api_and_refetches_stats`（`use-outbox-stats.test.tsx`） | 手動 requeue dead 後重新整理統計 | 呼叫 `requeueDead` → 呼叫 `requeueDeadOutbox`，完成後再次呼叫 `fetchOutboxStats` | golden path | unit |

---

## Checklist

- [x] Every requirement has at least one matching test
- [x] Every Scenario (####) has at least one matching test
- [x] Every row has a Tier value (unit | integration | e2e)
- [x] Test names use imperative form or reflect actual `.test.ts` description text (回溯記錄，取自實際檔案)
