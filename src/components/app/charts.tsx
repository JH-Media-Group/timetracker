"use client";

/**
 * Charts.
 *
 * Hand-drawn SVG rather than a charting library, for three reasons: the four
 * forms the product needs are simple, the mark specs in the design system are
 * exact and easier to hit directly, and it keeps a 100KB dependency out of the
 * bundle for charts that are mostly forty rectangles.
 *
 * Every chart follows the same rules (see FRONTEND_PRD 2.4):
 *   - Hit target is the whole column, never the mark.
 *   - Snap to the nearest point, never interpolate.
 *   - Arrow keys drive the same tooltip; the chart is one tab stop.
 *   - The tooltip is inert and positioned from the hit target's box.
 *   - The current period is tinted and its partial mark dimmed.
 */

import * as React from "react";
import { cn } from "@/lib/cn";

/* ---------------------------------------------------------------- tooltip */

interface TipRow { color?: string; label: string; value: string }
interface TipData { title: string; rows: TipRow[]; foot?: { label: string; value: string } }

function useChartTip() {
  const [tip, setTip] = React.useState<{ data: TipData; x: number; y: number } | null>(null);
  const show = (data: TipData, el: Element) => {
    const r = el.getBoundingClientRect();
    setTip({ data, x: r.left + r.width / 2, y: r.top });
  };
  return { tip, show, hide: () => setTip(null) };
}

