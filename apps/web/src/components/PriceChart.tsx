import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { normalizeCandles, type Candle } from '@chog/shared';

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Candles are fetched in batches (GeckoTerminal); the last bar is updated incrementally from the
 * live pair price (`livePrice`) so we never re-download history for a tick.
 */
export function PriceChart({
  candles,
  livePrice,
  height = 360,
}: {
  candles: Candle[];
  livePrice: number | null;
  height?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const vol = useRef<ISeriesApi<'Histogram'> | null>(null);
  const last = useRef<Candle | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: css('--muted'),
        fontFamily: getComputedStyle(document.body).fontFamily,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { color: css('--border') }, horzLines: { color: css('--border') } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      localization: { priceFormatter: (p: number) => (p >= 1 ? p.toFixed(4) : p.toPrecision(4)) },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: css('--up'),
      downColor: css('--down'),
      borderVisible: false,
      wickUpColor: css('--up'),
      wickDownColor: css('--down'),
      priceFormat: { type: 'price', precision: 10, minMove: 1e-10 },
    });
    const v = c.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
      color: css('--accent') + '55',
    });
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    series.current = s;
    vol.current = v;
    // Re-theme on theme switch.
    const mo = new MutationObserver(() => {
      c.applyOptions({
        layout: { textColor: css('--muted') },
        grid: { vertLines: { color: css('--border') }, horzLines: { color: css('--border') } },
      });
      s.applyOptions({
        upColor: css('--up'),
        downColor: css('--down'),
        wickUpColor: css('--up'),
        wickDownColor: css('--down'),
      });
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent'],
    });
    return () => {
      mo.disconnect();
      c.remove();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (!series.current || !vol.current) return;
    // Defensive: never hand the chart unsorted/duplicate bars (it throws and would crash the page).
    const bars = normalizeCandles(candles);
    series.current.setData(
      bars.map((k) => ({
        time: k.time as UTCTimestamp,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
      })),
    );
    vol.current.setData(
      bars.map((k) => ({
        time: k.time as UTCTimestamp,
        value: k.volume,
        color: (k.close >= k.open ? css('--up') : css('--down')) + '55',
      })),
    );
    last.current = bars.at(-1) ?? null;
    if (bars.length) chart.current?.timeScale().fitContent();
  }, [candles]);

  useEffect(() => {
    const l = last.current;
    if (!series.current || !l || livePrice === null || !Number.isFinite(livePrice)) return;
    // Only adjust the current bar; the next batch fetch rolls the bar over.
    const upd = {
      ...l,
      high: Math.max(l.high, livePrice),
      low: Math.min(l.low, livePrice),
      close: livePrice,
    };
    last.current = upd;
    series.current.update({
      time: upd.time as UTCTimestamp,
      open: upd.open,
      high: upd.high,
      low: upd.low,
      close: upd.close,
    });
  }, [livePrice]);

  return <div ref={el} style={{ height }} className="w-full" />;
}
