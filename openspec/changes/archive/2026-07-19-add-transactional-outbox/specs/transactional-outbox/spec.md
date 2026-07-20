# Spec Delta: transactional-outbox

## ADDED Requirements

### Requirement: 完成事件於交易內入隊

當 todo 的 `completed` 欄位發生 `false → true` 的狀態轉移時，系統 SHALL 在**同一個資料庫交易**內寫入一筆 `outbox_messages` 訊息（`topic = "todo.completed"`、`refId = todo.id`），使業務資料異動與待送出意圖原子提交；訊息 MUST NOT 儲存事件當下的業務資料快照（只存 `refId`）。非「未完成→完成」的狀態轉移（已完成再次確認完成、或只變更 `title`）以及對他人 todo 的操作 MUST NOT 觸發入隊。

#### Scenario: 完成狀態轉移入隊一筆事件

- **WHEN** 已登入使用者對自己一筆 `completed = false` 的 todo 呼叫 `PATCH /todos/:id` 並帶入 `completed: true`
- **THEN** 系統於更新 todo 的同一交易內新增一筆 `outbox_messages`，`topic` 為 `todo.completed`、`refId` 等於該 todo id、初始 `status` 為 `pending`

#### Scenario: 已完成再次確認完成不重複入隊

- **WHEN** 使用者對一筆 `completed` 已為 `true` 的 todo 再次呼叫 `PATCH /todos/:id` 並帶入 `completed: true`
- **THEN** 系統 MUST NOT 新增任何 `outbox_messages` 訊息

#### Scenario: 只變更 title 不入隊

- **WHEN** 使用者呼叫 `PATCH /todos/:id` 只帶入 `title`（不含 `completed`）
- **THEN** 系統 MUST NOT 新增任何 `outbox_messages` 訊息

#### Scenario: 操作他人 todo 不入隊

- **WHEN** 使用者 A 對一筆屬於使用者 B 的 todo 呼叫 `PATCH /todos/:id` 並帶入 `completed: true`
- **THEN** 系統回傳 HTTP 404，且 MUST NOT 新增任何 `outbox_messages` 訊息

### Requirement: Commit 後 fast-path 立即試送

交易 commit 之後，系統 SHALL 立即以 best-effort 方式嘗試送出剛入隊的訊息一次（fast-path）。送出成功（或對應業務資料已不存在而略過）時 SHALL 將該訊息標記為完成；送出失敗時訊息 SHALL 留在 `pending` 並記錄失敗資訊，交由背景 sweeper 依退避時間重試。fast-path 執行中發生任何錯誤 MUST NOT 影響已提交異動的 API 回應。

#### Scenario: fast-path 送出成功

- **WHEN** 剛入隊的訊息於 commit 後立即送出，且 mock 外部服務回應成功
- **THEN** 該筆 `outbox_messages` 的狀態變為 `done`，且外部服務收到內容包含最新 todo 資料的 payload；`PATCH` 端點回應 HTTP 200 與更新後的 todo

#### Scenario: fast-path 送出失敗

- **WHEN** 剛入隊的訊息於 commit 後立即送出，但 mock 外部服務回應失敗（如 HTTP 500）
- **THEN** 該筆 `outbox_messages` 的狀態維持 `pending`、`attempts` 為 1、`lastError` 有值、`nextAttemptAt` 依退避時間往後設定；`PATCH` 端點仍回傳 HTTP 200（fast-path 失敗不影響已提交的更新結果）

### Requirement: Sweeper 背景輪詢認領、重試與死信轉移

系統 SHALL 提供一輪 sweep（`runSweepOnce`）：以 `FOR UPDATE SKIP LOCKED` 認領到期（`status = pending` 且 `nextAttemptAt <= now`）的訊息並轉為 `processing`，逐筆於交易外送出；送出成功（或對應業務資料已不存在）標記為 `done`；送出失敗且累計嘗試次數未達 `maxAttempts` 時，`attempts` 加一並依退避查表重新排回 `pending`；累計嘗試次數達 `maxAttempts` 時轉為 `dead` 並記錄結構化告警。單筆處理發生非預期例外 MUST NOT 中斷同一批次其餘訊息的處理。系統 SHALL 提供一個可重複觸發的輪詢迴圈，供獨立 worker 程序以固定間隔驅動 sweep；輪詢迴圈 SHALL 在啟動時立即先執行一輪，其後每隔固定間隔觸發一次，且在前一輪尚未完成時 MUST 跳過本輪（不重疊執行），並在停止時等待進行中的一輪完成。