function ChartTip({ tip }: { tip: { data: TipData; x: number; y: number } | null }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState({ left: 0, top: 0 });

  React.useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const t = ref.current.getBoundingClientRect();
    let left = tip.x - t.width / 2;
    let top = tip.y - t.height - 10;
    if (top < 8) top = tip.y + 28;                        // flip below near the top
    left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
    setPos({ left, top });
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={ref}
      role="status"
      style={{ left: pos.left, top: pos.top }}
      className="pointer-events-none fixed z-(--z-tooltip) min-w-[170px] max-w-[280px] rounded-md border border-border bg-surface px-2.5 py-2 text-sm shadow-md"
    >
      <div className="mb-1.5 font-medium text-ink">{tip.data.title}</div>
      {tip.data.rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2 py-0.5">
          <i className="size-2 shrink-0 rounded-[2px]" style={{ background: r.color ?? "transparent" }} aria-hidden />
          <span className="text-ink-secondary">{r.label}</span>
          <strong className="ms-auto ps-4 font-medium tabular-nums text-ink">{r.value}</strong>
        </div>
      ))}
      {tip.data.foot && (
        <div className="mt-1.5 flex items-center border-t border-border pt-1.5">
          <span className="text-ink-secondary">{tip.data.foot.label}</span>
          <strong className="ms-auto font-medium tabular-nums text-ink">{tip.data.foot.value}</strong>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ frame */

const PAD = { l: 52, r: 16, t: 22, b: 26 };

function useHitKeyboard(count: number, onActive: (i: number) => void, onClear: () => void) {
  const [cursor, setCursor] = React.useState(-1);
  const onKeyDown = (e: React.KeyboardEvent) => {
    let next: number | null = null;
    if (e.key === "ArrowRight") next = Math.min(cursor < 0 ? 0 : cursor + 1, count - 1);
    else if (e.key === "ArrowLeft") next = Math.max(cursor < 0 ? count - 1 : cursor - 1, 0);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = count - 1;
    else if (e.key === "Escape") { setCursor(-1); onClear(); return; }
    else return;
    e.preventDefault();
    setCursor(next);
    onActive(next);
  };
  return { cursor, setCursor, onKeyDown };
}

/* -------------------------------------------------------------- bar chart */

export interface BarPoint { label: string; value: number; partial?: boolean }

export function BarChart({
  data, height = 200, format, tipRows, ariaLabel, color = "var(--viz-1)", xTicks,
}: {
  data: BarPoint[]; height?: number;
  format: (v: number) => string;
  tipRows?: (p: BarPoint, i: number) => TipData;
  ariaLabel: string;
  color?: string;
  xTicks?: number[];
}) {
  const { tip, show, hide } = useChartTip();
  const W = 720, H = height;
  const max = Math.max(1, ...data.map((d) => d.value));
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
  const slot = data.length ? plotW / data.length : plotW;
  const bw = Math.min(26, Math.max(3, slot - 6));
  const y = (v: number) => PAD.t + plotH - (v / max) * plotH;
  const hitRefs = React.useRef<(SVGRectElement | null)[]>([]);

  const activate = (i: number) => {
    const el = hitRefs.current[i];
    if (!el) return;
    show(tipRows ? tipRows(data[i]!, i) : { title: data[i]!.label, rows: [{ color, label: "Value", value: format(data[i]!.value) }] }, el);
  };
  const { cursor, setCursor, onKeyDown } = useHitKeyboard(data.length, activate, hide);

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={ariaLabel}
        tabIndex={0} onKeyDown={onKeyDown} onBlur={() => { setCursor(-1); hide(); }}
        onMouseLeave={hide}
        className="cursor-crosshair rounded-md focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2">
        {cursor >= 0 && <rect x={PAD.l + slot * cursor} y={PAD.t - 8} width={slot} height={plotH + 8} fill="var(--surface-hover)" />}
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + plotH * f} y2={PAD.t + plotH * f} stroke="var(--viz-grid)" strokeWidth={1} />
        ))}
        {data.map((d, i) => (
          <rect key={i} x={PAD.l + slot * i + (slot - bw) / 2} y={y(d.value)} width={bw}
            height={Math.max(0, PAD.t + plotH - y(d.value))} rx={4}
            fill={color} fillOpacity={d.partial ? 0.55 : 1} />
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + plotH} y2={PAD.t + plotH} stroke="var(--viz-axis)" strokeWidth={1} />
        {[0, max / 2, max].map((v, i) => (
          <text key={i} x={PAD.l - 8} y={y(v) + 3} textAnchor="end" style={{ fontSize: 11, fill: "var(--viz-label)" }}>{format(v)}</text>
        ))}
        {(xTicks ?? data.map((_, i) => i).filter((i) => data.length <= 12 || i % Math.ceil(data.length / 8) === 0)).map((i) => (
          <text key={i} x={PAD.l + slot * i + slot / 2} y={H - 6} textAnchor="middle" style={{ fontSize: 11, fill: "var(--viz-label)" }}>
            {data[i]?.label}
          </text>
        ))}
        {data.map((_, i) => (
          <rect key={`h${i}`} ref={(el) => { hitRefs.current[i] = el; }}
            x={PAD.l + slot * i} y={PAD.t - 8} width={slot} height={plotH + 8}
            fill="transparent" onMouseEnter={() => { setCursor(i); activate(i); }} />
        ))}
      </svg>
      <ChartTip tip={tip} />
    </>
  );
}

/* --------------------------------------------------------- horizontal bar */

/**
 * Ranked categories. Use this, not the vertical bar chart, whenever the labels
 * are entity names: a project called "Example Project 02" is
 * unreadable under a 40px-wide column, and rotating the labels only makes the
 * reader tilt their head. Bars run left to right, labels sit in a column beside
 * them, and the value is direct-labelled at the end of each bar.
 *
 * Negative values run left from the same baseline, which is what makes a
 * loss-making project obvious at a glance.
 */
