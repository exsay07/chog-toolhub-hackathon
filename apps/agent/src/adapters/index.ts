import type { FarmingAdapter, TaskContext } from '../tasks.js';

/**
 * Integration boundary for the user's Perpl / Bulk farming software.
 *
 * The software has NOT been provided yet, so both adapters report themselves unavailable and refuse
 * to start. Nothing here simulates trading. When the software arrives it will be reviewed file by
 * file (see apps/agent/adapters/README.md) and wired in by implementing FarmingAdapter — typically via
 * `spawnIsolated` from ./process.ts so it runs as a child process with a scrubbed environment.
 */
class AwaitingSoftwareAdapter implements FarmingAdapter {
  constructor(
    readonly id: string,
    readonly name: string,
    private readonly orderTypes: ReturnType<FarmingAdapter['supportedOrderTypes']>,
  ) {}
  unavailableReason() {
    return `${this.name} farming software not installed yet — awaiting review and integration (apps/agent/adapters/README.md)`;
  }
  supportedOrderTypes() {
    return this.orderTypes;
  }
  async start(_ctx: TaskContext): Promise<void> {
    throw new Error(this.unavailableReason());
  }
  async pause() {}
  async resume() {}
  async stop() {}
}

export function defaultAdapters(): Map<string, FarmingAdapter> {
  return new Map<string, FarmingAdapter>([
    // Order types per public docs (Bulk: docs.bulk.trade/bulk-exchange/Order-Types; Perpl: dex-sdk order builders).
    // To be re-confirmed against the provided software before enabling.
    [
      'perpl',
      new AwaitingSoftwareAdapter('perpl', 'Perpl', {
        entry: ['market', 'limit'],
        exit: ['market', 'limit'],
      }),
    ],
    [
      'bulk',
      new AwaitingSoftwareAdapter('bulk', 'Bulk', { entry: ['market', 'limit'], exit: ['market', 'limit'] }),
    ],
  ]);
}