#### Scenario: 認領到期訊息並轉為 processing

- **WHEN** sweep 執行時存在一筆 `status = pending` 且 `nextAttemptAt` 已到期的訊息
- **THEN** 該訊息被認領、狀態轉為 `processing` 並記錄 `lockedAt`；未到期或非 `pending` 的訊息不會被認領

#### Scenario: 送出成功轉為 done

- **WHEN** 被認領的訊息送出後，mock 外部服務回應成功
- **THEN** 該訊息狀態轉為 `done`

#### Scenario: 送出失敗未達上限依查表退避重排

- **WHEN** 被認領的訊息送出失敗，且送出後累計 `attempts` 未達 `maxAttempts`
- **THEN** 該訊息退回 `pending`、`attempts` 加一、`nextAttemptAt` 依退避查表（第 1~4 次失敗分別等待 1／5／15／60 分鐘，第 5 次起封頂 360 分鐘，無 jitter）重新設定

#### Scenario: 送出失敗達上限轉為死信

- **WHEN** 被認領的訊息送出失敗，且送出後累計 `attempts` 達到 `maxAttempts`
- **THEN** 該訊息狀態轉為 `dead`，並記錄一筆包含訊息 id、topic、refId、嘗試次數與錯誤內容的結構化告警 log

#### Scenario: 單筆意外失敗不中斷整批

- **WHEN** 同一批次中某一筆訊息在處理過程中發生非預期例外（非送出失敗，例如標記狀態本身出錯）
- **THEN** 該筆訊息維持在 `processing`（留待下一輪卡住回收接手），但批次中其餘訊息仍照常各自完成處理，且 sweep 回傳的計數正確反映實際完成的筆數

#### Scenario: 輪詢迴圈啟動立即先跑一輪

- **WHEN** 呼叫輪詢迴圈的 `start()`
- **THEN** 不必等待第一個間隔時間到達，立即觸發一次 sweep

#### Scenario: 輪詢迴圈依固定間隔觸發

- **WHEN** 輪詢迴圈已啟動，且經過一個完整的間隔時間
- **THEN** 觸發下一輪 sweep；此後每隔一個間隔時間再觸發一次

#### Scenario: 前一輪未完成時跳過本輪

- **WHEN** 前一輪 sweep 尚未完成，同時下一個間隔時間點到達
- **THEN** 本輪被跳過、不重疊執行，且觸發跳過事件的回呼

#### Scenario: 停止時等待進行中的一輪完成

- **WHEN** 呼叫輪詢迴圈的 `stop()` 時，仍有一輪 sweep 正在執行中
- **THEN** `stop()` 回傳的 Promise 待該輪完成後才 resolve；停止後 MUST NOT 再觸發新的一輪

### Requirement: 送出前依 refId 重抓最新業務資料

系統送出訊息時 SHALL 依訊息的 `refId` 重新查詢「當下最新」的業務資料現組 payload，而非回放入隊當下的舊資料。若 `refId` 對應的業務資料已不存在，系統 SHALL 將該訊息視為送出成功（略過，不發出 HTTP 請求）。

#### Scenario: 送出的是最新資料而非入隊當下的舊資料

- **WHEN** 一筆訊息入隊後，其對應的 todo 資料被修改（例如 `title` 變更），之後才被送出
- **THEN** 送往外部服務的 payload 內容反映修改後的最新資料，而非入隊當下的舊資料

#### Scenario: 對應資料已刪除則視為送出成功並跳過

- **WHEN** 一筆訊息的 `refId` 找不到對應的業務資料（已被刪除）
- **THEN** 系統回傳略過（skipped）結果、不發出任何 HTTP 請求，呼叫端將該訊息標記為完成

