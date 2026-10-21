import { CopyTradeRunner } from './automation/copyTrader';
import { LimitOrderRunner } from './automation/limitOrders';
import { MintRunner } from './automation/mint';
import { SniperRunner } from './automation/sniper';
import { FarmNotifier } from './perps/FarmNotifier';

/**
 * Background automations of a signed-in holder. Loaded as a separate chunk after sign-in, so the
 * sign-in page never downloads the trading engine (Solana, swap routing, signing).
 */
export default function Runners() {
  return (
    <>
      <CopyTradeRunner />
      <SniperRunner />
      <FarmNotifier />
      <MintRunner />
      <LimitOrderRunner />
    </>
  );
}