export function HBarChart({
  data, format, ariaLabel, color = "var(--viz-1)", negativeColor = "var(--danger)", tipRows, labelWidth = 190,
}: {
  data: BarPoint[];
  format: (v: number) => string;
  ariaLabel: string;
  color?: string;
  negativeColor?: string;
  tipRows?: (p: BarPoint, i: number) => TipData;
  labelWidth?: number;
}) {
  const { tip, show, hide } = useChartTip();
  const rowRefs = React.useRef<(HTMLDivElement | null)[]>([]);

  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  const anyNegative = data.some((d) => d.value < 0);
  // With negatives in play the baseline sits in the middle of the track.
  const zero = anyNegative ? 50 : 0;
  const span = anyNegative ? 50 : 100;

  const activate = (i: number) => {
    const el = rowRefs.current[i];
    if (!el) return;
    const d = data[i]!;
    show(tipRows ? tipRows(d, i) : { title: d.label, rows: [{ color, label: "Value", value: format(d.value) }] }, el);
  };
  const { cursor, setCursor, onKeyDown } = useHitKeyboard(data.length, activate, hide);

  return (
    <>
      <div
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={(e) => {
          // Up and down are the natural axis here, so map them onto the same handler.
          if (e.key === "ArrowDown") { e.preventDefault(); onKeyDown({ ...e, key: "ArrowRight" } as React.KeyboardEvent); return; }
          if (e.key === "ArrowUp") { e.preventDefault(); onKeyDown({ ...e, key: "ArrowLeft" } as React.KeyboardEvent); return; }
          onKeyDown(e);
        }}
        onBlur={() => { setCursor(-1); hide(); }}
        onMouseLeave={hide}
        className="flex flex-col gap-1 rounded-md focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2"
      >
        {data.map((d, i) => {
          const pct = (Math.abs(d.value) / max) * span;
          const negative = d.value < 0;
          return (
            <div
              key={`${d.label}-${i}`}
              ref={(el) => { rowRefs.current[i] = el; }}
              onMouseEnter={() => { setCursor(i); activate(i); }}
              className={cn(
                "flex items-center gap-3 rounded-sm px-1 py-1 transition-colors duration-(--dur-fast)",
                cursor === i && "bg-surface-hover"
              )}
            >
              <span className="shrink-0 truncate text-sm text-ink-secondary" style={{ width: labelWidth }} title={d.label}>
                {d.label}
              </span>
              <span className="relative h-3.5 min-w-0 flex-1">
                {anyNegative && <span className="absolute inset-y-0 left-1/2 w-px bg-(--viz-axis)" aria-hidden />}
                <span
                  className="absolute inset-y-0 rounded-[3px]"
                  style={{
                    background: negative ? negativeColor : color,
                    opacity: d.partial ? 0.55 : 1,
                    left: negative ? `${zero - pct}%` : `${zero}%`,
                    width: `${Math.max(pct, 0.4)}%`,
                  }}
                />
              </span>
              <span className="w-24 shrink-0 text-right text-sm tabular-nums text-ink">{format(d.value)}</span>
            </div>
          );
        })}
      </div>
      <ChartTip tip={tip} />
    </>
  );
}

/* ------------------------------------------------------------ stacked bar */

export function StackedBarChart({
  data, height = 200, format, ariaLabel, series,
}: {
  data: { label: string; values: number[] }[];
  height?: number; format: (v: number) => string; ariaLabel: string;
  series: { name: string; color: string }[];
}) {
  const { tip, show, hide } = useChartTip();
  const W = 720, H = height;
  const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...totals);
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
  const slot = plotW / Math.max(1, data.length);
  const bw = Math.min(34, slot - 10);
  const h = (v: number) => (v / max) * plotH;
  const hitRefs = React.useRef<(SVGRectElement | null)[]>([]);

  const activate = (i: number) => {
    const el = hitRefs.current[i];
    if (!el) return;
    const d = data[i]!;
    show({
      title: d.label,
      rows: series.map((s, si) => ({ color: s.color, label: s.name, value: format(d.values[si] ?? 0) })),
      foot: { label: "Total", value: format(totals[i]!) },
    }, el);
  };
  const { cursor, setCursor, onKeyDown } = useHitKeyboard(data.length, activate, hide);

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={ariaLabel}
        tabIndex={0} onKeyDown={onKeyDown} onBlur={() => { setCursor(-1); hide(); }} onMouseLeave={hide}
        className="cursor-crosshair rounded-md focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2">
        {cursor >= 0 && <rect x={PAD.l + slot * cursor} y={PAD.t - 8} width={slot} height={plotH + 8} fill="var(--surface-hover)" />}
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + plotH * f} y2={PAD.t + plotH * f} stroke="var(--viz-grid)" strokeWidth={1} />
        ))}
        {data.map((d, i) => {
          let acc = 0;
          return d.values.map((v, si) => {
            const bh = h(v);
            const y = PAD.t + plotH - acc - bh - (si > 0 ? 2 : 0);
            acc += bh + (si > 0 ? 2 : 0);
            if (bh <= 0) return null;
            return <rect key={`${i}-${si}`} x={PAD.l + slot * i + (slot - bw) / 2} y={y} width={bw} height={bh}
              rx={si === d.values.length - 1 ? 4 : 0} fill={series[si]!.color} />;
          });
        })}
        <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + plotH} y2={PAD.t + plotH} stroke="var(--viz-axis)" strokeWidth={1} />
        {[0, max / 2, max].map((v, i) => (
          <text key={i} x={PAD.l - 8} y={PAD.t + plotH - h(v) + 3} textAnchor="end" style={{ fontSize: 11, fill: "var(--viz-label)" }}>{format(v)}</text>
        ))}
        {data.map((d, i) => (
          <text key={`x${i}`} x={PAD.l + slot * i + slot / 2} y={H - 6} textAnchor="middle" style={{ fontSize: 11, fill: "var(--viz-label)" }}>{d.label}</text>
        ))}
        {data.map((_, i) => (
          <rect key={`h${i}`} ref={(el) => { hitRefs.current[i] = el; }}
            x={PAD.l + slot * i} y={PAD.t - 8} width={slot} height={plotH + 8}
            fill="transparent" onMouseEnter={() => { setCursor(i); activate(i); }} />
        ))}
      </svg>
      <ChartTip tip={tip} />
    </>
  );
}