### Requirement: 卡住 processing 自動回收

系統 SHALL 定期將處於 `processing` 狀態超過 15 分鐘（`lockedAt` 早於目前時間 15 分鐘前）的訊息視為卡住（例如 worker 處理中途 crash），自動退回 `pending` 並清除 `lockedAt`；未超過 15 分鐘的 `processing` 訊息 MUST NOT 受影響。

#### Scenario: 卡住超過 15 分鐘自動退回 pending

- **WHEN** 一筆訊息處於 `processing` 狀態，其 `lockedAt` 距今已超過 15 分鐘
- **THEN** 該訊息狀態退回 `pending`，`lockedAt` 被清除

#### Scenario: 未卡住的 processing 不受影響

- **WHEN** 一筆訊息處於 `processing` 狀態，其 `lockedAt` 距今未滿 15 分鐘
- **THEN** 該訊息狀態維持 `processing` 不變

### Requirement: 維運端點與 CLI

系統 SHALL 提供三個需登入的維運端點：`GET /outbox/stats`（回傳各狀態計數與最近 20 筆訊息）、`POST /outbox/requeue-dead`（把指定或全部 `dead` 訊息重新排回 `pending` 並重置嘗試次數與錯誤訊息）、`POST /outbox/sweep`（手動觸發一輪 sweep 並回傳計數結果）；未登入呼叫上述端點 SHALL 回傳 401。系統 SHALL 另外提供兩支維運 CLI：清理保留天數外已完成訊息的指令（僅硬刪 `done`，`dead`／`pending`／`processing` 一律保留；保留天數參數必須為 ≥1 的正整數，否則報錯退出）、以及重排死信的指令（可用 `--id=1,2` 指定筆數或省略代表全部；帶了 `--id` 但為空值或含非正整數 MUST 報錯退出，避免誤觸全部重排）。

#### Scenario: 未登入呼叫維運端點回 401

- **WHEN** 未帶 token 呼叫 `GET /outbox/stats`、`POST /outbox/requeue-dead` 或 `POST /outbox/sweep` 任一端點
- **THEN** 系統回傳 HTTP 401

#### Scenario: 查詢佇列統計

- **WHEN** 已登入使用者呼叫 `GET /outbox/stats`
- **THEN** 系統回傳 HTTP 200，body 含各狀態（`pending`／`processing`／`done`／`dead`）的計數，以及最近 20 筆訊息（依 id 由新到舊）

#### Scenario: 指定 id 重排死信

- **WHEN** 已登入使用者呼叫 `POST /outbox/requeue-dead` 並帶入 `ids`（指定一或多筆 `dead` 訊息 id）
- **THEN** 僅指定的訊息被重排回 `pending`，`attempts` 歸零、`lastError` 清空、`nextAttemptAt` 設為當下；未指定的其餘 `dead` 訊息不受影響

#### Scenario: 省略 id 重排全部死信

- **WHEN** 已登入使用者呼叫 `POST /outbox/requeue-dead` 並省略 `ids`
- **THEN** 所有 `dead` 訊息皆被重排回 `pending`

#### Scenario: requeue-dead 請求格式不合法回 400

- **WHEN** `POST /outbox/requeue-dead` 的 `ids` 欄位型別不合法（例如非陣列）
- **THEN** 系統回傳 HTTP 400

#### Scenario: 手動觸發一輪 sweep

- **WHEN** 已登入使用者呼叫 `POST /outbox/sweep`
- **THEN** 系統實際執行一輪 sweep（到期的 `pending` 訊息依實際送出結果轉移狀態），並回傳本輪的計數結果

#### Scenario: CLI 清理已完成訊息且保留其他狀態

- **WHEN** 執行清理 CLI（省略 `--days` 使用預設值，或指定 `--days=N`，`N >= 1`）
- **THEN** 僅刪除 `updated_at` 超過保留天數的 `done` 訊息；`dead`、`pending`、`processing` 狀態的訊息一律保留

#### Scenario: CLI 清理天數參數不合法時報錯退出

