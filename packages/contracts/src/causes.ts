/**
 * Binding constraints ("связывающие ограничения").
 * Every vehicle, every step, has exactly one reason it is not going faster.
 * Metrics aggregate ROOT causes per segment: a vehicle whose immediate cause is `leader`
 * inherits the root cause of the vehicle in front while it is queued behind it
 * (see docs/ARCHITECTURE.md, "Распространение корневой причины").
 *
 * Codes are stable and stored in typed arrays; append only, never renumber.
 */
export const CAUSES = [
  { code: 0, key: "free_flow", ru: "Свободное движение" },
  { code: 1, key: "speed_limit", ru: "Ограничение скорости" },
  { code: 2, key: "leader", ru: "Машина впереди" },
  { code: 3, key: "signal_red", ru: "Красный сигнал" },
  { code: 4, key: "arrow_off", ru: "Стрелка доп. секции не горит" },
  { code: 5, key: "gap_left_turn", ru: "Ожидание разрыва для левого поворота" },
  { code: 6, key: "pedestrian_yield", ru: "Пропуск пешеходов" },
  { code: 7, key: "lane_change_wait", ru: "Ожидание перестроения" },
  { code: 8, key: "pocket_spillback", ru: "Переполненный поворотный карман" },
  { code: 9, key: "bus_dwell", ru: "Посадка и высадка на остановке" },
  { code: 10, key: "behind_stopped_bus", ru: "За автобусом на остановке" },
  { code: 11, key: "gridlock", ru: "Перекрёсток заперт поперечным потоком" },
  { code: 12, key: "merge_yield", ru: "Уступает на слиянии" },
  { code: 13, key: "yield_priority", ru: "Уступает главной дороге" },
  { code: 14, key: "downstream_spillback", ru: "Затор ниже по потоку" },
  { code: 15, key: "spawn_wait", ru: "Ожидание въезда в сеть" },
] as const;

export type CauseKey = (typeof CAUSES)[number]["key"];
export type CauseCode = (typeof CAUSES)[number]["code"];
export const CAUSE_COUNT = CAUSES.length;

const byKey = new Map<string, (typeof CAUSES)[number]>(CAUSES.map((c) => [c.key, c]));
export function causeCode(key: CauseKey): CauseCode {
  const c = byKey.get(key);
  if (!c) throw new Error(`unknown cause ${key}`);
  return c.code;
}
export function causeByCode(code: number): (typeof CAUSES)[number] {
  const c = CAUSES[code];
  if (!c) throw new Error(`unknown cause code ${code}`);
  return c;
}

/**
 * Causes that count as "delay attributable to infrastructure or control" when ranking bottlenecks.
 * `free_flow`, `speed_limit` and `leader` (unresolved) are excluded.
 */
export const DELAY_CAUSE_KEYS: readonly CauseKey[] = [
  "signal_red",
  "arrow_off",
  "gap_left_turn",
  "pedestrian_yield",
  "lane_change_wait",
  "pocket_spillback",
  "bus_dwell",
  "behind_stopped_bus",
  "gridlock",
  "merge_yield",
  "yield_priority",
  "downstream_spillback",
  "spawn_wait",
];
