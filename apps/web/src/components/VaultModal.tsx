import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { base58Encode } from '@chog/shared';
import { put } from '../lib/api';
import { useVault } from '../lib/vault/useVault';
import {
  destroyVault,
  exportSecrets,
  generateSecrets,
  lock,
  parseImport,
  saveNewVault,
  setAutoLockMinutes,
  unlock,
} from '../lib/vault/vault';
import { passwordProblems } from '../lib/vault/crypto';
import { walletsOf } from '../lib/vault/vault';
import { registerExtras, WalletsPanel } from './WalletsPanel';
import { Button, Copy, Field, Input, Modal, Notice, Select } from './ui';

type Step = 'intro' | 'backup' | 'password' | 'import';

async function register(evm: string, solana: string) {
  await put('/api/trading-wallets', { evm, solana });
}

export function VaultModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { vault, unlocked } = useVault();
  return (
    <Modal open={open} onClose={onClose} title="Trading wallet" width={600}>
      {vault === undefined ? null : vault === null ? (
        <Create onDone={onClose} />
      ) : unlocked ? (
        <Unlocked onClose={onClose} />
      ) : (
        <Unlock onDone={onClose} />
      )}
    </Modal>
  );
}

function Risks() {
  return (
    <Notice tone="warn">
      <b>How this wallet works.</b> Keys are generated in this browser and stored only here, encrypted with
      your password (PBKDF2 600k + AES-256-GCM). Chog Toolhub servers never receive them and{' '}
      <b>cannot recover them</b>. Anyone who gets your password <i>and</i> this browser profile — or malware,
      a malicious extension, or a script injected into this page while unlocked — could move funds. Keep only
      trading amounts here, lock when idle, and back up the keys offline.
    </Notice>
  );
}

