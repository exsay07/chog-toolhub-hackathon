import { useEffect } from 'react';
import { useNotify } from '../notify';
import { onFarmEvent, useFarms } from './runner';

/** Turns notable perps-bot moments into in-app notifications (category "perps" in Settings). */
export function FarmNotifier() {
  const { notify } = useNotify();
  const farms = useFarms();
  useEffect(
    () =>
      onFarmEvent((e) => {
        const f = farms.get(e.id);
        const name = f ? `${f.cfg.pair} bot` : 'Perps bot';
        notify({
          category: 'perps',
          tone: e.level === 'error' ? 'down' : /done/.test(e.msg) ? 'up' : 'warn',
          title: `${name}: ${e.msg.split(' · ')[0]}`,
          body: e.msg.includes(' · ') ? e.msg.split(' · ').slice(1).join(' · ') : undefined,
        });
      }),
    [farms, notify],
  );
  return null;
}
