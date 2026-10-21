import { mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { perpsConfigViolations, type PerpsTaskConfig } from '@chog/shared';

export type TaskState = 'starting' | 'running' | 'paused' | 'stopping' | 'stopped' | 'error';

export interface LogLine {
  seq: number;
  at: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

/** What an adapter receives. Deliberately narrow: no filesystem/env access beyond its own dir. */
export interface TaskContext {
  taskId: string;
  config: PerpsTaskConfig;
  /** Private working directory for this task (isolated per task). */
  dataDir: string;
  signal: AbortSignal;
  log: (level: LogLine['level'], msg: string) => void;
  /** Adapter reports position/order snapshots shown in the UI. */
  report: (status: Record<string, unknown>) => void;
}

export interface FarmingAdapter {
  readonly id: string;
  readonly name: string;
  /** null = ready; otherwise the reason it cannot run (e.g. software not installed yet). */
  unavailableReason(): string | null;
  supportedOrderTypes(): { entry: Array<'market' | 'limit'>; exit: Array<'market' | 'limit'> };
  start(ctx: TaskContext): Promise<void>;
  pause(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  stop(taskId: string): Promise<void>;
}

interface Task {
  id: string;
  adapter: FarmingAdapter;
  config: PerpsTaskConfig;
  state: TaskState;
  startedAt: number;
  logs: LogLine[];
  seq: number;
  status: Record<string, unknown>;
  abort: AbortController;
  runtimeTimer: NodeJS.Timeout;
  error: string | null;
}

const MAX_LOGS = 500;
const SECRET_RE =
  /(0x[0-9a-fA-F]{64,})|([1-9A-HJ-NP-Za-km-z]{80,})|((?:private[_ ]?key|secret|mnemonic|seed)\s*[:=]\s*\S+)/gi;

export function sanitizeLog(s: string) {
  return s.replace(SECRET_RE, '[redacted]').slice(0, 500);
}

export class TaskManager {
  private tasks = new Map<string, Task>();

  constructor(
    private readonly adapters: Map<string, FarmingAdapter>,
    private readonly dataRoot: string,
    private readonly maxTasks = 8,
  ) {}

  listAdapters() {
    return [...this.adapters.values()].map((a) => ({
      id: a.id,
      name: a.name,
      available: a.unavailableReason() === null,
      reason: a.unavailableReason(),
      orderTypes: a.supportedOrderTypes(),
    }));
  }

  status() {
    return [...this.tasks.values()].map((t) => ({
      id: t.id,
      platform: t.adapter.id,
      state: t.state,
      startedAt: t.startedAt,
      pair: t.config.pair,
      status: t.status,
      error: t.error,
    }));
  }

  /** Per-task directory, guaranteed to be inside dataRoot (no path traversal). */
  private taskDir(taskId: string) {
    const root = resolve(this.dataRoot);
    const dir = resolve(root, 'tasks', taskId);
    if (!dir.startsWith(root + sep)) throw new Error('Invalid task directory');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  async start(taskId: string, config: PerpsTaskConfig) {
    if (this.tasks.has(taskId) && !['stopped', 'error'].includes(this.tasks.get(taskId)!.state))
      throw new Error('Task already running');
    const active = [...this.tasks.values()].filter((t) => !['stopped', 'error'].includes(t.state)).length;
    if (active >= this.maxTasks) throw new Error(`At most ${this.maxTasks} concurrent tasks`);
    const adapter = this.adapters.get(config.platform);
    if (!adapter) throw new Error('Unknown platform');
    const why = adapter.unavailableReason();
    if (why) throw new Error(why);
    const violations = perpsConfigViolations(config);
    if (violations.length) throw new Error(`Risk limits violated: ${violations.join('; ')}`);
    const ot = adapter.supportedOrderTypes();
    if (!ot.entry.includes(config.entry) || !ot.exit.includes(config.exit))
      throw new Error('Order type combination not supported by this platform');

    const abort = new AbortController();
    const task: Task = {
      id: taskId,
      adapter,
      config,
      state: 'starting',
      startedAt: Date.now(),
      logs: [],
      seq: 0,
      status: {},
      abort,
      error: null,
      runtimeTimer: setTimeout(() => {
        this.push(task, 'warn', `Max runtime ${config.risk.maxRuntimeMin} min reached — stopping`);
        void this.stop(taskId);
      }, config.risk.maxRuntimeMin * 60_000),
    };
    task.runtimeTimer.unref();
    this.tasks.set(taskId, task);
    const ctx: TaskContext = {
      taskId,
      config,
      dataDir: this.taskDir(taskId),
      signal: abort.signal,
      log: (level, msg) => this.push(task, level, msg),
      report: (s) => {
        task.status = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
      },
    };
    try {
      await adapter.start(ctx);
      if (task.state === 'starting') task.state = 'running';
      this.push(
        task,
        'info',
        `Task started on ${adapter.name} (${config.pair}, ${config.direction}, $${config.sizeUsd} @ ${config.leverage}x)`,
      );
    } catch (e) {
      task.state = 'error';
      task.error = sanitizeLog(e instanceof Error ? e.message : String(e));
      clearTimeout(task.runtimeTimer);
      this.push(task, 'error', `Start failed: ${task.error}`);
    }
    return task.state;
  }

  async pause(taskId: string) {
    const t = this.get(taskId);
    if (t.state !== 'running') throw new Error('Task is not running');
    await t.adapter.pause(taskId);
    t.state = 'paused';
    this.push(t, 'info', 'Paused');
  }

  async resume(taskId: string) {
    const t = this.get(taskId);
    if (t.state !== 'paused') throw new Error('Task is not paused');
    await t.adapter.resume(taskId);
    t.state = 'running';
    this.push(t, 'info', 'Resumed');
  }

  async stop(taskId: string) {
    const t = this.get(taskId);
    if (t.state === 'stopped') return;
    t.state = 'stopping';
    t.abort.abort();
    clearTimeout(t.runtimeTimer);
    try {
      await t.adapter.stop(taskId);
      t.state = 'stopped';
      this.push(t, 'info', 'Stopped');
    } catch (e) {
      t.state = 'error';
      t.error = sanitizeLog(e instanceof Error ? e.message : String(e));
      this.push(t, 'error', `Stop failed: ${t.error} — check the platform UI for open positions`);
    }
  }

  async stopAll() {
    await Promise.all(
      [...this.tasks.values()]
        .filter((t) => !['stopped', 'error'].includes(t.state))
        .map((t) => this.stop(t.id)),
    );
  }

  async pauseAll(reason: string) {
    for (const t of this.tasks.values()) {
      if (t.state !== 'running') continue;
      await this.pause(t.id).catch(() => {});
      this.push(t, 'warn', `Auto-paused: ${reason}`);
    }
  }

  logs(taskId: string, since = 0) {
    return this.get(taskId).logs.filter((l) => l.seq > since);
  }

  private get(taskId: string) {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error('Unknown task');
    return t;
  }

  private push(t: Task, level: LogLine['level'], msg: string) {
    t.logs.push({ seq: ++t.seq, at: Date.now(), level, msg: sanitizeLog(msg) });
    if (t.logs.length > MAX_LOGS) t.logs.splice(0, t.logs.length - MAX_LOGS);
  }
}

export const dataRootDefault = (home: string) => join(home, '.chog-agent');
