import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Info,
  Loader2,
  RefreshCcw,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useStagingSyncGuide } from "@/hooks/use-staging-sync-guide";
import { getErrorMessage } from "@/lib/errors";
import type {
  MockSourceMode,
  ResultCode,
  SyncRunPhase,
  TemplateCatalogList,
} from "@/lib/staging-sync-api";

// phase 徽章樣式與中文顯示、圖示，統一在此對應，避免散落各處的字面量判斷
const PHASE_META: Record<SyncRunPhase, { label: string; className: string; icon: typeof Clock }> = {
  fetching: {
    label: "抓取中",
    className: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    icon: Loader2,
  },
  staged: {
    label: "已暫存",
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    icon: Clock,
  },
  swapping: {
    label: "切換中",
    className: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    icon: RefreshCcw,
  },
  done: {
    label: "已完成",
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    icon: CheckCircle2,
  },
  fetch_failed: {
    label: "抓取失敗",
    className: "bg-destructive/10 text-destructive",
    icon: XCircle,
  },
  abandoned: {
    label: "已放棄",
    className: "bg-muted text-muted-foreground",
    icon: Ban,
  },
};

// result_code 徽章樣式，與 phase 分開一張表（同一列 phase=done 底下可能是
// success 或 no_data 兩種語意，不能用 phase 直接推論）
const RESULT_CODE_META: Record<
  ResultCode,
  { label: string; className: string; icon: typeof Clock }
> = {
  success: {
    label: "成功",
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    icon: CheckCircle2,
  },
  no_data: {
    label: "無資料",
    className: "bg-muted text-muted-foreground",
    icon: Info,
  },
  fetch_failed: {
    label: "抓取失敗",
    className: "bg-destructive/10 text-destructive",
    icon: XCircle,
  },
  swap_failed: {
    label: "切換失敗",
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    icon: AlertTriangle,
  },
  abandoned: {
    label: "已放棄",
    className: "bg-muted text-muted-foreground",
    icon: Ban,
  },
};

const MODE_OPTIONS: { value: MockSourceMode; label: string; hint: string }[] = [
  { value: "success", label: "success", hint: "正常分頁回傳資料" },
  { value: "fail", label: "fail", hint: "所有頁一律回 500，模擬來源整個打不通" },
  {
    value: "fail_page_2",
    label: "fail_page_2",
    hint: "第 3 頁（pageIndex=2）固定 500，重試也失敗",
  },
  { value: "flaky_page_2", label: "flaky_page_2", hint: "第 3 頁第一次 500，重試後成功" },
  { value: "empty", label: "empty", hint: "回傳 0 筆，示範 no_data 直接收尾" },
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

/**
 * 後端 numeric 欄位常序列化成字串（避免精度遺失），統一在顯示前轉成秒數字串。
 */
function formatSeconds(value: number | string | null): string {
  if (value === null) return "—";
  const num = Number(value);
  if (Number.isNaN(num)) return "—";
  return `${num.toFixed(3)}s`;
}

/**
 * staged_counts 為 `{ lists, items, tags }` 形狀的 jsonb，攤平成一行摘要文字。
 */
function formatStagedCounts(counts: Record<string, number> | null): string {
  if (!counts) return "—";
  const entries = Object.entries(counts);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}:${value}`).join(" / ");
}

function PhaseBadge({ phase }: { phase: SyncRunPhase }) {
  const meta = PHASE_META[phase];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium whitespace-nowrap ${meta.className}`}
    >
      <Icon
        className={phase === "fetching" || phase === "swapping" ? "size-3 animate-spin" : "size-3"}
      />
      {meta.label}
      <span className="font-mono text-[10px] opacity-70">({phase})</span>
    </span>
  );
}

