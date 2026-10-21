// Dev probe: enrolls a throwaway testnet API key and signs in on the trading socket, using the same
// WebCrypto Ed25519 + EIP-712 steps as apps/web/src/lib/perps/perpl.ts. No funds needed.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hashTypedData } from 'viem';
const API = 'https://testnet.perpl.xyz/api',
  WS = 'wss://testnet.perpl.xyz',
  CHAIN = 10143;
const hex = (u) => Buffer.from(u).toString('hex');
const acct = privateKeyToAccount(generatePrivateKey());
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
const pubHex = hex(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
const j = async (path, body) => {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(path + ' ' + r.status + ' ' + t);
  return JSON.parse(t);
};
const { typed_data, mac } = await j('/v1/api-key/payload', {
  chain_id: CHAIN,
  address: acct.address,
  public_key: '0x' + pubHex,
  scope_mask: 3,
  label: 'Chog probe',
});
const { EIP712Domain, ...types } = typed_data.types;
const ints = (fields, obj) =>
  Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k,
      /^u?int/.test(fields.find((f) => f.name === k)?.type ?? '') ? BigInt(v) : v,
    ]),
  );
const def = {
  domain: ints(EIP712Domain, typed_data.domain),
  types,
  primaryType: typed_data.primaryType,
  message: ints(types[typed_data.primaryType], typed_data.message),
};
const signature = await acct.signTypedData(def);
const digest = hashTypedData(def);
const pop = new Uint8Array(
  await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, Buffer.from(digest.slice(2), 'hex')),
);
const en = await j('/v1/api-key/enroll', {
  chain_id: CHAIN,
  address: acct.address,
  typed_data,
  mac,
  signature,
  pop_signature: '0x' + hex(pop),
});
console.log(
  'enrolled',
  en.api_key.api_key.slice(0, 6) + '…',
  'origin=' + JSON.stringify(en.api_key.origin),
  'scope',
  en.api_key.scope_mask,
);
const ws = new WebSocket(WS + '/ws/v1/trading');
ws.onopen = async () => {
  const timestamp = String(Date.now()),
    nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'Ed25519' },
      kp.privateKey,
      new TextEncoder().encode([CHAIN, 'trading-ws-signin', timestamp, nonce].join('\n')),
    ),
  );
  ws.send(
    JSON.stringify({
      mt: 29,
      chain_id: CHAIN,
      api_key: en.api_key.api_key,
      timestamp,
      nonce,
      signature: Buffer.from(sig).toString('base64url'),
    }),
  );
};
let n = 0;
ws.onmessage = (e) => {
  console.log('msg', String(e.data).slice(0, 160));
  if (++n >= 4) {
    ws.close();
  }
};
ws.onclose = (e) => {
  console.log('closed', e.code, e.reason);
  process.exit(0);
};
setTimeout(() => process.exit(1), 15000);
