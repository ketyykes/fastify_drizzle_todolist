// 維運指令：把 dead 訊息重新排回 pending。--id=1,2 指定筆數，省略則重排全部
// dead 訊息；帶了 --id 但空值或含非數字一律報錯退出，避免打錯字誤觸全部重排。
// 用法：pnpm --filter server outbox:requeue-dead [--id=1,2]

import { fileURLToPath } from "node:url";

import { requeueDead } from "../outbox/repository";

export type ParseRequeueDeadArgsResult =
  { ok: true; ids?: number[] } | { ok: false; error: string };

/**
 * 解析 --id=1,2 參數。純函式，方便單元測試邊界情況。
 */
export function parseRequeueDeadArgs(argv: string[]): ParseRequeueDeadArgsResult {
  const idArg = argv.find((arg) => arg.startsWith("--id="));
  if (!idArg) {
    return { ok: true, ids: undefined };
  }

  const raw = idArg.slice("--id=".length).trim();
  if (raw === "") {
    return {
      ok: false,
      error: "--id 不可為空值（省略 --id 才代表重排全部 dead 訊息）",
    };
  }

  const parts = raw.split(",").map((part) => part.trim());
  const ids: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return { ok: false, error: `--id 含無效數字：「${part}」` };
    }
    const id = Number(part);
    if (id <= 0) {
      return { ok: false, error: `--id 含無效數字：「${part}」` };
    }
    ids.push(id);
  }

  return { ok: true, ids };
}

async function main(): Promise<void> {
  const parsed = parseRequeueDeadArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`[outbox-requeue-dead] ${parsed.error}`);
    process.exitCode = 1;
    return;
  }

  const requeued = await requeueDead(parsed.ids);
  console.log(`[outbox-requeue-dead] 已重排 ${requeued} 筆 dead 訊息回 pending`);
}

// 只有直接執行本檔（tsx src/scripts/outbox-requeue-dead.ts）才跑 main，
// 被測試檔 import 時不觸發（避免單元測試連到 DB）。
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  void main();
}