function ResultCodeBadge({ resultCode }: { resultCode: ResultCode | null }) {
  if (!resultCode) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  const meta = RESULT_CODE_META[resultCode];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium whitespace-nowrap ${meta.className}`}
    >
      <Icon className="size-3" />
      {meta.label}
      <span className="font-mono text-[10px] opacity-70">({resultCode})</span>
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

// 兩行以上文字的箭頭標籤，統一置中對齊
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
      viewBox="0 0 1000 460"
      className="h-auto w-full min-w-[860px]"
      role="img"
      aria-label="架構圖"
    >
      <defs>
        <marker
          id="staging-arch-arrow"
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

      {/* Phase 1：逐頁抓取 → staging（每頁一個短交易，記憶體只跟單頁大小成正比） */}
      <DiagramBox
        x={10}
        y={20}
        width={150}
        height={64}
        lines={["mock 來源", "(範本庫 API，分頁)"]}
      />
      <line
        x1={160}
        y1={52}
        x2={188}
        y2={52}
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        markerEnd="url(#staging-arch-arrow)"
      />

      <DiagramBox
        x={190}
        y={20}
        width={160}
        height={64}
        lines={["page-fetcher", "逐頁抓取", "(async generator)"]}
      />
      <line
        x1={350}
        y1={52}
        x2={378}
        y2={52}
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        markerEnd="url(#staging-arch-arrow)"
      />

      <DiagramBox
        x={380}
        y={20}
        width={160}
        height={64}
        lines={["page-transformer", "攤平巢狀→3組 buffer"]}
      />
      <line
        x1={540}
        y1={52}
        x2={568}
        y2={52}
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        markerEnd="url(#staging-arch-arrow)"
      />

      <DiagramBox
        x={570}
        y={20}
        width={190}
        height={64}
        emphasis
        lines={["staging-writer", "每頁一個短交易", "upsert staging（驗 fence）"]}
      />

      {/* 旁註（重點節點）：sync_runs 是整個流程的協調中樞，不畫連接線——
          每一步 Phase 1／Phase 2 的狀態轉移都要經過它比對 fence */}
      <DiagramBox
        x={790}
        y={20}
        width={190}
        height={64}
        emphasis
        lines={[
          "旁註：sync_runs 協調中樞",
          "phase 狀態機 + advisory lock",
          "+ owner_token/lease_version",
        ]}
      />

      <line
        x1={665}
        y1={84}
        x2={665}
        y2={148}
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        markerEnd="url(#staging-arch-arrow)"
      />
      <ArrowLabel
        x={745}
        y={112}
        lines={["chunk upsert（500 筆/批）", "ON CONFLICT(sync_run_id,業務鍵)"]}
      />

      <DiagramBox x={340} y={150} width={170} height={60} lines={["template_lists", "_staging"]} />
      <DiagramBox x={530} y={150} width={170} height={60} lines={["template_items", "_staging"]} />
      <DiagramBox
        x={720}
        y={150}
        width={200}
        height={60}
        lines={["template_item_tags", "_staging"]}
      />

      {/* Phase 2：全部頁完成後，單一交易 mark-and-sweep */}
      <line
        x1={615}
        y1={210}
        x2={560}
        y2={258}
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        markerEnd="url(#staging-arch-arrow)"
      />
      <ArrowLabel x={640} y={232} lines={["全部頁完成 → staged", "觸發 merger.swap()"]} />

      <DiagramBox
        x={380}
        y={260}
        width={280}
        height={70}
        emphasis
        lines={["merger.swap", "單一交易 mark-and-sweep", "(claimForSwap 驗 fence)"]}
      />

      <line
        x1={420}
        y1={330}
        x2={235}
        y2={368}
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        markerEnd="url(#staging-arch-arrow)"
      />
      <line
        x1={520}
        y1={330}
        x2={425}
        y2={368}
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        markerEnd="url(#staging-arch-arrow)"
      />
      <line
        x1={600}
        y1={330}
        x2={635}
        y2={368}
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        markerEnd="url(#staging-arch-arrow)"
      />
      <ArrowLabel
        x={500}
        y={345}
        lines={["mark：UPDATE is_active=false", "merge：INSERT...ON CONFLICT...DO UPDATE"]}
      />

      <DiagramBox
        x={150}
        y={370}
        width={170}
        height={60}
        lines={["template_lists", "(mark-and-sweep)"]}
      />
      <DiagramBox
        x={340}
        y={370}
        width={170}
        height={60}
        lines={["template_items", "(position 重算)"]}
      />
      <DiagramBox x={530} y={370} width={210} height={60} lines={["template_item_tags"]} />

      {/* 失敗／重播路徑（虛線）：swap 交易失敗只 rollback，staging 原封不動，
          下次觸發直接重播 Phase 2，不必重新對來源發出請求 */}
      <path
        d="M380,295 Q260,230 425,210"
        fill="none"
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        strokeDasharray="4 3"
        markerEnd="url(#staging-arch-arrow)"
      />
      <ArrowLabel
        x={270}
        y={245}
        lines={[
          "swap 失敗 rollback",
          "→ 退回 staged（staging 原封不動）",
          "→ 下次直接重播，不重新 fetch",
        ]}
      />
    </svg>
  );
}

function StateMachineDiagram() {
  return (
    <svg
      viewBox="0 -20 960 420"
      className="h-auto w-full min-w-[760px]"
      role="img"
      aria-label="狀態機圖"
    >
      <defs>
        <marker
          id="staging-sm-arrow"
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
        y={140}
        width={150}
        height={64}
        lines={["fetching", "(Phase 1 逐頁抓取)"]}
      />
      <DiagramBox
        x={310}
        y={140}
        width={150}
        height={64}
        emphasis
        lines={["staged", "(待切換，可安全重播)"]}
      />
      <DiagramBox
        x={600}
        y={140}
        width={150}
        height={64}
        emphasis
        lines={["swapping", "(Phase 2 交易進行中)"]}
      />
      <DiagramBox x={600} y={0} width={150} height={64} lines={["done", "(success 或 no_data)"]} />
      <DiagramBox x={20} y={280} width={150} height={64} lines={["fetch_failed", "(終態)"]} />
      <DiagramBox
        x={310}
        y={280}
        width={150}
        height={64}
        lines={["abandoned", "(終態，人工放棄)"]}
      />

      {/* 主線：fetching → staged → swapping → done */}
      <line
        x1={170}
        y1={172}
        x2={308}
        y2={172}
        className="stroke-foreground"
        strokeWidth={1.5}
        markerEnd="url(#staging-sm-arrow)"
      />
      <ArrowLabel x={240} y={155} lines={["全部頁寫完 staging"]} />

      <line
        x1={460}
        y1={172}
        x2={598}
        y2={172}
        className="stroke-foreground"
        strokeWidth={1.5}
        markerEnd="url(#staging-sm-arrow)"
      />
      <ArrowLabel x={530} y={155} lines={["claimForSwap", "phase→swapping"]} />

      <line
        x1={675}
        y1={138}
        x2={675}
        y2={66}
        className="stroke-foreground"
        strokeWidth={1.5}
        markerEnd="url(#staging-sm-arrow)"
      />
      <ArrowLabel x={745} y={105} lines={["commit 成功", "→ result=success"]} />

      {/* 藍色實線：fetching 抓到 0 筆時直接收尾，跳過 Phase 2 */}
      <path
        d="M95,140 Q350,-10 598,32"
        fill="none"
        className="stroke-primary"
        strokeWidth={1.5}
        markerEnd="url(#staging-sm-arrow)"
      />
      <ArrowLabel x={330} y={-8} lines={["來源回傳 0 筆", "→ done(no_data)，跳過 Phase 2"]} />

      {/* fetching → fetch_failed：即時失敗（實線） */}
      <line
        x1={95}
        y1={204}
        x2={95}
        y2={278}
        className="stroke-destructive"
        strokeWidth={1.5}
        markerEnd="url(#staging-sm-arrow)"
      />
      <ArrowLabel x={165} y={240} lines={["任一頁重試耗盡", "→ SourceFetchError"]} />

      {/* crash recovery（虛線）：取得全域鎖後發現殘留 fetching，判死轉 fetch_failed */}
      <path
        d="M170,160 Q260,230 170,280"
        fill="none"
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        strokeDasharray="4 3"
        markerEnd="url(#staging-sm-arrow)"
      />
      <ArrowLabel x={255} y={222} lines={["crash recovery：", "殘留 fetching 判死"]} />

      {/* staged → abandoned：人工放棄（僅限 staged） */}
      <line
        x1={385}
        y1={204}
        x2={385}
        y2={278}
        className="stroke-foreground"
        strokeWidth={1.5}
        markerEnd="url(#staging-sm-arrow)"
      />
      <ArrowLabel x={450} y={240} lines={["人工 abandon", "(僅限 staged，需 reason)"]} />

      {/* swapping → staged：交易失敗（曲線，實線） */}
      <path
        d="M600,204 Q495,255 460,204"
        fill="none"
        className="stroke-foreground"
        strokeWidth={1.5}
        markerEnd="url(#staging-sm-arrow)"
      />
      <ArrowLabel
        x={495}
        y={235}
        lines={["swap 交易失敗 rollback", "→ 退回 staged（保留 fence）"]}
      />

      {/* crash recovery（虛線）：取得全域鎖後發現殘留 swapping，退回 staged 且 lease_version+1 */}
      <path
        d="M660,204 Q520,330 400,204"
        fill="none"
        className="stroke-muted-foreground"
        strokeWidth={1.5}
        strokeDasharray="4 3"
        markerEnd="url(#staging-sm-arrow)"
      />
      <ArrowLabel
        x={520}
        y={300}
        lines={["crash recovery：", "殘留 swapping 退回 staged", "(lease_version+1)"]}
      />
    </svg>
  );
}

export default function StagingSyncGuide() {
  const {
    runs,
    runsLoading,
    runsError,
    catalog,
    catalogLoading,
    catalogError,
    mode,
    switchMode,
    switchingMode,
    resetMock,
    resettingMock,
    triggerSync,
    triggering,
    abandonRun,
    abandoningRunId,
  } = useStagingSyncGuide();

  const [pendingModeTarget, setPendingModeTarget] = useState<MockSourceMode | null>(null);
  const [abandonTargetId, setAbandonTargetId] = useState<number | null>(null);
  const [abandonReason, setAbandonReason] = useState("");

  async function handleSwitchMode(nextMode: MockSourceMode) {
    setPendingModeTarget(nextMode);
    try {
      await switchMode(nextMode);
      toast.success(`mock 範本庫模式已切換為「${nextMode}」`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setPendingModeTarget(null);
    }
  }

  async function handleResetMock() {
    try {
      await resetMock();
      toast.success("mock 範本庫已重置（模式回 success，flaky 重試計數器歸零）");
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  async function handleTrigger() {
    try {
      const result = await triggerSync();
      const countsText = formatStagedCounts(result.stagedCounts);
      toast.success(
        `同步完成：resultCode=${result.resultCode}` +
          (result.replayed ? "（重播 staged，未重新抓取）" : "") +
          `｜頁數 ${result.pageCount ?? "—"}｜來源筆數 ${result.sourceCount ?? "—"}` +
          (countsText !== "—" ? `｜暫存筆數 ${countsText}` : ""),
      );
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  function openAbandonForm(runId: number) {
    setAbandonTargetId(runId);
    setAbandonReason("");
  }

  function closeAbandonForm() {
    setAbandonTargetId(null);
    setAbandonReason("");
  }

  async function handleConfirmAbandon() {
    if (abandonTargetId === null) return;
    if (abandonReason.trim().length === 0) {
      toast.error("請填寫放棄原因");
      return;
    }
    try {
      await abandonRun(abandonTargetId, abandonReason.trim());
      toast.success(`已放棄 run #${abandonTargetId}`);
      closeAbandonForm();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  const sortedLists: TemplateCatalogList[] = catalog?.lists ?? [];

  return (
    <main className="container mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-1 text-2xl font-semibold">Staging Sync 教學</h1>
      <p className="text-muted-foreground mb-8 text-xs">
        本範例改寫自真實生產系統「大量外部資料全量刷新」場景的去識別化版本：定期從外部
        <span className="font-medium">範本庫（template catalog provider）</span>
        分頁拉取巢狀資料（清單→項目→標籤），全量刷新進本地資料表。
      </p>

      {/* 1. 記憶體與原子性的兩難 */}
      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">1. 記憶體與原子性的兩難</h2>
        <p className="text-foreground/90 mb-3 text-sm">
          「一次抓完所有分頁、全部載入記憶體」和「每抓完一頁就對目標表 commit 一次」，是全量同步最
          常見的兩種天真做法，各自踩到不同的坑：
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-destructive">全部載入記憶體</CardTitle>
              <CardDescription>資料量一大就 OOM</CardDescription>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs/relaxed">
              process 記憶體用量與來源總筆數成正比，資料量夠大就一定 OOM，且無法優雅降級——沒有
              「處理到一半」，只有「成功」或「整個 process 被殺掉」。
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-destructive">天真分批 commit</CardTitle>
              <CardDescription>資料看起來被刪掉一半</CardDescription>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs/relaxed">
              每抓完一頁就 commit，記憶體確實封頂了，但把天生需要原子性的「全量刷新」切成多筆獨立
              交易。若刷新邏輯是先標記舊資料過期、再逐頁 upsert 回來，任何一頁中途失敗，目標表就停在
              「已標記、還沒完全復原」的不一致狀態——使用者看到的是資料被刪掉一半的假象。
            </CardContent>
          </Card>
        </div>
        <p className="text-foreground/90 mt-3 text-sm">
          <span className="font-medium">Staging 暫存表＋單一交易原子切換</span>{" "}
          把兩件事拆到不同階段解決：Phase 1 逐頁抓取、各自獨立短交易寫進 staging
          暫存表，記憶體只跟單頁大小成正比；等全部頁都進了 staging，才在 Phase 2 單一交易內
          mark-and-sweep 合併回目標表，原子性交給資料庫保證。
          <span className="font-medium"> 核心原則：分批的是記憶體，不是 commit。</span>
        </p>
      </section>

      {/* 2. 架構圖 */}
      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">2. 架構圖</h2>
        <p className="text-muted-foreground mb-3 text-xs">
          實線＝正常資料流（Phase 1 逐頁抓取寫 staging、Phase 2 單一交易切換）；虛線＝swap
          失敗後的重播路徑；標記重點的方塊是本範例的核心機制節點。畫面較窄時可左右捲動。
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
          藍色實線＝來源回傳 0 筆時直接收尾（跳過 Phase 2）；虛線＝crash
          recovery（取得全域鎖後發現殘留執行才會走的分支），與同一對狀態間的正常失敗路徑刻意分開畫。
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
              <CardTitle>鎖 vs fencing</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs/relaxed">
              advisory lock 綁在 PostgreSQL session（連線）上：連線斷線鎖會自動釋放，但持有該連線的
              worker 進程未必真的停止，仍可能繼續寫入（stale writer）。<code>owner_token</code>／
              <code>lease_version</code> 讓每次狀態轉移都必須「連同上一輪憑證」送出，資料庫端以{" "}
              <code>WHERE id AND phase AND owner_token AND lease_version</code> 做 CAS，對不上就拋{" "}
              <code>FenceLostError</code>。
              <span className="font-medium"> 鎖＝誰先開始，fencing＝誰現在還算數。</span>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>partial unique index 最後防線</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs/relaxed">
              <code>uq_sync_runs_active</code> 建在 <code>sync_type</code> 上、
              <code>
                WHERE phase IN (&apos;fetching&apos;,&apos;staged&apos;,&apos;swapping&apos;)
              </code>
              。即使應用層的鎖與狀態機邏輯被程式疏漏繞過，insert 撞 <code>23505</code>{" "}
              仍會被資料庫擋下，轉譯成 <code>ActiveSyncRunError</code>
              ——可靠性不建立在「所有呼叫路徑都記得先取鎖」的假設上。
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>業務鍵合併，不用本地自增 PK</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs/relaxed">
              合併一律用來源業務鍵（<code>sourceListId</code>／<code>sourceItemId</code>）當
              conflict target，不用本地 <code>id</code>。全量刷新每次都可能整批換一輪本地 PK
              世代；用本地 PK 做關聯的邏輯，下一輪同步後全部失效，會看到大量對不上的孤兒。衍生欄位{" "}
              <code>position</code> 也只能在合併完成、<code>is_active</code> 底定後，於切換交易內用
              window function 重新算過。
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>swap 失敗不必重抓，直接重播</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs/relaxed">
              切換交易失敗只 rollback「合併到目標表」這個動作，不影響已逐頁寫入且獨立提交的 staging
              資料——staged 資料集完整保留。下次觸發時直接把同一份 fence 交回去重播 Phase
              2，完全不需要重新對來源服務發出請求（Phase 1 的網路 I/O 成本遠高於 Phase 2）。
            </CardContent>
          </Card>
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>MVCC 讀者不見中間態，代價是寫入者要等鎖</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs/relaxed">
              mark-and-sweep（先整批 <code>is_active=false</code>，再依 staging 內容 upsert
              復活）在單一交易內完成，其他連線 commit 前只看得到舊資料，commit
              後立刻看到新資料——沒有第三種「mark 完、merge 一半」的中間可見狀態。代價是切換交易持有
              目標表大量列鎖，這段期間其他<span className="font-medium">寫入者</span>
              （非讀取者）會被鎖等待，直到 commit 或 rollback。
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
                確認下方 mock 模式是 <span className="font-mono">success</span>（或按「重置」）。
              </li>
              <li>
                按「觸發同步」，稍等即完成：runs 列表新增一筆{" "}
                <span className="font-mono">done</span>／<span className="font-mono">success</span>
                ，下方「目前生效目錄」卡片會出現清單。
              </li>
              <li>
                把模式切成 <span className="font-mono">empty</span>，再按一次「觸發同步」：這次是{" "}
                <span className="font-mono">no_data</span>，Phase 2
                完全沒發生，目錄維持上一次同步的內容不變。
              </li>
              <li>
                把模式切成 <span className="font-mono">fail</span>，再按一次「觸發同步」：這次整個
                Phase 1 都失敗、<span className="font-mono">fetch_failed</span>
                ，目錄同樣不變——對照第 1 章：即使抓到一半失敗，也不會出現「目錄被刪一半」的假象，
                因為 merge 根本沒發生。
              </li>
              <li>
                想觀察重試與 crash recovery，可以切 <span className="font-mono">fail_page_2</span>{" "}
                或 <span className="font-mono">flaky_page_2</span>，對照第 3 章狀態機圖。
              </li>
              <li>
                <span className="font-mono">staged</span> 狀態的執行列可以按「放棄」並填寫原因，觀察
                phase 變成 <span className="font-mono">abandoned</span>。
              </li>
            </ol>
          </CardContent>
        </Card>

        {runsError ? (
          <p className="text-destructive mb-4 text-xs">runs 讀取失敗：{runsError}</p>
        ) : null}
        {catalogError ? (
          <p className="text-destructive mb-4 text-xs">目錄讀取失敗：{catalogError}</p>
        ) : null}

        <Card className="mb-4">
          <CardHeader>
            <CardTitle>操作</CardTitle>
            <CardDescription>
              目前 mock 範本庫模式：
              <span className="font-mono">{mode ?? "未知（尚未切換）"}</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div>
              <p className="text-muted-foreground mb-2 text-xs">切換 mock 範本庫模式：</p>
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
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={resettingMock}
                  title="模式回 success、flaky 重試計數器歸零"
                  onClick={handleResetMock}
                >
                  <RotateCcw className={resettingMock ? "size-3.5 animate-spin" : "size-3.5"} />
                  重置
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={triggering} onClick={handleTrigger}>
                <RefreshCcw className={triggering ? "size-3.5 animate-spin" : "size-3.5"} />
                觸發同步
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-4">
          <CardHeader>
            <CardTitle>最近 20 筆同步執行紀錄</CardTitle>
            <CardDescription>每 4 秒自動輪詢一次</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {runsLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : runs.length === 0 ? (
              <p className="text-muted-foreground text-xs">目前沒有任何同步執行紀錄。</p>
            ) : (
              <table className="w-full min-w-[980px] border-collapse text-left text-xs">
                <thead>
                  <tr className="border-border border-b">
                    <th className="py-1.5 pr-3 font-medium">id</th>
                    <th className="py-1.5 pr-3 font-medium">phase</th>
                    <th className="py-1.5 pr-3 font-medium">resultCode</th>
                    <th className="py-1.5 pr-3 font-medium">pageCount</th>
                    <th className="py-1.5 pr-3 font-medium">sourceCount</th>
                    <th className="py-1.5 pr-3 font-medium">stagedCounts</th>
                    <th className="py-1.5 pr-3 font-medium">swapAttempts</th>
                    <th className="py-1.5 pr-3 font-medium">fetchSeconds</th>
                    <th className="py-1.5 pr-3 font-medium">swapSeconds</th>
                    <th className="py-1.5 pr-3 font-medium">errorMessage</th>
                    <th className="py-1.5 pr-3 font-medium">startedAt</th>
                    <th className="py-1.5 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} className="border-border/60 border-b last:border-0">
                      <td className="py-1.5 pr-3 font-mono">{run.id}</td>
                      <td className="py-1.5 pr-3">
                        <PhaseBadge phase={run.phase} />
                      </td>
                      <td className="py-1.5 pr-3">
                        <ResultCodeBadge resultCode={run.resultCode} />
                      </td>
                      <td className="py-1.5 pr-3 font-mono">{run.pageCount ?? "—"}</td>
                      <td className="py-1.5 pr-3 font-mono">{run.sourceCount ?? "—"}</td>
                      <td className="py-1.5 pr-3 font-mono whitespace-nowrap">
                        {formatStagedCounts(run.stagedCounts)}
                      </td>
                      <td className="py-1.5 pr-3 font-mono">{run.swapAttempts}</td>
                      <td className="py-1.5 pr-3 font-mono">{formatSeconds(run.fetchSeconds)}</td>
                      <td className="py-1.5 pr-3 font-mono">{formatSeconds(run.swapSeconds)}</td>
                      <td
                        className="text-muted-foreground max-w-[200px] truncate py-1.5 pr-3"
                        title={run.errorMessage ?? undefined}
                      >
                        {run.errorMessage ?? "—"}
                      </td>
                      <td className="py-1.5 pr-3 font-mono whitespace-nowrap">
                        {formatDateTime(run.startedAt)}
                      </td>
                      <td className="py-1.5 whitespace-nowrap">
                        {run.phase === "staged" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={abandoningRunId === run.id}
                            onClick={() => openAbandonForm(run.id)}
                          >
                            {abandoningRunId === run.id ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : null}
                            放棄
                          </Button>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {abandonTargetId !== null ? (
              <div className="border-border mt-3 flex flex-col gap-2 border p-3">
                <p className="text-xs font-medium">
                  放棄 run #{abandonTargetId}：請填寫原因（必填）
                </p>
                <Input
                  value={abandonReason}
                  onChange={(e) => setAbandonReason(e.target.value)}
                  placeholder="例如：demo 手動放棄，觀察 abandoned 狀態"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleConfirmAbandon}>
                    確認放棄
                  </Button>
                  <Button size="sm" variant="outline" onClick={closeAbandonForm}>
                    取消
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>目前生效目錄</CardTitle>
            <CardDescription>
              is_active=true 的範本清單／項目／標籤；同步成功（resultCode=success）後自動刷新
            </CardDescription>
          </CardHeader>
          <CardContent className="max-h-96 overflow-y-auto">
            {catalogLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : sortedLists.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                目前沒有任何生效中的範本清單（尚未同步成功，或最近一次同步是 no_data）。
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-muted-foreground text-xs">共 {sortedLists.length} 個清單</p>
                {sortedLists.map((list) => (
                  <div key={list.sourceListId} className="border-border border p-2">
                    <p className="text-xs font-medium">
                      #{list.sourceListId} {list.title}
                    </p>
                    {list.description ? (
                      <p className="text-muted-foreground text-[11px]">{list.description}</p>
                    ) : null}
                    <ul className="mt-1 flex flex-col gap-1">
                      {[...list.items]
                        .sort((a, b) => a.position - b.position)
                        .map((item) => (
                          <li key={item.sourceItemId} className="text-[11px]">
                            <span className="font-mono">
                              #{item.position}（source={item.sourceItemId}, priority=
                              {item.priority}）
                            </span>{" "}
                            {item.title}
                            {item.tags.length > 0 ? (
                              <span className="text-muted-foreground">
                                {" "}
                                [{item.tags.join(", ")}]
                              </span>
                            ) : null}
                          </li>
                        ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
