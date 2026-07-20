import { Ban, CheckCircle2, Clock, Loader2, RefreshCcw, RotateCcw } from "lucide-react";
import { useState } from "react";
import { NavLink } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOutboxStats } from "@/hooks/use-outbox-stats";
import { getErrorMessage } from "@/lib/errors";
import type { MockExternalMode, OutboxMessage, OutboxStatus } from "@/lib/outbox-api";

// 狀態徽章樣式與中文顯示、圖示，統一在此對應，避免散落各處的字面量判斷
const STATUS_META: Record<OutboxStatus, { label: string; className: string; icon: typeof Clock }> =
  {
    pending: {
      label: "待送出",
      className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
      icon: Clock,
    },
    processing: {
      label: "送出中",
      className: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
      icon: Loader2,
    },
    done: {
      label: "已完成",
      className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      icon: CheckCircle2,
    },
    dead: {
      label: "死信",
      className: "bg-destructive/10 text-destructive",
      icon: Ban,
    },
  };

const MODE_OPTIONS: { value: MockExternalMode; label: string; hint: string }[] = [
  { value: "success", label: "success", hint: "外部服務 200 成功回應" },
  { value: "fail", label: "fail", hint: "外部服務回 500，模擬打不通" },
  { value: "timeout", label: "timeout", hint: "外部服務刻意延遲超過逾時秒數" },
];

// 退避查表（來自 design.md，非公式）：第 1~4 次失敗分別等這麼久，第 5 次起封頂
const BACKOFF_TABLE: { attempt: string; waitMinutes: string }[] = [
  { attempt: "第 1 次失敗後", waitMinutes: "1 分鐘" },
  { attempt: "第 2 次失敗後", waitMinutes: "5 分鐘" },
  { attempt: "第 3 次失敗後", waitMinutes: "15 分鐘" },
  { attempt: "第 4 次失敗後", waitMinutes: "60 分鐘" },
  { attempt: "第 5 次以上", waitMinutes: "360 分鐘（封頂，無 jitter）" },
];

/**
 * 依 ISO 字串格式化為本地時間顯示；null／格式錯誤一律顯示「—」。
 */
function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-TW", { hour12: false });
}

