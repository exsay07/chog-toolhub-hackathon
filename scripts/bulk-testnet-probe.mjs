// Dev probe for Bulk testnet (no real funds). Two throwaway accounts: each owner authorises a
// browser-style agent in the Phantom-compatible "base58" wallet mode and claims the faucet through
// it. Account B quotes both sides (testnet books are empty), account A then: rests a post-only
// order and cancels it, opens at market against B, and closes reduce-only.
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import {
  initSync,
  prepareAgentWallet,
  prepareFaucet,
  prepareOrder,
  prepareWalletMessage,
  finalizeWalletMessage,
} from 'bulk-keychain-wasm';
initSync({
  module: readFileSync(
    new URL('../node_modules/bulk-keychain-wasm/bulk_keychain_wasm_bg.wasm', import.meta.url),
  ),
});
const API = 'https://exchange-api.bulk.trade/api/v1',
  DOMAIN = 'testnet',
  SYM = 'SOL-USD';
const key = async () => {
  const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  return { k, pub: bs58.encode(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))) };
};
const sign = async (k, bytes) =>
  bs58.encode(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, k.privateKey, bytes)));
const send = async (tx, mode) => {
  const r = await fetch(API + '/order', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(mode ? { 'x-bulk-sig-mode': mode } : {}) },
    body: JSON.stringify({
      ...tx,
      actions: typeof tx.actions === 'string' ? JSON.parse(tx.actions) : tx.actions,
    }),
  });
  const j = await r.json();
  return j.response?.data?.statuses ?? j;
};
const order = (o) => ({ type: 'order', symbol: SYM, reduceOnly: false, iso: false, ...o });
const mkt = (isBuy, size, reduceOnly = false) =>
  order({ isBuy, price: 0, size, reduceOnly, orderType: { type: 'market', isMarket: true, triggerPx: 0 } });
const alo = (isBuy, price, size) => order({ isBuy, price, size, orderType: { type: 'limit', tif: 'ALO' } });

async function account(name) {
  const owner = await key(),
    agent = await key();
  const opts = () => ({ signatureDomain: DOMAIN, account: owner.pub, signer: agent.pub });
  const act = async (p) => send(p.finalize(await sign(agent.k, p.messageBytes)));
  const w = prepareWalletMessage(
    prepareAgentWallet(agent.pub, false, { signatureDomain: DOMAIN, account: owner.pub, signer: owner.pub }),
    'base58',
  );
  const reg = await send(finalizeWalletMessage(w, await sign(owner.k, w.messageBytes)), 'base58');
  const fau = await act(prepareFaucet(opts()));
  console.log(name, 'agent', Object.keys(reg[0] ?? {})[0], 'faucet', JSON.stringify(fau[0]));
  return {
    order: (o) => act(prepareOrder(o, opts())),
    state: async () =>
      (
        await (
          await fetch(API + '/account', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'fullAccount', user: owner.pub }),
          })
        ).json()
      )[0].fullAccount,
  };
}

const A = await account('A'),
  B = await account('B');
const mid = 100,
  size = 0.6; // $60 notional (min $50)
console.log('B ask:', JSON.stringify(await B.order(alo(false, mid + 0.5, 5))));
console.log('B bid:', JSON.stringify(await B.order(alo(true, mid - 0.5, 5))));
const rest = await A.order(alo(true, mid - 2, size));
console.log('A ALO:', JSON.stringify(rest));
console.log(
  'A cancel:',
  JSON.stringify(await A.order({ type: 'cancel', symbol: SYM, orderId: rest[0].resting.oid })),
);
console.log('A mkt buy:', JSON.stringify(await A.order(mkt(true, size))));
let s = await A.state();
console.log('A pos:', JSON.stringify(s.positions.map((p) => ({ size: p.size, px: p.price }))));
console.log('A close:', JSON.stringify(await A.order(mkt(false, size, true))));
s = await A.state();
console.log('A after: positions', s.positions.length, 'margin', JSON.stringify(s.margin));
