import type { BottleneckItem, CauseKey } from "@atl/contracts";
import { CAUSES } from "@atl/contracts";
import { ru } from "../i18n/ru.ts";
import { formatShare } from "../state/format.ts";

/** `packages/contracts/src/metrics.ts` only exports the schema, not a `CauseShare` type alias - contracts is frozen, so derive it from `BottleneckItem` instead of adding one. */
type CauseShare = BottleneckItem["causes"][number];

/**
 * Stacked bar of a bottleneck's root-cause shares (docs/tasks/T-25 п.2). Labels come straight from
 * `@atl/contracts`'s `CAUSES.ru` per the card's context note - these are domain strings the
 * simulation itself assigns per cause code, not app UI copy, so they live in the frozen contracts
 * package rather than `i18n/ru.ts`.
 */

/** Muted, stable-per-cause qualitative palette (docs/DECISIONS.md D13 tone) - indexed by `CAUSES`'s own code, so a colour never shifts between renders or across items. */
const CAUSE_PALETTE = [
  "#b0473f",
  "#c96a3f",
  "#c98a3f",
  "#c7a83f",
  "#a7b23f",
  "#7fa04a",
  "#4f8f5c",
  "#4f8f8a",
  "#4f7a8f",
  "#4f5c8f",
  "#6a4f8f",
  "#8f4f7a",
  "#8f4f5c",
  "#8f6a4f",
  "#5c5c5c",
  "#3f3f3f",
] as const;

const causesByKey = new Map(CAUSES.map((c) => [c.key, c]));

export function causeLabel(key: CauseKey): string {
  return causesByKey.get(key)?.ru ?? key;
}

export function causeColor(key: CauseKey): string {
  const code = causesByKey.get(key)?.code ?? 0;
  return CAUSE_PALETTE[code % CAUSE_PALETTE.length] as string;
}

/** Drops shares too small to read (a hairline sliver, an unreadable "0%" legend row). */
const MIN_VISIBLE_SHARE = 0.02;
export function visibleCauses(causes: readonly CauseShare[]): CauseShare[] {
  return causes.filter((c) => c.share >= MIN_VISIBLE_SHARE);
}

export interface CauseBarProps {
  causes: readonly CauseShare[];
}

/** `causes` sums to ≈1 over `DELAY_CAUSE_KEYS` only (docs/tasks/T-25 card notes on T-19); the
 * remainder (free flow / speed limit / an unresolved leader chain) is drawn as a neutral remainder
 * segment rather than silently stretching the visible causes to fill the bar. */
export function CauseBar({ causes }: CauseBarProps) {
  const visible = visibleCauses(causes);
  const shareSum = visible.reduce((sum, c) => sum + c.share, 0);
  const remainder = Math.max(0, 1 - shareSum);

  return (
    <div className="cause-bar">
      <div className="cause-bar-track">
        {visible.map((c) => (
          <div
            key={c.cause}
            className="cause-bar-segment"
            style={{ width: formatShare(c.share), background: causeColor(c.cause) }}
            title={`${causeLabel(c.cause)}: ${formatShare(c.share)}`}
          />
        ))}
        {remainder > MIN_VISIBLE_SHARE && (
          <div
            className="cause-bar-segment cause-bar-remainder"
            style={{ width: formatShare(remainder) }}
            title={`${ru.bottlenecksCausesOther}: ${formatShare(remainder)}`}
          />
        )}
      </div>
      <ul className="cause-bar-legend">
        {visible.map((c) => (
          <li key={c.cause} className="cause-bar-legend-item">
            <span className="cause-bar-swatch" style={{ background: causeColor(c.cause) }} />
            <span className="cause-bar-legend-label">{causeLabel(c.cause)}</span>
            <span className="cause-bar-legend-value">{formatShare(c.share)}</span>
          </li>
        ))}
        {remainder > MIN_VISIBLE_SHARE && (
          <li className="cause-bar-legend-item">
            <span className="cause-bar-swatch cause-bar-swatch-remainder" />
            <span className="cause-bar-legend-label">{ru.bottlenecksCausesOther}</span>
            <span className="cause-bar-legend-value">{formatShare(remainder)}</span>
          </li>
        )}
      </ul>
    </div>
  );
}
