import { useEffect, useState, useSyncExternalStore } from 'react';
import { isUnlocked, loadVault, onVaultChange } from './vault';
import type { EncryptedVault } from './crypto';

export function useVault() {
  const unlocked = useSyncExternalStore(onVaultChange, isUnlocked);
  const [vault, setVault] = useState<EncryptedVault | null | undefined>(undefined);
  useEffect(() => {
    const refresh = () => void loadVault().then(setVault);
    refresh();
    return onVaultChange(refresh);
  }, []);
  return { vault, unlocked, loading: vault === undefined };
}
