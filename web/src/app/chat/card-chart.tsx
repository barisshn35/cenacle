// SPDX-License-Identifier: AGPL-3.0-only
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { components } from '@cenacle/core/api';
import { dateLocale } from '../../i18n/time-format';

export type Chart = NonNullable<components['schemas']['Attachment']['chart']>;

/** Series colours in a fixed order (tokens.css); a series keeps its slot. */
const SERIES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];

const W = 480;
const H = 180;
const PAD = { top: 10, right: 8, bottom: 22, left: 44 };

/** Round steps for the value axis: 1, 2 or 5 times a power of ten. */
function niceStep(span: number, ticks = 4) {
  const raw = span / ticks || 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

/**
 * A card's chart: bars from a zero baseline or 2px lines, a recessive grid,
 * a legend for two or more series, each mark named on hover, and the numbers
 * as a table for anyone who does not read the picture.
 */
export function CardChart({ chart }: { chart: Chart }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const fmt = new Intl.NumberFormat(dateLocale(i18n.language), { notation: 'compact' });
  const full = new Intl.NumberFormat(dateLocale(i18n.language));
  const unit = chart.unit ? ` ${chart.unit}` : '';
  const values = chart.series.flatMap((s) => s.values);
  const lo = Math.min(0, ...values);
  const hiRaw = Math.max(0, ...values);
  const step = niceStep(hiRaw - lo);
  const min = Math.floor(lo / step) * step;
  const max = Math.max(Math.ceil(hiRaw / step) * step, min + step);
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(v);

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + plotH - ((v - min) / (max - min)) * plotH;
  const n = chart.labels.length;
  const band = plotW / n;
  const x = (i: number) => PAD.left + band * i + band / 2;
  // Every label when they fit, else every other (or third…).
  const every = Math.ceil(n / Math.max(1, Math.floor(plotW / 48)));
  const summary = t('chart.summary', {
    kind: t(`chart.kinds.${chart.kind}`),
    series: chart.series.map((s) => s.name).join(', '),
    count: n,
  });

  return (
    <figure className="mt-2 grid gap-1.5" data-testid="card-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={summary}
        aria-describedby={`${id}-table`}
        className="w-full max-w-[480px] overflow-visible"
      >
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--border)"
              strokeWidth={v === 0 ? 1 : 0.5}
            />
            <text
              x={PAD.left - 6}
              y={y(v)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted-foreground text-[10px] tabular-nums"
            >
              {fmt.format(v)}
            </text>
          </g>
        ))}
        {chart.labels.map((label, i) =>
          i % every === 0 ? (
            <text
              key={i}
              x={x(i)}
              y={H - 6}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {label}
            </text>
          ) : null,
        )}
        {chart.kind === 'bar'
          ? chart.series.map((s, si) => {
              const k = chart.series.length;
              const gap = 2;
              const inner = Math.min(band * 0.7, 28 * k);
              const w = Math.max(2, (inner - gap * (k - 1)) / k);
              return s.values.map((v, i) => {
                const left = x(i) - inner / 2 + si * (w + gap);
                const top = y(Math.max(v, 0));
                const h = Math.max(1, Math.abs(y(v) - y(0)));
                const r = Math.min(4, w / 2, h);
                // Rounded at the data end, square on the baseline.
                const d =
                  v >= 0
                    ? `M${left},${top + h}V${top + r}Q${left},${top} ${left + r},${top}H${left + w - r}Q${left + w},${top} ${left + w},${top + r}V${top + h}Z`
                    : `M${left},${top}V${top + h - r}Q${left},${top + h} ${left + r},${top + h}H${left + w - r}Q${left + w},${top + h} ${left + w},${top + h - r}V${top}Z`;
                return (
                  <path key={`${si}-${i}`} d={d} fill={SERIES[si]}>
                    <title>{`${s.name}, ${chart.labels[i]}: ${full.format(v)}${unit}`}</title>
                  </path>
                );
              });
            })
          : chart.series.map((s, si) => (
              <g key={si}>
                <polyline
                  fill="none"
                  stroke={SERIES[si]}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
                />
                {s.values.map((v, i) => (
                  <circle
                    key={i}
                    cx={x(i)}
                    cy={y(v)}
                    r={n <= 12 ? 4 : 2.5}
                    fill={SERIES[si]}
                    stroke="var(--card)"
                    strokeWidth={2}
                  >
                    <title>{`${s.name}, ${chart.labels[i]}: ${full.format(v)}${unit}`}</title>
                  </circle>
                ))}
              </g>
            ))}
      </svg>
      {chart.series.length > 1 && (
        <figcaption>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {chart.series.map((s, si) => (
              <li key={si} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2.5 rounded-sm"
                  style={{ background: SERIES[si] }}
                />
                {s.name}
              </li>
            ))}
          </ul>
        </figcaption>
      )}
      <details className="text-xs">
        <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
          {t('chart.table')}
        </summary>
        <div className="mt-1 max-w-full overflow-x-auto">
          <table id={`${id}-table`} className="text-start tabular-nums">
            <thead>
              <tr>
                <th scope="col" className="pe-3 text-start font-medium">
                  <span className="sr-only">{t('chart.label')}</span>
                </th>
                {chart.series.map((s, si) => (
                  <th key={si} scope="col" className="pe-3 text-end font-medium">
                    {s.name}
                    {unit && <span className="text-muted-foreground">{` (${chart.unit})`}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chart.labels.map((label, i) => (
                <tr key={i} className="border-t">
                  <th scope="row" className="pe-3 text-start font-normal">
                    {label}
                  </th>
                  {chart.series.map((s, si) => (
                    <td key={si} className="pe-3 text-end">
                      {full.format(s.values[i]!)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
