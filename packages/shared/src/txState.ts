/**
 * Explicit transaction lifecycle. A transaction is only ever "confirmed" after the chain says so;
 * "submitted" never implies success.
 */
export const TX_STATES = [
  'draft', // built locally, not yet authorised
  'simulating',
  'simulation_failed',
  'awaiting_approval', // waiting for the user's explicit confirmation
  'signing',
  'submitted', // RPC accepted the raw tx; hash known
  'pending', // seen by a node / in mempool, not yet included
  'confirmed', // included and succeeded at the network's finality rule
  'failed', // included and reverted, or rejected by the RPC
  'expired', // deadline passed / blockhash expired without inclusion
  'replaced', // superseded by another tx with the same nonce
  'unknown', // could not determine (e.g. RPC outage); requires reconciliation
  'cancelled', // user aborted before submission
] as const;

export type TxState = (typeof TX_STATES)[number];

const TRANSITIONS: Record<TxState, readonly TxState[]> = {
  draft: ['simulating', 'awaiting_approval', 'cancelled'],
  simulating: ['simulation_failed', 'awaiting_approval', 'cancelled'],
  simulation_failed: ['cancelled', 'simulating'],
  awaiting_approval: ['signing', 'cancelled', 'expired'],
  signing: ['submitted', 'failed', 'cancelled'],
  submitted: ['pending', 'confirmed', 'failed', 'expired', 'replaced', 'unknown'],
  pending: ['confirmed', 'failed', 'expired', 'replaced', 'unknown'],
  unknown: ['pending', 'confirmed', 'failed', 'expired', 'replaced', 'unknown'],
  confirmed: [],
  failed: [],
  expired: [],
  replaced: [],
  cancelled: [],
};

export const TERMINAL_TX_STATES: ReadonlySet<TxState> = new Set([
  'confirmed',
  'failed',
  'expired',
  'replaced',
  'cancelled',
  'simulation_failed',
]);

export function canTransition(from: TxState, to: TxState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTxTransition extends Error {
  constructor(
    public readonly from: TxState,
    public readonly to: TxState,
  ) {
    super(`Invalid transaction state transition ${from} → ${to}`);
  }
}

export function transition(from: TxState, to: TxState): TxState {
  if (!canTransition(from, to)) throw new InvalidTxTransition(from, to);
  return to;
}

/** States after which the funds may have moved (used for duplicate protection). */
export function isInFlightOrDone(s: TxState): boolean {
  return ['signing', 'submitted', 'pending', 'unknown', 'confirmed'].includes(s);
}