- **WHEN** 執行清理 CLI 時 `--days` 小於 1 或不是數字
- **THEN** 指令印出錯誤訊息並以非 0 結束碼退出，不執行任何刪除

#### Scenario: CLI 重排死信指令依 --id 篩選或全部重排

- **WHEN** 執行重排死信 CLI 並帶入 `--id=1,2`（允許逗號間有空白）
- **THEN** 僅重排指定的 id；省略 `--id` 時重排全部 `dead` 訊息

#### Scenario: CLI 重排死信參數不合法時報錯退出

- **WHEN** 執行重排死信 CLI 時帶了 `--id` 但其值為空、含非正整數、或含 0 以下的數字
- **THEN** 指令印出錯誤訊息並以非 0 結束碼退出，不執行任何重排（避免打錯字誤觸全部重排）

### Requirement: Mock 外部 webhook 服務

系統 SHALL 提供一組無需認證、模擬第三方外部服務的端點：接收通知的端點依當前模式回應（`success` 模式回 200 並記錄收到的 payload；`fail` 模式回 500 且不記錄；`timeout` 模式延遲超過送出方逾時設定才回應 200）；讀取狀態端點回傳目前模式與已收清單；切換模式端點驗證輸入值僅能是 `success`／`fail`／`timeout` 三者之一；重置端點清空已收清單。

#### Scenario: success 模式記錄收到的 payload

- **WHEN** 模式為 `success` 時對通知端點送出請求
- **THEN** 系統回傳 HTTP 200，並將請求內容記錄進已收清單

#### Scenario: fail 模式回 500 且不記錄

- **WHEN** 模式為 `fail` 時對通知端點送出請求
- **THEN** 系統回傳 HTTP 500，且該次請求內容 MUST NOT 出現在已收清單

#### Scenario: timeout 模式延遲超過逾時設定才回應

- **WHEN** 模式為 `timeout` 時對通知端點送出請求
- **THEN** 系統延遲超過送出方設定的逾時時間後才回應 HTTP 200

#### Scenario: 切換模式驗證輸入值

- **WHEN** 呼叫切換模式端點並帶入非 `success`／`fail`／`timeout` 的值
- **THEN** 系統回傳 HTTP 400，模式不變

#### Scenario: 重置端點清空已收清單

- **WHEN** 呼叫重置端點
- **THEN** 已收清單被清空，後續查詢狀態端點回傳空陣列

### Requirement: 前端 outbox 教學頁即時觀測

系統 SHALL 提供一個受保護的前端頁面（`/outbox-guide`），頁面載入後 SHALL 以固定間隔輪詢 `GET /outbox/stats` 並顯示各狀態計數與最近訊息列表；統計讀取失敗時 SHALL 顯示錯誤訊息而不中斷頁面其餘區塊。頁面 SHALL 提供操作：切換 mock 外部服務模式、手動觸發一輪 sweep、手動 requeue 全部死信；後兩者操作完成後 SHALL 立即重新整理一次統計顯示。

#### Scenario: 頁面載入時輪詢並顯示統計

- **WHEN** 使用者進入 `/outbox-guide` 頁面
- **THEN** 頁面呼叫佇列統計 API 並顯示各狀態計數；此後每隔固定的輪詢間隔再次呼叫並更新顯示

#### Scenario: 統計讀取失敗時顯示錯誤訊息

- **WHEN** 佇列統計 API 呼叫失敗
- **THEN** 頁面顯示錯誤訊息，其餘頁面區塊仍可正常操作

#### Scenario: 切換 mock 模式更新顯示狀態

- **WHEN** 使用者點選切換 mock 外部服務模式的操作
- **THEN** 頁面呼叫切換模式 API，並在成功後更新目前顯示的模式

#### Scenario: 手動 sweep 後重新整理統計

- **WHEN** 使用者點選「手動 Sweep」
- **THEN** 頁面呼叫手動 sweep API，完成後立即重新整理一次佇列統計顯示

#### Scenario: 手動 requeue dead 後重新整理統計

- **WHEN** 使用者點選「Requeue Dead」
- **THEN** 頁面呼叫 requeue-dead API，完成後立即重新整理一次佇列統計顯示