function Create({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>('intro');
  const [gen, setGen] = useState<Awaited<ReturnType<typeof generateSecrets>> | null>(null);
  const [saved, setSaved] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [ik, setIk] = useState({ evm: '', sol: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const probs = passwordProblems(pw);

  const finish = async () => {
    if (!gen) return;
    setBusy(true);
    setErr(null);
    try {
      await saveNewVault(gen, pw);
      await unlock(pw);
      await register(gen.evmAddress, gen.solanaAddress);
      await qc.invalidateQueries({ queryKey: ['trading-wallets'] });
      setGen(null);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'intro')
    return (
      <div className="space-y-3">
        <p className="text-text-2">
          Your trading wallet is separate from the wallet you signed in with. NFT ownership only grants app
          access — it never authorises trades.
        </p>
        <Risks />
        <p className="text-xs text-muted">
          Nothing is funded or traded automatically. You deposit what you want to trade with.
        </p>
        <div className="flex gap-2 justify-end">
          <Button onClick={() => setStep('import')}>Import existing keys</Button>
          <Button
            variant="primary"
            onClick={async () => {
              setGen(await generateSecrets());
              setStep('backup');
            }}
          >
            Create new wallet
          </Button>
        </div>
      </div>
    );

  if (step === 'import')
    return (
      <div className="space-y-3">
        <Risks />
        <Field label="EVM private key (hex)">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={ik.evm}
            onChange={(e) => setIk({ ...ik, evm: e.target.value })}
          />
        </Field>
        <Field label="Solana secret key (base58 or JSON array)">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={ik.sol}
            onChange={(e) => setIk({ ...ik, sol: e.target.value })}
          />
        </Field>
        {err && <div className="text-down text-xs">{err}</div>}
        <div className="flex gap-2 justify-end">
          <Button onClick={() => setStep('intro')}>Back</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                setGen(await parseImport(ik.evm, ik.sol));
                setIk({ evm: '', sol: '' });
                setSaved(true);
                setErr(null);
                setStep('password');
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            Continue
          </Button>
        </div>
      </div>
    );

  if (step === 'backup' && gen)
    return (
      <div className="space-y-3">
        <Notice tone="down">
          Write these down offline. Anyone with them controls the funds. They will not be shown again unless
          you use “Export”.
        </Notice>
        <Secret label={`EVM key · ${gen.evmAddress}`} value={gen.evmPrivateKey} />
        <Secret label={`Solana key (base58) · ${gen.solanaAddress}`} value={exportSol(gen.solanaSecretKey)} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have backed
          up both keys somewhere safe
        </label>
        <div className="flex justify-end">
          <Button variant="primary" disabled={!saved} onClick={() => setStep('password')}>
            Continue
          </Button>
        </div>
      </div>
    );

  return (
    <div className="space-y-3">
      <p className="text-text-2 text-sm">
        Choose a password to encrypt the wallet on this device. It cannot be reset.
      </p>
      <Field label="Password" error={pw && probs.length ? probs.join(' · ') : null}>
        <Input
          type="password"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      </Field>
      <Field label="Confirm password" error={pw2 && pw2 !== pw ? 'Passwords differ' : null}>
        <Input
          type="password"
          autoComplete="new-password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
        />
      </Field>
      {err && <div className="text-down text-xs">{err}</div>}
      <div className="flex justify-end">
        <Button
          variant="primary"
          loading={busy}
          disabled={probs.length > 0 || pw !== pw2}
          onClick={() => void finish()}
        >
          Encrypt &amp; save
        </Button>
      </div>
    </div>
  );
}

/** Solana keys are shown in base58 — the format Phantom/Solflare import and our import accepts. */
function exportSol(b64: string) {
  return base58Encode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

function Secret({ label, value }: { label: string; value: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="rounded-[var(--radius-sm)] border border-line bg-surface-2 p-2">
      <div className="flex items-center justify-between text-[11px] text-muted mb-1">
        <span className="truncate">{label}</span>
        <span className="flex gap-2">
          <button className="hover:text-text" onClick={() => setShow((s) => !s)}>
            {show ? 'Hide' : 'Reveal'}
          </button>
          <Copy text={value} label="Copy" />
        </span>
      </div>
      <div className="num text-xs break-all select-all">{show ? value : '•'.repeat(48)}</div>
    </div>
  );
}

function Unlock({ onDone }: { onDone: () => void }) {
  const { vault } = useVault();
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDestroy, setConfirmDestroy] = useState('');
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        unlock(pw)
          .then(() => register(vault!.evmAddress, vault!.solanaAddress))
          .then(() => (vault!.extras?.length ? registerExtras(walletsOf(vault)) : undefined))
          .then(() => {
            setPw('');
            onDone();
          })
          .catch((x: Error) => setErr(x.message))
          .finally(() => setBusy(false));
      }}
    >
      <div className="text-xs text-muted num">
        EVM {vault?.evmAddress}
        <br />
        SOL {vault?.solanaAddress}
      </div>
      <Field label="Password" error={err}>
        <Input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      </Field>
      <div className="flex justify-end">
        <Button variant="primary" type="submit" loading={busy}>
          Unlock
        </Button>
      </div>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer">Remove wallet from this device</summary>
        <div className="mt-2 space-y-2">
          <Notice tone="down">
            This deletes the encrypted keys from this browser. Without your backup, funds become
            unrecoverable.
          </Notice>
          <Input
            placeholder='Type "DELETE" to confirm'
            value={confirmDestroy}
            onChange={(e) => setConfirmDestroy(e.target.value)}
          />
          <Button
            variant="danger"
            size="sm"
            disabled={confirmDestroy !== 'DELETE'}
            onClick={() =>
              void destroyVault().then(() => put('/api/trading-wallets', { evm: null, solana: null }))
            }
          >
            Delete local wallet
          </Button>
        </div>
      </details>
    </form>
  );
}

function Unlocked({ onClose }: { onClose: () => void }) {
  const { vault } = useVault();
  const [pw, setPw] = useState('');
  const [exp, setExp] = useState<Awaited<ReturnType<typeof exportSecrets>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[80px_1fr_auto] gap-x-2 gap-y-1 text-xs items-center">
        <span className="text-muted">EVM</span>
        <span className="num break-all">{vault?.evmAddress}</span>
        <Copy text={vault?.evmAddress ?? ''} />
        <span className="text-muted">Solana</span>
        <span className="num break-all">{vault?.solanaAddress}</span>
        <Copy text={vault?.solanaAddress ?? ''} />
      </div>
      <p className="text-xs text-muted">
        Deposit funds to these addresses to trade. The same EVM address works on Monad, Base, BSC and
        Robinhood Chain.
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer text-text-2">
          Wallets ({walletsOf(vault).length}) — add, fund, sweep…
        </summary>
        <div className="mt-2">
          <WalletsPanel />
        </div>
      </details>
      <Field label="Auto-lock after">
        <Select defaultValue="15" onChange={(e) => setAutoLockMinutes(Number(e.target.value))}>
          {[5, 15, 30, 60, 120].map((m) => (
            <option key={m} value={m}>
              {m} minutes idle
            </option>
          ))}
        </Select>
      </Field>
      <details className="text-sm">
        <summary className="cursor-pointer text-text-2">Export private keys…</summary>
        <div className="mt-2 space-y-2">
          <Notice tone="down">
            Only export on a trusted device. Never paste keys into websites or share them with anyone,
            including “support”.
          </Notice>
          {exp ? (
            <>
              <Secret label="EVM private key" value={exp.evmPrivateKey} />
              <Secret label="Solana secret key (base58)" value={exp.solanaSecretKeyBase58} />
              {exp.extraEvm.map((x) => (
                <Secret key={x.address} label={`${x.label} · ${x.address}`} value={x.key} />
              ))}
              <Button size="sm" onClick={() => setExp(null)}>
                Hide
              </Button>
            </>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                exportSecrets(pw)
                  .then((x) => {
                    setExp(x);
                    setPw('');
                    setErr(null);
                  })
                  .catch((x: Error) => setErr(x.message));
              }}
            >
              <Input
                type="password"
                placeholder="Re-enter password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
              />
              <Button type="submit">Export</Button>
            </form>
          )}
          {err && <div className="text-down text-xs">{err}</div>}
        </div>
      </details>
      <div className="flex justify-end gap-2">
        <Button
          onClick={() => {
            lock();
            onClose();
          }}
        >
          Lock now
        </Button>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
