/**
 * All UI copy lives here (CLAUDE.md: "Строки UI держи в одном модуле"), so a kk.ts can sit next
 * to it later. Every visible string in `src/ui/` and `Viewport.tsx` must come from this object -
 * that is what `pnpm check`'s "ни одной русской строки вне i18n/ru.ts" acceptance check means.
 */
export const ru = {
  appTitle: "Almaty Traffic Lab",
  attribution: "© Соавторы OpenStreetMap, ODbL",
  loadingNetwork: "Загрузка сети…",
  compilingScenario: "Применение сценария…",
  warmingUp: "Прогрев симуляции…",
  loadError: "Не удалось загрузить сеть",

  // Side panel tabs (T-23 only renders "Обзор"; the rest are stubs for T-24/T-25/T-26).
  tabOverview: "Обзор",
  tabBottlenecks: "Узкие места",
  tabScenarios: "Сценарии",
  tabCompare: "Сравнение",
  comingSoon: (taskId: string) => `Появится в задаче ${taskId}.`,

  // Time bar (docs/tasks/T-23 п.2).
  play: "Пуск",
  pause: "Пауза",
  restart: "Перезапуск",
  speedFactorLabel: (factor: number) => `${factor}×`,
  clockLabel: "Время в сети",
  presetMorning: "Утро 08:00",
  presetMidday: "День 14:00",
  presetEvening: "Вечер 18:30",
  warmupProgressLabel: "Прогрев",

  // Camera presets (docs/tasks/T-05/T-13 review: overview vs. a closer traffic view).
  cameraOverview: "Обзор сети",
  cameraCloseUp: "Приблизить к трафику",

  // City layer switches (docs/tasks/T-27 п.2).
  layersTitle: "Слои",
  layerBuildings: "Здания",
  layerGreenery: "Зелень/вода",

  // Global params panel (docs/tasks/T-23 п.3).
  paramsTitle: "Глобальные параметры",
  paramDemandMultiplier: "Множитель спроса",
  paramNavigatorShare: "Доля навигаторов",
  paramGridlockDiscipline: "Дисциплина на перекрёстках",
  paramBusLaneViolatorShare: "Доля нарушителей выделенки",
  paramVehicleBudget: "Бюджет машин",
  paramTaxisInBusLanes: "Такси разрешены в выделенке",
  restartRequiredBadge: "требует перезапуска",
  applyRestartRequired: "Применить и перезапустить",

  // HUD (docs/tasks/T-23 п.4).
  hudVehicles: "Машины",
  hudOfBudget: "из бюджета",
  hudRtFactor: "Коэфф. реального времени",
  hudRtFactorHint: "Снизьте бюджет машин, чтобы симуляция успевала за реальным временем",
  hudFps: "FPS",
  hudAvgSpeed: "Средняя скорость",
  hudDelaySuffix: "за окно",
  hudNoData: "—",
  kphLabel: (kph: number) => `${kph} км/ч`,
  hoursLabel: (hours: number) => `${hours} ч`,
  minutesLabel: (min: number) => `${min} мин`,

  // Network switcher (docs/tasks/T-23 п.5).
  networkLabel: "Сеть",
  networkSmall: "Тестовый квадрат (Абая – Тимирязева)",
  networkBig: "Центр Алматы",

  // Assumption legend (docs/tasks/T-23 п.6; kind keys mirror @atl/map-data's ASSUMPTION_KINDS).
  legendTitle: "Легенда допущений",
  legendIntro: "Данные условные: OSM + допущения генератора",
  legendEmpty: "Нет данных о происхождении атрибутов",
  assumptionKinds: {
    speed_limit_default: "Скорость движения",
    lane_count_default: "Число полос",
    turns_default: "Разрешённые повороты",
    left_pocket_default: "Карман поворота (наличие/длина)",
    pocket_length_default: "Длина кармана поворота",
    bus_lane_hours_default: "Часы работы выделенки",
    bus_lane_position_assumed: "Положение выделенки",
    merge_node_default: "Узел слияния",
    acceleration_lane_default: "Полоса разгона",
    connector_priority_default: "Приоритет проезда",
    crosswalk_default: "Пешеходный переход",
    gate_weight_default: "Вес въезда/выезда сети",
    attractor_weight_default: "Вес точки притяжения",
  },

  // Tooltip (docs/tasks/T-23 п.7).
  tooltipNode: "Узел",
  tooltipLink: "Улица",
  tooltipUnnamed: "Без названия",
  tooltipClass: "Класс",
  tooltipLanes: "Полос",
  tooltipSpeed: "Скорость",
  tooltipOrigin: "Происхождение",
  provenance: { osm: "OSM", default: "Допущение", manual: "Ручное" },
  nodeKinds: {
    junction: "Перекрёсток",
    signalized: "Светофор",
    merge: "Слияние",
    gate: "Ворота сети",
    dead_end: "Тупик",
    bend: "Изгиб",
  },
  highwayClasses: {
    trunk: "Магистраль",
    trunk_link: "Съезд с магистрали",
    primary: "Дорога 1-й категории",
    primary_link: "Съезд с дороги 1-й категории",
    secondary: "Дорога 2-й категории",
    secondary_link: "Съезд с дороги 2-й категории",
    tertiary: "Дорога 3-й категории",
    tertiary_link: "Съезд с дороги 3-й категории",
    residential: "Жилая улица",
    unclassified: "Прочая дорога",
    living_street: "Двор",
    service: "Служебный проезд",
  },

  // Scenario editor (docs/tasks/T-24).
  scenariosTitle: "Сценарии",
  scenarioNamePlaceholder: "Название сценария",
  scenarioCreate: "Создать",
  scenarioDuplicate: "Копировать",
  scenarioRename: "Переименовать",
  scenarioRenamePrompt: "Новое название сценария:",
  scenarioDelete: "Удалить",
  scenarioRunningBadge: "запущен",
  scenarioRun: "Запустить",
  scenarioRunHint:
    "Пересчитает сеть с изменениями сценария и перезапустит симуляцию на том же сиде",
  scenarioExport: "Экспорт JSON",
  scenarioImport: "Импорт JSON",
  scenarioBaselineHint:
    "Базовый сценарий — сеть без изменений. Создайте сценарий, чтобы редактировать перекрёстки и улицы.",
  scenarioSelectHint:
    "Кликните по перекрёстку со светофором или по улице на карте слева, чтобы отредактировать её.",
  scenarioImportError: {
    invalid_json: "Файл не является корректным JSON",
    invalid_schema: "Файл не соответствует схеме сценария",
    networkMismatch: (networkId: string) =>
      `Сценарий рассчитан на сеть «${networkId}», а не на текущую`,
  },
  applyOverride: "Применить",
  resetOverride: "Сбросить override",
  sectionMain: "основная",
  sectionArrowLeft: "стрелка налево",

  notEditableNode: "Этот узел не регулируется светофором и не редактируется",
  linkFormTitle: (name: string) => `Улица: ${name}`,
  linkFormGeneralLanes: "Сквозные полосы",
  linkFormSpeedLimit: "Скорость, км/ч",
  linkFormLeftPocket: "Левый карман, м (0 — нет кармана)",
  linkFormRightPocket: "Правый карман, м (0 — нет кармана)",
  linkFormBusLane: "Выделенная полоса",
  linkFormBusLaneFrom: "Действует с",
  linkFormBusLaneTo: "Действует до",
  linkFormBusLaneEntry: "Въезд машин направо за, м",

  intersectionFormTitle: (name: string) => `Перекрёсток: ${name}`,
  intersectionApproach: "Подход",
  intersectionLeftTurnMode: "Левый поворот",
  leftTurnModes: {
    protected: "Со стрелкой",
    permissive: "Со встречным потоком",
    protected_permissive: "Стрелка + встречный поток",
    prohibited: "Запрещён",
  },
  intersectionCycle: "Цикл, с",
  intersectionOffset: "Смещение начала цикла, с",
  intersectionPedestrianPhase: "Отдельная пешеходная фаза",
  intersectionGreenTitle: "Зелёный по группам, с",

  // Bottlenecks tab (docs/tasks/T-25).
  bottlenecksEmpty: "Отчёт об узких местах ещё не готов — идёт прогрев симуляции.",
  bottlenecksNoItems: "Сейчас на сети нет узких мест, подходящих под критерии D11.",
  bottlenecksSortVehH: "По машино-часам",
  bottlenecksSortPersonH: "По человеко-часам",
  bottlenecksColRank: "#",
  bottlenecksColTitle: "Место",
  bottlenecksColDelay: "Задержка",
  bottlenecksVcLabel: "V/C",
  bottlenecksQueueLabel: "Очередь",
  bottlenecksSpeedRatioLabel: "Скорость к свободной",
  bottlenecksPersistenceLabel: "Устойчивость затора",
  bottlenecksCausesTitle: "Причины задержки",
  bottlenecksCausesOther: "Остальное (вне списка причин)",
  bottlenecksRecommendationsTitle: "Рекомендации",
  bottlenecksNoRecommendations:
    "Готового сценария нет — отредактируйте перекрёсток или улицу вручную во вкладке «Сценарии».",
  bottlenecksApply: "Применить в сценарии",
  bottlenecksApplyDisabledHint: "Это решение не выражается изменением сети напрямую",
  bottlenecksApplied: (name: string) => `Добавлено в сценарий «${name}»`,
  bottlenecksShow: "Показать",
  bottlenecksNewScenarioName: (title: string) => `Из узкого места: ${title}`,

  // Heat-map (docs/tasks/T-25 п.1).
  heatmapToggle: "Тепловая карта скорости (окно 5 мин)",
  heatmapLegendFree: "Свободно",
  heatmapLegendCongested: "Затор",
  heatmapLegendNoData: "Нет данных",

  // Delay sparkline + active count (docs/tasks/T-25 п.4).
  sparklineTitle: "Задержка узких мест за 30 мин",
  activeBottlenecksLabel: "Активных узких мест",

  // Minimap (docs/tasks/T-25 п.5).
  minimapTitle: "Мини-карта",

  metersLabel: (m: number) => `${m} м`,
} as const;