/* ------------------------------------------------------------- line chart */

export function LineChart({
  data, height = 220, format, ariaLabel, threshold, tipRows,
}: {
  data: BarPoint[]; height?: number; format: (v: number) => string; ariaLabel: string;
  threshold?: { value: number; label: string };
  tipRows?: (p: BarPoint, i: number, prev?: BarPoint) => TipData;
}) {
  const { tip, show, hide } = useChartTip();
  const W = 720, H = height;
  const max = Math.max(1, ...data.map((d) => d.value), threshold?.value ?? 0) * 1.05;
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
  const step = data.length > 1 ? plotW / (data.length - 1) : plotW;
  const y = (v: number) => PAD.t + plotH - (v / max) * plotH;
  const x = (i: number) => PAD.l + step * i;
  const hitRefs = React.useRef<(SVGRectElement | null)[]>([]);

  const under: string[] = [], over: string[] = [];
  data.forEach((d, i) => {
    const pt = `${x(i).toFixed(1)},${y(d.value).toFixed(1)}`;
    if (!threshold || d.value <= threshold.value) under.push(pt);
    else { if (!over.length && under.length) over.push(under[under.length - 1]!); over.push(pt); }
  });

  const activate = (i: number) => {
    const el = hitRefs.current[i];
    if (!el) return;
    show(tipRows ? tipRows(data[i]!, i, data[i - 1]) : { title: data[i]!.label, rows: [{ color: "var(--viz-1)", label: "Value", value: format(data[i]!.value) }] }, el);
  };
  const { cursor, setCursor, onKeyDown } = useHitKeyboard(data.length, activate, hide);
  const last = data[data.length - 1];

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={ariaLabel}
        tabIndex={0} onKeyDown={onKeyDown} onBlur={() => { setCursor(-1); hide(); }} onMouseLeave={hide}
        className="cursor-crosshair rounded-md focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + plotH * f} y2={PAD.t + plotH * f} stroke="var(--viz-grid)" strokeWidth={1} />
        ))}
        {threshold && (
          <>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(threshold.value)} y2={y(threshold.value)} stroke="var(--danger)" strokeWidth={1} strokeDasharray="4 3" />
            <rect x={PAD.l} y={y(threshold.value) - 9} width={Math.max(80, threshold.label.length * 6)} height={16} rx={3} fill="var(--danger)" />
            <text x={PAD.l + 6} y={y(threshold.value) + 2.5} style={{ fontSize: 10, fill: "#fff" }}>{threshold.label}</text>
          </>
        )}
        {under.length > 1 && <polyline points={under.join(" ")} fill="none" stroke="var(--viz-1)" strokeWidth={2} />}
        {over.length > 1 && <polyline points={over.join(" ")} fill="none" stroke="var(--danger)" strokeWidth={2} />}
        {last && (
          <circle cx={x(data.length - 1)} cy={y(last.value)} r={4} fill="var(--viz-surface)"
            stroke={threshold && last.value > threshold.value ? "var(--danger)" : "var(--viz-1)"} strokeWidth={2} />
        )}
        {cursor >= 0 && data[cursor] && (
          <>
            <line x1={x(cursor)} x2={x(cursor)} y1={PAD.t - 8} y2={PAD.t + plotH} stroke="var(--border-strong)" strokeWidth={1} />
            <circle cx={x(cursor)} cy={y(data[cursor]!.value)} r={5} fill="var(--viz-surface)"
              stroke={threshold && data[cursor]!.value > threshold.value ? "var(--danger)" : "var(--viz-1)"} strokeWidth={2} />
          </>
        )}
        <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + plotH} y2={PAD.t + plotH} stroke="var(--viz-axis)" strokeWidth={1} />
        {[0, max / 2, max].map((v, i) => (
          <text key={i} x={PAD.l - 8} y={y(v) + 3} textAnchor="end" style={{ fontSize: 11, fill: "var(--viz-label)" }}>{format(v)}</text>
        ))}
        {data.map((_, i) => i).filter((i) => data.length <= 10 || i % Math.ceil(data.length / 6) === 0).map((i) => (
          <text key={`x${i}`} x={x(i)} y={H - 6} textAnchor="middle" style={{ fontSize: 11, fill: "var(--viz-label)" }}>{data[i]?.label}</text>
        ))}
        {data.map((_, i) => (
          <rect key={`h${i}`} ref={(el) => { hitRefs.current[i] = el; }}
            x={x(i) - step / 2} y={PAD.t - 8} width={step} height={plotH + 8}
            fill="transparent" onMouseEnter={() => { setCursor(i); activate(i); }} />
        ))}
      </svg>
      <ChartTip tip={tip} />
    </>
  );
}

