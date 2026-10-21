/**
 * Global automation kill switch (client side; server side is /api/automations/emergency-stop).
 * Its own tiny module so the shell can use it without loading the trading engine.
 */
export const killSwitch = {
  active: false,
  listeners: new Set<() => void>(),
  set(v: boolean) {
    this.active = v;
    this.listeners.forEach((l) => l());
  },
};
