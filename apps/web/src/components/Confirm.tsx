import { useSyncExternalStore } from 'react';
import { Button, Modal } from './ui';

/**
 * In-app confirmation dialog (the browser's confirm() shows OS-language buttons and ignores our style).
 * Usage: if (await ask('Delete this bot?')) remove();  — needs <ConfirmHost /> mounted once.
 */

interface Pending {
  message: string;
  detail?: string;
  confirmLabel: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}
let pending: Pending | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function ask(
  message: string,
  opts: { detail?: string; confirmLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = {
      message,
      detail: opts.detail,
      confirmLabel: opts.confirmLabel ?? 'Confirm',
      danger: opts.danger ?? true,
      resolve,
    };
    emit();
  });
}

function settle(ok: boolean) {
  const p = pending;
  pending = null;
  emit();
  p?.resolve(ok);
}

export function ConfirmHost() {
  const p = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    () => pending,
  );
  return (
    <Modal open={!!p} onClose={() => settle(false)} title={p?.message ?? ''} width={400}>
      {p && (
        <div className="space-y-4">
          {p.detail && <p className="text-[13px] text-text-2">{p.detail}</p>}
          <div className="flex justify-end gap-2">
            <Button onClick={() => settle(false)}>Cancel</Button>
            <Button variant={p.danger ? 'danger' : 'primary'} onClick={() => settle(true)} autoFocus>
              {p.confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
