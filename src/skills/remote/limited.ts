/**
 * 并发上限调度（D-B18）。
 *
 * 从 repo-discovery.ts 抽出来共用：发现要按仓库限流下载 tar.gz，
 * 检查更新 / 安装 / 应用更新要按 repo+ref 限流请求目录树 —— 三处是同一套调度。
 *
 * `createLimiter` 是给「一次操作内跨批次共享同一个上限」用的：检查更新里多个仓库并行、
 * 每个仓库下又有一批 raw 文件，必须共用一个闸门，否则上限会被乘开（4 组 × 每组 12 个）。
 */

/** 并发上限内依次跑完（limit 至少按 1 算；items 为空时直接返回空数组）。 */
export async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      out[index] = await run(items[index]!);
    }
  }
  const workers = Math.min(Math.max(limit, 1), items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

/** 一次操作共用的并发闸门：同一时刻最多有 limit 个 run 在飞。 */
export type Limiter = <R>(run: () => Promise<R>) => Promise<R>;

/**
 * 造一个并发闸门（先到先服务，无队列上限 —— 调用方自己控制提交量）。
 *
 * 不在这里做「结果顺序」的事：调用方用 mapLimited 拿回有序数组，闸门只管放行。
 */
export function createLimiter(limit: number): Limiter {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiting: (() => void)[] = [];

  const acquire = async (): Promise<void> => {
    if (active < max) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    // 被唤醒时名额已经由释放方转交，这里直接开始
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next !== undefined) {
      next();
      return;
    }
    active--;
  };

  return async <R>(run: () => Promise<R>): Promise<R> => {
    await acquire();
    try {
      return await run();
    } finally {
      release();
    }
  };
}