function StatusBadge({ status }: { status: OutboxStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium whitespace-nowrap ${meta.className}`}
    >
      <Icon className={status === "processing" ? "size-3 animate-spin" : "size-3"} />
      {meta.label}
      <span className="font-mono text-[10px] opacity-70">({status})</span>
    </span>
  );
}

// SVG 內共用的方塊節點：多行文字用 tspan 手動置中換行
function DiagramBox({
  x,
  y,
  width,
  height,
  lines,
  emphasis,
  dashed,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
  emphasis?: boolean;
  dashed?: boolean;
}) {
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const lineHeight = 12;
  const firstDy = -((lines.length - 1) * lineHeight) / 2;

  let boxClassName = "fill-card stroke-border";
  if (emphasis) {
    boxClassName = "fill-primary/10 stroke-primary";
  } else if (dashed) {
    boxClassName = "fill-muted/60 stroke-muted-foreground";
  }

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        strokeWidth={emphasis ? 1.5 : 1}
        strokeDasharray={dashed ? "4 3" : undefined}
        className={boxClassName}
      />
      <text textAnchor="middle" className="fill-foreground font-mono text-[10px]">
        {lines.map((line, i) => {
          // 只在第一行設定絕對 y，其餘行只給 dy 讓其相對前一行往下流動；
          // 若每行都設 y 會讓 SVG 重設游標基準，導致多行文字疊在一起。
          if (i === 0) {
            return (
              <tspan key={`${x}-${y}-${i}`} x={centerX} y={centerY} dy={firstDy}>
                {line}
              </tspan>
            );
          }
          return (
            <tspan key={`${x}-${y}-${i}`} x={centerX} dy={lineHeight}>
              {line}
            </tspan>
          );
        })}
      </text>
    </g>
  );
}

// 兩行文字的箭頭標籤，統一置中對齊
function ArrowLabel({ x, y, lines }: { x: number; y: number; lines: string[] }) {
  return (
    <text textAnchor="middle" className="fill-muted-foreground text-[9px]">
      {lines.map((line, i) => (
        <tspan key={`${x}-${y}-${i}`} x={x} y={y + i * 11}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

function ArchitectureDiagram() {
  return (
    <svg
      viewBox="0 0 1000 270"
      className="h-auto w-full min-w-[760px]"
      role="img"
      aria-label="架構圖"
    >
      <defs>
        <marker
          id="arch-arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" className="fill-muted-foreground" />
        </marker>
      </defs>

      {/* Row 1：正常路徑（happy path） */}
      <DiagramBox
        x={10}
        y={20}
        width={180}
        height={72}
        lines={["PATCH /todos/:id", "completed: false→true"]}
      />
      <line
        x1={190}
        y1={56}
        x2={248}
        y2={56}
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        markerEnd="url(#arch-arrow)"
      />

      <DiagramBox
        x={250}
        y={20}
        width={230}
        height={72}
        emphasis
        lines={["db.transaction", "todos UPDATE +", "outbox_messages INSERT"]}
      />
      <line
        x1={480}
        y1={56}
        x2={538}
        y2={56}
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        markerEnd="url(#arch-arrow)"
      />
      <ArrowLabel x={509} y={40} lines={["commit 之後"]} />

      <DiagramBox
        x={540}
        y={20}
        width={190}
        height={72}
        lines={["commit 後 fast-path", "best-effort 試送一次"]}
      />
      <line
        x1={730}
        y1={56}
        x2={788}
        y2={56}
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        markerEnd="url(#arch-arrow)"
      />
      <ArrowLabel x={759} y={40} lines={["HTTP POST", "（交易外）"]} />

      <DiagramBox
        x={790}
        y={20}
        width={200}
        height={72}
        lines={["外部 webhook 服務", "(mock-external，第三方)"]}
      />

      {/* Row 2：失敗重試路徑（sweeper） */}
      <path
        d="M635,92 Q635,130 655,166"
        fill="none"
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        strokeDasharray="4 3"
        markerEnd="url(#arch-arrow)"
      />
      <ArrowLabel
        x={700}
        y={128}
        lines={["fast-path 失敗 → 留在 pending", "（sweeper 下一輪認領）"]}
      />

      <DiagramBox
        x={540}
        y={166}
        width={230}
        height={72}
        dashed
        lines={["sweeper worker", "每分鐘 runSweepOnce()", "FOR UPDATE SKIP LOCKED 認領"]}
      />

      <path
        d="M770,202 Q900,202 890,92"
        fill="none"
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        strokeDasharray="4 3"
        markerEnd="url(#arch-arrow)"
      />
      <ArrowLabel x={860} y={150} lines={["重試 POST", "（同一 webhook 端點）"]} />
    </svg>
  );
}

function StateMachineDiagram() {
  return (
    <svg
      viewBox="0 -100 820 480"
      className="h-auto w-full min-w-[680px]"
      role="img"
      aria-label="狀態機圖"
    >
      <defs>
        <marker
          id="sm-arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" className="fill-muted-foreground" />
        </marker>
      </defs>

      <DiagramBox
        x={20}
        y={158}
        width={160}
        height={64}
        emphasis
        lines={["pending", "（待送出／入隊時）"]}
      />
      <DiagramBox
        x={330}
        y={30}
        width={160}
        height={64}
        lines={["processing", "（sweeper 認領中）"]}
      />
      <DiagramBox x={640} y={30} width={160} height={64} lines={["done", "（送出成功）"]} />
      <DiagramBox x={330} y={286} width={160} height={64} lines={["dead", "（達重試上限）"]} />
      <DiagramBox
        x={640}
        y={150}
        width={160}
        height={56}
        dashed
        lines={["updated_at ≥ 30 天", "→ prune 硬刪（僅 done）"]}
      />

      {/* pending → processing：sweeper 認領 */}
      <path
        d="M180,175 Q260,110 330,80"
        fill="none"
        className="stroke-foreground"
        strokeWidth={1.5}
        markerEnd="url(#sm-arrow)"
      />
      <ArrowLabel x={195} y={130} lines={["認領", "(FOR UPDATE SKIP LOCKED)"]} />

      {/* processing → done：成功 */}
      <line
        x1={490}
        y1={62}
        x2={638}
        y2={62}
        className="stroke-foreground"
        strokeWidth={1.5}
        markerEnd="url(#sm-arrow)"
      />
      <ArrowLabel x={565} y={45} lines={["成功 / ref 已刪 → markDone"]} />

      {/* done → prune 標記 */}
      <line
        x1={720}
        y1={94}
        x2={720}
        y2={148}
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        strokeDasharray="4 3"
        markerEnd="url(#sm-arrow)"
      />

      {/* processing → pending：退避 + 卡住回收（同方向兩個原因合併標示） */}
      <path
        d="M350,94 Q240,255 180,205"
        fill="none"
        className="stroke-foreground"
        strokeWidth={1.5}
        markerEnd="url(#sm-arrow)"
      />
      <ArrowLabel
        x={255}
        y={225}
        lines={["① 失敗未達上限：attempts+1＋依查表退避", "② processing 逾 15 分鐘卡住：自動回收"]}
      />

      {/* processing → dead：達上限 */}
      <line
        x1={410}
        y1={94}
        x2={410}
        y2={284}
        className="stroke-destructive"
        strokeWidth={1.5}
        markerEnd="url(#sm-arrow)"
      />
      <ArrowLabel x={470} y={190} lines={["失敗達上限", "(attempts ≥ max_attempts)"]} />

      {/* dead → pending：人工 requeue-dead */}
      <path
        d="M330,318 Q150,360 100,222"
        fill="none"
        className="stroke-foreground"
        strokeWidth={1.5}
        markerEnd="url(#sm-arrow)"
      />
      <ArrowLabel
        x={195}
        y={352}
        lines={["人工 requeue-dead", "（attempts 歸零、清 last_error）"]}
      />

      {/* fast-path 捷徑：pending 直達 done，不經 processing（拉高弧線避免穿過 processing 方塊） */}
      <path
        d="M110,158 Q400,-70 638,45"
        fill="none"
        className="stroke-primary"
        strokeWidth={1.5}
        strokeDasharray="4 3"
        markerEnd="url(#sm-arrow)"
      />
      <ArrowLabel
        x={400}
        y={-42}
        lines={["fast-path 成功（commit 後立刻試送，不經 processing）"]}
      />
    </svg>
  );
}

export default function OutboxGuide() {
  const {
    stats,
    loading,
    error,
    mode,
    modeLoading,
    switchMode,
    switchingMode,
    sweep,
    sweeping,
    requeueDead,
    requeuingDead,
  } = useOutboxStats();

  const [pendingModeTarget, setPendingModeTarget] = useState<MockExternalMode | null>(null);

  async function handleSwitchMode(nextMode: MockExternalMode) {
    setPendingModeTarget(nextMode);
    try {
      await switchMode(nextMode);
      toast.success(`mock 外部服務模式已切換為「${nextMode}」`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setPendingModeTarget(null);
    }
  }

  async function handleSweep() {
    try {
      const result = await sweep();
      toast.success(
        `Sweep 完成：卡住回收 ${result.recovered}、成功 ${result.done}、` +
          `重試 ${result.retried}、轉死信 ${result.dead}`,
      );
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  async function handleRequeueDead() {
    try {
      const result = await requeueDead();
      toast.success(`已重新排入 ${result.requeued} 筆死信回 pending`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  const counts = stats?.counts ?? { pending: 0, processing: 0, done: 0, dead: 0 };
  const recent: OutboxMessage[] = stats?.recent ?? [];

  return (
    <main className="container mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-1 text-2xl font-semibold">Transactional Outbox 教學</h1>
      <p className="text-muted-foreground mb-8 text-xs">
        本範例改寫自真實生產系統的整合模式（如 ERP 對接）的去識別化版本，
        把同一套「可靠通知外部服務」的機制落地到 todolist 情境：
        <span className="font-medium"> todo 被標記完成時，可靠地通知外部 webhook 服務</span>。
      </p>

      {/* 1. 雙寫問題 */}
      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">
          1. 雙寫問題：為什麼不能「寫完 DB 就直接打 HTTP」
        </h2>
        <p className="text-foreground/90 mb-3 text-sm">
          「寫本地 DB」和「打外部 HTTP」是兩個無法原子化的動作，怎麼排順序都有破綻：
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-destructive">先寫 DB，事後才打 HTTP</CardTitle>
              <CardDescription>漏事件</CardDescription>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs/relaxed">
              DB 交易已提交，若接著打 HTTP 失敗（服務掛了、網路斷線、process 剛好在這裡
              crash），外部服務就永遠不會知道這筆事件發生過——沒有任何機制會再提醒它。
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-destructive">在 DB 交易內打 HTTP</CardTitle>
              <CardDescription>交易被外部拖住</CardDescription>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs/relaxed">
              外部服務慢或掛掉時，本地交易會持鎖等待，拖慢甚至卡住其他請求；若最終逾時，
              整筆交易（含原本毫無問題的業務資料異動）也會被迫回滾。
            </CardContent>
          </Card>
        </div>
        <p className="text-foreground/90 mt-3 text-sm">
          <span className="font-medium">Transactional outbox</span>{" "}
          的解法：交易內只多寫一列「待送出意圖」到 outbox 表，與業務資料原子提交； HTTP
          一律搬到交易外進行，失敗時交給背景 sweeper 依查表重試，直到成功或轉死信。
        </p>
      </section>

      {/* 2. 架構圖 */}
      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">2. 架構圖</h2>
        <p className="text-muted-foreground mb-3 text-xs">
          實線＝正常路徑（happy path）；虛線＝失敗後由 sweeper
          接手的重試路徑。畫面較窄時可左右捲動。
        </p>
        <Card>
          <CardContent className="overflow-x-auto">
            <ArchitectureDiagram />
          </CardContent>
        </Card>
      </section>

      {/* 3. 狀態機圖 */}
      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">3. 狀態機圖</h2>
        <p className="text-muted-foreground mb-3 text-xs">
          藍色虛線＝fast-path 捷徑（commit 後立刻試送成功，pending 直接變 done，不經 processing）。
        </p>
        <Card>
          <CardContent className="overflow-x-auto">
            <StateMachineDiagram />
          </CardContent>
        </Card>
      </section>

      {/* 4. 關鍵設計說明 */}
      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">4. 關鍵設計說明</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>只存 ref_id，重抓最新資料</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs/relaxed">
              outbox 訊息不存事件當下的 payload，只存業務主鍵 <code>ref_id</code>。 真正送出時依{" "}
              <code>ref_id</code> 重新查一次「當下最新」的資料現組 payload。
              取捨：若中間資料又被改過，送出的一定是最新狀態而非入隊當下的舊快照——
              代價是無法回放「當時的樣子」，但避免了送出過期資料的風險。
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>FOR UPDATE SKIP LOCKED</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs/relaxed">
              sweeper 認領到期訊息時，用 <code>FOR UPDATE SKIP LOCKED</code> 鎖定候選列並立刻轉成{" "}
              <code>processing</code>。多個 worker（例如水平擴充多個 sweeper
              程序）同時掃描時，被別人鎖住的列會直接跳過，不會兩個 worker 重複處理同一筆。
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>退避查表（非公式）</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs/relaxed">
              <p className="mb-2">
                失敗後不是無限快速重試，而是查表決定下次可重送時間，無 jitter：
              </p>
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-border border-b">
                    <th className="py-1 pr-2 font-medium">失敗次數</th>
                    <th className="py-1 font-medium">下次重試等待</th>
                  </tr>
                </thead>
                <tbody>
                  {BACKOFF_TABLE.map((row) => (
                    <tr key={row.attempt} className="border-border/60 border-b last:border-0">
                      <td className="py-1 pr-2">{row.attempt}</td>
                      <td className="py-1 font-mono">{row.waitMinutes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>死信與人工救援</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs/relaxed">
              嘗試次數達上限（預設 8 次）就轉成 <code>dead</code>，並寫一筆結構化告警 log，
              不再自動重試——避免無止盡地打一個已知打不通的端點。<code>dead</code> 不受 prune
              影響，永遠保留直到人工用 <code>requeue-dead</code> 重新排回 <code>pending</code>
              （並歸零嘗試次數）。
            </CardContent>
          </Card>
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>at-least-once 語意</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs/relaxed">
              fast-path 試送成功後才轉 <code>done</code>，但「HTTP 已送達」與「本地標記為
              done」仍是兩個分開的動作——例如送達成功但 markDone 前 process 剛好 crash， 下一輪
              sweeper 可能會再送一次。因此這套機制保證的是「至少送達一次」 （at-least-once），
              <span className="font-medium">外部端點必須能容忍重複通知</span>
              （例如用 ref_id + topic 做去重／冪等處理），而不是「剛好送達一次」。
            </CardContent>
          </Card>
        </div>
      </section>

      {/* 5. 即時演示區 */}
      <section className="mb-4">
        <h2 className="mb-3 text-lg font-semibold">5. 即時演示區</h2>

        <Card className="mb-4">
          <CardHeader>
            <CardTitle>怎麼玩</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-xs/relaxed">
            <ol className="list-inside list-decimal space-y-1">
              <li>
                把下方 mock 模式切成 <span className="font-mono">fail</span>。
              </li>
              <li>
                前往{" "}
                <NavLink to="/todos" className="text-primary underline underline-offset-2">
                  Todos 頁
                </NavLink>{" "}
                完成（打勾）一個尚未完成的 todo。
              </li>
              <li>
                回來這頁看 pending 數與該筆訊息的 attempts 增加（fast-path 試送失敗，留在
                pending）。
              </li>
              <li>
                把模式切回 <span className="font-mono">success</span>。
              </li>
              <li>按「手動 Sweep」。</li>
              <li>觀察該筆訊息變成 done、pending 數減少。</li>
            </ol>
            <p className="mt-2">
              小提醒：依退避查表，第 1 次失敗後要等 1 分鐘才會被 sweeper 認領，剛切回 success
              就馬上按 Sweep 可能還沒到期、暫時看不到變化——等一下再按一次，
              或耐心等輪詢自然發現即可。
            </p>
          </CardContent>
        </Card>

        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(["pending", "processing", "done", "dead"] as const).map((status) => (
            <Card key={status} size="sm">
              <CardContent className="flex flex-col gap-1">
                <StatusBadge status={status} />
                {loading ? (
                  <Skeleton className="h-7 w-12" />
                ) : (
                  <span className="text-2xl font-semibold">{counts[status]}</span>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        {error ? <p className="text-destructive mb-4 text-xs">統計讀取失敗：{error}</p> : null}

        <Card className="mb-4">
          <CardHeader>
            <CardTitle>操作</CardTitle>
            <CardDescription>
              目前 mock 外部服務模式：
              {modeLoading ? (
                <Skeleton className="ml-2 inline-block h-4 w-16 align-middle" />
              ) : (
                <span className="font-mono">{mode ?? "未知"}</span>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div>
              <p className="text-muted-foreground mb-2 text-xs">切換 mock 外部服務模式：</p>
              <div className="flex flex-wrap gap-2">
                {MODE_OPTIONS.map((option) => {
                  const isActive = mode === option.value;
                  const isPending = switchingMode && pendingModeTarget === option.value;
                  return (
                    <Button
                      key={option.value}
                      size="sm"
                      variant={isActive ? "default" : "outline"}
                      disabled={switchingMode}
                      title={option.hint}
                      onClick={() => handleSwitchMode(option.value)}
                    >
                      {isPending ? <Loader2 className="size-3 animate-spin" /> : null}
                      {option.label}
                    </Button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={sweeping} onClick={handleSweep}>
                <RefreshCcw className={sweeping ? "size-3.5 animate-spin" : "size-3.5"} />
                手動 Sweep
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={requeuingDead || counts.dead === 0}
                title={counts.dead === 0 ? "目前沒有死信可重排" : "把所有死信重新排回 pending"}
                onClick={handleRequeueDead}
              >
                <RotateCcw className={requeuingDead ? "size-3.5 animate-spin" : "size-3.5"} />
                Requeue Dead
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>最近 20 筆 outbox 訊息</CardTitle>
            <CardDescription>每 4 秒自動輪詢一次</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {loading ? (
              <Skeleton className="h-24 w-full" />
            ) : recent.length === 0 ? (
              <p className="text-muted-foreground text-xs">目前沒有任何 outbox 訊息。</p>
            ) : (
              <table className="w-full min-w-[820px] border-collapse text-left text-xs">
                <thead>
                  <tr className="border-border border-b">
                    <th className="py-1.5 pr-3 font-medium">id</th>
                    <th className="py-1.5 pr-3 font-medium">topic</th>
                    <th className="py-1.5 pr-3 font-medium">refId</th>
                    <th className="py-1.5 pr-3 font-medium">action</th>
                    <th className="py-1.5 pr-3 font-medium">status</th>
                    <th className="py-1.5 pr-3 font-medium">attempts</th>
                    <th className="py-1.5 pr-3 font-medium">nextAttemptAt</th>
                    <th className="py-1.5 pr-3 font-medium">lastError</th>
                    <th className="py-1.5 font-medium">updatedAt</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((message) => (
                    <tr key={message.id} className="border-border/60 border-b last:border-0">
                      <td className="py-1.5 pr-3 font-mono">{message.id}</td>
                      <td className="py-1.5 pr-3 font-mono">{message.topic}</td>
                      <td className="py-1.5 pr-3 font-mono">{message.refId}</td>
                      <td className="py-1.5 pr-3 font-mono">{message.action}</td>
                      <td className="py-1.5 pr-3">
                        <StatusBadge status={message.status} />
                      </td>
                      <td className="py-1.5 pr-3 font-mono">
                        {message.attempts}/{message.maxAttempts}
                      </td>
                      <td className="py-1.5 pr-3 font-mono whitespace-nowrap">
                        {formatDateTime(message.nextAttemptAt)}
                      </td>
                      <td
                        className="text-muted-foreground max-w-[220px] truncate py-1.5 pr-3"
                        title={message.lastError ?? undefined}
                      >
                        {message.lastError ?? "—"}
                      </td>
                      <td className="py-1.5 font-mono whitespace-nowrap">
                        {formatDateTime(message.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