/* ----------------------------------------------------------------- donut */

export function Donut({
  segments, centerValue, centerLabel, size = 150, ariaLabel, total,
}: {
  segments: { label: string; value: number; color: string }[];
  centerValue: string; centerLabel: string; size?: number; ariaLabel: string; total: string;
}) {
  const { tip, show, hide } = useChartTip();
  const r = size / 2 - 21;
  const c = 2 * Math.PI * r;
  const sum = segments.reduce((a, s) => a + s.value, 0) || 1;
  let offset = 0;

  return (
    <>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={ariaLabel} onMouseLeave={hide}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-strong)" strokeWidth={18} />
        {segments.map((s, i) => {
          const len = (s.value / sum) * c;
          const el = (
            <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={18}
              strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              style={{ pointerEvents: "stroke", cursor: "default" }}
              onMouseEnter={(e) => show({
                title: s.label,
                rows: [
                  { color: s.color, label: "Hours", value: s.value.toFixed(2) },
                  { label: "Share", value: `${Math.round((s.value / sum) * 100)}%` },
                ],
                foot: { label: "Total", value: total },
              }, e.currentTarget)}
            />
          );
          offset += len;
          return el;
        })}
        <text x={size / 2} y={size / 2 - 4} textAnchor="middle" style={{ fontSize: size / 5, fontWeight: 600, fill: "var(--text)", letterSpacing: "-0.02em" }}>{centerValue}</text>
        <text x={size / 2} y={size / 2 + 16} textAnchor="middle" style={{ fontSize: 11, fill: "var(--text-tertiary)" }}>{centerLabel}</text>
      </svg>
      <ChartTip tip={tip} />
    </>
  );
}

/* ---------------------------------------------------------------- legend */

export function Legend({ items, className }: { items: { label: string; color: string; value?: string }[]; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-4 text-sm text-ink-secondary", className)}>
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <i className="size-2.5 rounded-[3px]" style={{ background: i.color }} aria-hidden />
          {i.label}
          {i.value && <strong className="ml-1 font-medium tabular-nums text-ink">{i.value}</strong>}
        </span>
      ))}
    </div>
  );
}
