# @atl/web

Three.js-рендер полотна дорог и разметки по `Network` из `@atl/contracts`, инстансы машин/светофоров/
пешеходов по `FrameBuffers` из `@atl/sim-worker`, плюс React-оболочка (раскладка, управление временем,
глобальные параметры, HUD, легенда допущений, тултип) поверх неё (T-23), плюс редактор сценариев
(T-24: клик по перекрёстку/улице на карте, формы, вкладка «Сценарии», применение = пересборка сети
`@atl/map-data`'s `applyOverrides` в главном потоке + перезапуск), плюс вкладка «Узкие места» (T-25:
тепловая карта скорости по сегментам, ранговые маркеры с подлётом камеры, таблица Топ-N с причинами и
рекомендациями, спарклайн задержки, мини-карта), плюс вкладка «Сравнение» (T-26: второй воркер для
сценария Б с тем же сидом, синхронизация времени, переключатель A/Б в баре времени, таблица дельт
totals и новые/исчезнувшие/переехавшие узкие места). Сам ничего не считает про движение — только
читает буферы кадров и метрики (`sim-core`/`sim-worker`).

## Структура сцены

```
src/
  geometry/lane-geometry.ts   чистая 2D-математика (без Three.js), проверяется юнит-тестами:
                              смещение полосы, offsetPolyline (стыки со скруглением угла),
                              sampleAtS/slicePolyline (точка и подотрезок по длине дуги)
  scene/
    ribbon.ts             THREE.BufferGeometry для ленты полосы, прямоугольника и треугольника
                           (используются для полотна, стрелок, стоп-линий, зебр); merge в одну
                           геометрию на класс поверхности
    roads.ts               полотно дорог: по одному Mesh на класс полосы (general/turn_pocket/bus),
                           цвет через vertex colors; полупрозрачная лента коннекторов
    markings.ts             штрих/сплошная разметка между полосами, стоп-линии перед узлами
                           signalized, зебры по crosswalks.geometry, стрелки поворотов по
                           lane.turns (последние 20 м полосы), буква «А» на выделенке
                           (canvas-текстура, повторяющиеся спрайты)
    labels.ts               CSS2DRenderer: подписи улиц trunk/primary/secondary в середине линка,
                           гаснут дальше VISIBLE_DISTANCE_M от камеры
    camera.ts               CameraRig поверх OrbitControls: overview(network), плавный
                           focus(x, y, radius), WASD-панорамирование, ограничение наклона
    renderer.ts             WebGLRenderer, PerspectiveCamera, полусферический + направленный
                           свет без теней, земля, resize (ResizeObserver), rAF-цикл (onFrame).
                           applyTimeOfDay(engine, sample) переносит time-of-day.ts на
                           skyColor/hemiLight/sunLight/groundMaterial (T-27, вызывается каждый кадр)
    time-of-day.ts          T-27: цвет неба/земли/света и сила фар по timeOfDayMin, день/вечер/
                           ночь как 4 опорные точки на круге суток (ночь-день-вечер-ночь),
                           линейная интерполяция THREE.Color между соседними; sampleTimeOfDay
                           пишет в переданный `TimeOfDaySample`, без аллокаций на кадр
    city.ts                 T-27: здания (ExtrudeGeometry по footprint, два цвета по heightM),
                           парки/вода (ShapeGeometry, плоско чуть ниже полотна), реки (ribbon.ts)
                           — все footprints одного вида склеены в один Mesh (mergeRibbons), итого
                           ≤ 10 мешей на сеть независимо от числа зданий. Winding контуров
                           нормализуется (shoelace) перед триангуляцией; одна плохая геометрия
                           (самопересечение после упрощения в компиляторе) не валит весь слой
    interpolation.ts         чистая логика (без Three.js): FrameBuffers -> плавная поза машины.
                           Каждый id раскладывается в стабильный слот id % capacity (T-13:
                           id = slot + generation*capacity), слот хранит последние "from"/"to"
                           замеры; смена владельца слота (респавн) даёт мгновенный снап, а не лерп
                           через чужую позицию. lerpAngle — кратчайшая дуга; isBlinkOn — фаза
                           мигания (поворотники 2 Гц, мигающий зелёный светофора)
    vehicles.ts               InstancedMesh на деталь кузова (легковая: кузов+кабина, автобус/
                           троллейбус: кузов(+2 штанги), плюс стоп-сигнал, 2 поворотника и 2 фары
                           на машину), ёмкость = vehicleCapacity, индекс инстанса = id % capacity
                           (слот держит не больше одной машины разом). Неиспользуемые/пропавшие
                           инстансы скрываются масштабом 0, а не через mesh.count. Палитра легковых
                           (carColorFor) — 6 приглушённых цветов по id % 6, такси — жёлтый. Фары
                           (T-27) стоят на месте у каждой активной машины всегда — тёмное/светлое
                           время суток управляет не позицией, а `emissiveIntensity` материала
                           через `setHeadlightIntensity(0..1)`, единую для всех разом (протокол
                           `FrameBuffers.flags` — Uint8Array, все 8 бит заняты, нового флага «фары»
                           не завести без правки контрактов, см. заметку в карточке T-27)
    signals.ts                Столб + головка на сигнальную группу (позиция — конец первой полосы
                           группы, вправо на 2 м): основная секция — 3 лампы (инстансы сфер),
                           arrow_left/right — 1 лампа сбоку. Индекс группы для FrameBuffers.
                           signalStates считается по всем группам всех контроллеров по порядку
                           (включая пешеходные — они не рисуются, но не должны сбивать индексацию)
    pedestrians.ts            crosswalkPeds[i] точек (сферы r=0.3) вдоль geometry зебры i
    picking.ts                 (T-24) `pickNodeOrLink(network, x, y)` — вынесенное из Tooltip.tsx
                           (T-23) ближайший узел/линк на плоскости земли в локальных метрах;
                           общий код для наведения (Tooltip) и клика (ScenariosTab/Viewport).
                           `groundPointFromEvent` — курсор экрана -> точка на плоскости y=0
    highlight.ts               (T-24) контур изменённых сценарием объектов: читает `provenance`
                           прямо из скомпилированной сети (`"manual"` — то, что выставил
                           `applyOverrides`), а не отдельный список overrides — лента вдоль
                           `link.geometry` для линков, квадратная рамка для сигнализированных
                           узлов, один прозрачный меш поверх дорог
    heatmap.ts                 (T-25) тепловая карта скорости: отдельный слой-оверлей по
                           `SegmentDescriptor[]` (не трогает `roads.ts`/`surface-*` — ревью T-05),
                           теми же `slicePolyline`/`laneAxis`/`buildRibbonGeometry`/`mergeRibbons`,
                           чуть выше полотна. Один merged Mesh (один draw call); `setSpeedRatios`
                           переписывает vertex-color атрибут на месте по индексу сегмента —
                           перекраска никогда не пересобирает геометрию. `speedRatioToColor` —
                           зелёный-жёлтый-красный, приглушённые (D11), серый без данных
    markers.ts                 (T-25) CSS2D-маркеры ранга над `item.focus`, цвет чипа по LOS;
                           переиспользуют CSS2D-слой `labels.ts` (тот же `labelRenderer.render`
                           в `Viewport.tsx` рисует и подписи улиц, и эти маркеры — ничего чинить
                           в Viewport не пришлось). Клик по маркеру = коллбэк наверх
                           (`ui/BottlenecksTab.tsx` выбирает строку и зовёт `rig.focus`)
  sim/
    client.ts                 SimClient из @atl/sim-worker: ?sim=stub — заглушка (T-06), иначе
                           реальное ядро; владеет interpolation-буфером и "дисплейными часами"
                           (реальное время -> симуляционное, не забегая вперёд последнего кадра);
                           отдаёт готовые сигналы/пешеходов без интерполяции (дискретное состояние).
                           sampleStressFrame/wantsStressMode — стресс-режим `?stress=1`
                           (докарточка T-13: 20 000 инстансов без воркера, для проверки FPS)
  data/
    demo-network.ts          T-образный перекрёсток, собранный вручную: левый карман, выделенка
                           с буквой, стоп-линия и зебры на signalized-узле, коннекторы через все
                           повороты. Используется, когда скомпилированной сети нет
    loadNetwork.ts            fetch('/networks/<id>.network.json.gz') + DecompressionStream,
                           иначе demo-network.ts
  Viewport.tsx                грузит сеть (`networkId` из пропсов), монтирует сцену (включая
                           `cityLayers` из scene/city.ts), запускает sim/client.ts с переданным
                           `configPatch` (прогрев по demand.warmupMinutes с прогресс-баром, затем
                           play(1)) и на каждый тик rAF обновляет vehicles/signals/pedestrians
                           (useEffect + cleanup), а также sky/свет/фары по времени суток —
                           `timeOfDayMin` считается из `initialTimeOfDayMin + simTimeS/60`, а не
                           читается из `FrameMeta.timeOfDayMin` напрямую: это поле в sim/client.ts
                           стартует placeholder-нулём (полночь) до первого кадра воркера, и `?? `
                           его не ловит (0 — не nullish); `simTimeS` такой двусмысленности не
                           создаёт (0 = "время не прошло", ровно то же значение, что и до старта).
                           `ViewportHandle` (аргумент `onReady`) отдаёт `{ engine, rig, network,
                           cityLayers, getSim, onSimReady }` — `onSimReady` стреляет один раз, когда
                           прогрев закончился и `sim.play(1)` уже вызван (не раньше — воркер иначе
                           отклонит `runUntil`), `getSim` — синхронный геттер той же ручки.
                           (T-24) `scenarioOverrides`/`scenarioId` — если заданы, после загрузки
                           сети статус на кадр переключается на "compiling" и `@atl/map-data`'s
                           `applyOverrides` пересобирает сеть на главном потоке, ДО того как
                           стартует воркер, — это и есть «применение сценария» (рестарт с тем же
                           сидом достигается тем же ремонтом `<Viewport key={restartToken}>`, что
                           и у T-23). `onSelect` — клик по канвасу (`scene/picking.ts`) сообщает
                           наверх выбранный узел/линк для форм редактора. (T-26) `ViewportHandle`
                           дополнен `baseNetwork` (сеть до применения `scenarioOverrides` этого
                           монтирования — с неё, а не с уже применённого `network`, компилируется
                           сценарий Б) и `setCompareSim(sim | undefined)`: рендер-цикл использует
                           `compareSim ?? sim` вместо голого `sim` для vehicles/signals/pedestrians
                           каждый тик — геометрия дорог/разметки не пересобирается при переключении,
                           меняются только читаемые кадры (см. `sim/abRunner.ts` и `state/store.ts`'s
                           `setAbSelected`)
  sim/client.ts                 (T-23) `SimHandle` дополнен `setParams`/`requestReport`/`onMetrics`/
                           `onReport`/`latestFrameMeta()` — тонкие проброс-обёртки над `SimClient`
                           из `@atl/sim-worker`, плюс мутируемый снимок последнего кадра
                           (rtFactor/vehicleCount/timeOfDayMin) для HUD
  sim/abRunner.ts                (T-26) второй `SimHandle` для сценария Б поверх `sim/client.ts`'s
                           `startSim` (не нового протокола) — `createAbRunner(baseNetwork,
                           configPatch, simA, callbacks)` компилирует Б через
                           `@atl/map-data/overrides`'s `applyOverrides` на «сыром» `baseNetwork`
                           (не на уже применённом `viewport.network` — иначе оверрайды Б легли бы
                           поверх оверрайдов A), прогревает его до того же `demand.warmupMinutes`,
                           что и A, и запускает `stepAbSync` на интервале: если один клиент отстаёт
                           больше чем на `AB_SYNC_LAG_S` (5 с), второй ставится на паузу до
                           выравнивания. `stepAbSync` — чистая функция (клиенты — интерфейс
                           `AbClock` из трёх методов), проверяется на фейковых часах без воркера
                           (`test/abRunner.test.ts`). `startB` пересоздаёт только Б (диспоузит
                           предыдущий `simB`, если был) — A и весь остальной `abRunner` переживают
                           смену сценария Б без изменений
  state/
    store.ts                   стор на zustand (единственная новая прод-зависимость, п.1
                           карточки). Хранит вкладку, выбор сети, параметры (runtime-safe —
                           применяются через `sim.setParams` сразу; restart-required — только
                           черновик до кнопки «Перезапустить»), состояние времени/скорости,
                           HUD-метрики. `bindViewport` подписывается на `engine.onFrame` (fps,
                           rtFactor, число машин, дисплейные часы) и на `sim.onReport`
                           (периодический `requestReport`, т.к. воркер сам шлёт отчёт раз в
                           `metrics.windowS`, а HUD хочет чаще); отписывается перед каждой
                           новой подпиской. Restart = не «горячая» замена сима, а ремонт
                           `<Viewport key={restartToken}>` из ui/App.tsx — проще и надёжнее,
                           чем учить Viewport переинициализировать бегущий воркер. (T-24) добавлены
                           `scenarios`/`activeScenarioId`/`appliedScenarioId`/`selection` и их
                           экшены; `foldRestart` — общая функция, которую вызывают все четыре пути,
                           заставляющие Viewport перемонтироваться (смена сети, пресет времени,
                           «Перезапуск», «Запустить» сценарий), чтобы черновик restart-required
                           параметров переносился одинаково везде (ревью T-23 про этот баг).
                           (T-26) `simB`/`reportB`/`abSelected`/`abStatus`/`compareScenarioBId` +
                           `startComparisonWithScenario`/`stopComparison`/`setAbSelected`/
                           `applyRecommendationToScenarioB` — "A" остаётся тем же `sim`/`report`,
                           что и раньше (главный воркер, привязанный к `appliedScenarioId`);
                           `abRunner` (sim/abRunner.ts) держится в модульной переменной как и
                           `unbindPrevious`, диспоузится в `bindViewport` при любом перемонтировании
                           Viewport (сеть/«Перезапуск»/«Запустить» инвалидируют старые `simA`/
                           `baseNetwork`, на которых был построен `abRunner`) и в `stopComparison`.
                           `togglePlay`/`setSpeedFactor` зеркалят play/pause/скорость на Б через
                           `abRunner.setPlaying`/`.setSpeedFactor`, когда сравнение идёт.
                           `applyRecommendationToScenarioB` не трогает `activeScenarioId` — пишет в
                           отдельный сценарий Б (`compareScenarioBId`, переиспользуется между
                           рекомендациями) в обход "Сценарии"-редактора
    scenarios.ts                (T-24) CRUD сценариев и (де)сериализация в localStorage — чистые
                           функции без React, стор лишь вызывает их. `upsertOverride`/
                           `removeOverride` работают по ключу (`kind`, id сущности): одна форма —
                           один override на сущность, повторное «Применить» замещает его целиком.
                           `scenariosForNetwork` всегда добавляет синтетический `baselineScenario`
                           первым; он никогда не лежит в localStorage. `parseImportedScenario`
                           проверяет `ScenarioSchema` и `networkId` (иначе `ScenarioImportError`
                           с кодом, а не текстом — текст живёт в `i18n/ru.ts`)
    assumptions.ts              `computeAssumptionShares(network)` — доля provenance="default"
                           по категориям прямо из загруженной сети (не из
                           `data/networks/*.assumptions.json`, которого нет для демо-сети).
                           Категории вроде "карман поворота" объединяют пары ключей
                           `ASSUMPTION_KINDS` компилятора, которые на уровне сети неразличимы;
                           merge/acceleration — self-referential (знаменатель = сама категория,
                           а не все узлы/полосы), т.к. осмысленного "osm"-источника для них
                           в компиляторе нет вовсе
    format.ts                   formatClock/rtFactorLevel/roundKph/roundHours/formatFps/formatShare/
                           roundMeters — чистые функции без русских строк (юниты — в i18n/ru.ts).
                           `emaStep` (T-25) — привязанное ко времени экспоненциальное сглаживание,
                           против пилы ±6%/`windowS/8` у `delayVehS`/`delayPersonS` (ревью T-18) —
                           использует и `BottlenecksTab.tsx` (столбец задержки), и `Sparkline.tsx`
    compareReport.ts             (T-26) чистая математика вкладки «Сравнение», без React/стора:
                           `computeTotalsDelta(a, b)` — по одной строке на каждый ключ из
                           `TOTALS_DELTA_KEYS` (задержки маш-ч/чел-ч, средние скорости по классам,
                           доля LOS E/F), `delta = b - a`; `diffBottlenecks(a, b)` — сравнение по
                           `item.id` (`${linkId}:${nodeId ?? "mid"}`, стабилен между отчётами —
                           ревью T-19) даёт appeared/disappeared, остаток жадно паруется по
                           совпадающему `nodeId` при разных `linkId` в moved ("переехавшие")
  ui/
    App.tsx                     композиция: подписывается на стор, строит `configPatch`
                           (useMemo) и монтирует `<Viewport key={restartToken}>` + панели
    Layout.tsx                   раскладка: канвас на весь экран, поверх — боковая панель,
                           HUD, тултип, атрибуция, время внизу (все — absolute/CSS, без
                           сторонних UI-библиотек)
    TimeBar.tsx                   play/pause, 1×/2×/5×/10×, часы, пресеты, «Перезапуск»,
                           прогресс-бар прогрева. (T-26) переключатель A/Б (`ab-toggle-group`) —
                           показывается только когда `simB` существует и `abStatus === "ready"`;
                           клавиша Tab делает то же самое (слушатель на `window`, игнорирует
                           фокус в `<input>`/`<textarea>`/`<select>`/`contenteditable`, чтобы не
                           ломать порядок табуляции в формах редактора сценариев)
    Hud.tsx                       машины/бюджет, rtFactor (жёлтый/красный), fps, средняя
                           скорость и задержка за окно (из последнего `BottleneckReport`)
    ParamsPanel.tsx                4 слайдера = `RUNTIME_SAFE_PARAM_PATHS` дословно (тест
                           `store.test.ts` сверяет их с контрактом) + бюджет машин/такси в
                           выделенке с пометкой «требует перезапуска»
    OverviewTab.tsx                выбор сети, кнопки камеры (`rig.overview`/`rig.focus`),
                           переключатели слоёв «Здания»/«Зелень и вода» (T-27: локальный стейт
                           компонента, не стор — при смене сети Viewport перемонтируется со
                           свежими группами `cityLayers`, эффект переприменяет текущее состояние
                           чекбоксов к ним), `<ParamsPanel/>`, легенда допущений
    Tooltip.tsx                    рейкаст курсора на плоскость y=0, ближайший узел/линк в
                           метрах (не меш-рейкаст: полотно дорог — общая геометрия без
                           привязки атрибутов к id линка/узла, см. ARCHITECTURE.md); пикинг
                           вынесен в `scene/picking.ts` (T-24), сам компонент не изменился
    ScenariosTab.tsx                (T-24) вкладка «Сценарии»: список (создать/копировать/
                           переименовать/удалить), активный сценарий, «Запустить» (переносит
                           `activeScenarioId` в `appliedScenarioId` через тот же `foldRestart`,
                           что и остальные рестарты), экспорт/импорт JSON (`<a>`-скачивание,
                           `<input type=file>`), и — когда активен не-базовый сценарий и есть
                           `selection` из стора — нужная форма. Для базового сценария формы
                           скрыты (его нельзя редактировать, только скопировать в новый)
    LinkForm.tsx                     (T-24) форма линка: сквозные полосы, скорость, левый/правый
                           карман (0 = нет), выделенка (вкл/выкл, часы, окно въезда направо).
                           Текущие значения читает прямо из `viewport.network` (полосы линка по
                           `kind`/`turns`), при «Применить» отправляет **все** поля разом —
                           `state/scenarios.ts`'s upsert замещает предыдущий override целиком
    IntersectionForm.tsx             (T-24) форма перекрёстка: режим левого поворота на подход,
                           зелёные секунды по группам (`controller.groups`/`.phases` уже несут
                           `approachLinkId`/`section` — не нужен доступ к `@atl/map-data`'s
                           `mainGroupId`/`arrowGroupId` из браузера), цикл, смещение, пешеходная
                           фаза. Показывает `notEditableNode`, если узел не `signalized`
    BottlenecksTab.tsx               (T-25) вкладка «Узкие места» — см. отдельный раздел ниже
    CauseBar.tsx                     (T-25) полоса долей причин: подписи из `@atl/contracts`'s
                           `CAUSES.ru` (не дублируются в `i18n/ru.ts` — это часть контракта, как и
                           коды причин), `visibleCauses` прячет доли < 2% (нечитаемые волоски),
                           остаток до 1 (`causes` нормируются только по `DELAY_CAUSE_KEYS`) —
                           нейтральный "остальное", а не растянутые проценты
    Sparkline.tsx                    (T-25) canvas 2D, без библиотек: сумма `delayVehH` по
                           `report.items` за 30 минут, сглаженная `emaStep` (см. `format.ts`),
                           плюс число активных узких мест (`report.items.length`)
    Minimap.tsx                      (T-25) canvas 2D: линки, окрашенные по среднему `speedRatio`
                           своих сегментов, четырёхугольник обзора камеры (рейкаст 4 углов NDC на
                           плоскость земли), клик = `rig.focus`. Перерисовывается по таймеру
                           (200 мс), не по rAF — минимапе не нужны 60 fps
    CompareTab.tsx                  (T-26) вкладка «Сравнение» — см. отдельный раздел ниже
  i18n/ru.ts                   все строки интерфейса (единственное исключение — коды причин
                           в `@atl/contracts/causes.ts` и метки рекомендаций (`Recommendation.label`),
                           там это часть контракта, не UI)
scripts/copy-networks.mjs      data/networks/*.gz -> public/networks/ (predev/prebuild)
```

## Отладка и стресс-тест

- `?sim=stub` — воркер со `StubSimulation` (500 точек по окружности) вместо реального ядра
  `@atl/sim-core`; полезно, пока сигналы/пешеходы (T-09/T-15) не посчитаны реальным ядром
  (оно сейчас всегда отдаёт `OFF`/`0` — см. `packages/sim-core/src/simulation.ts`).
- `?stress=1` — рендерит 20 000 инстансов машин без воркера вообще (`sampleStressFrame` в
  `src/sim/client.ts`), для проверки FPS (критерий приёмки T-13).
- `KeyC` — переключает видимость ленты коннекторов (T-05, временно, до панели слоёв T-23).

## Как подложить свою сеть

1. Сгенерируй `data/networks/<bboxId>.network.json.gz` компилятором (`pnpm compile --bbox <id>`, T-02).
2. `pnpm dev`/`pnpm build` сами копируют `data/networks/*.gz` в `apps/web/public/networks/`
   через `predev`/`prebuild` (`scripts/copy-networks.mjs`). Ничего вручную копировать не нужно.
3. `loadNetwork(networkId)` в `src/data/loadNetwork.ts` подставляет `bboxId` в URL; переключатель
   «Сеть» в OverviewTab берёт id из `NETWORK_IDS` (`state/store.ts`, `small`/`big` ->
   `almaty-abay-small`/`almaty-center-big`) — таблица продублирована из
   `packages/map-data/src/bboxes.ts`, а не импортирована оттуда: барель `@atl/map-data` тянет за
   собой импортёр/компилятор на `node:fs`/`node:crypto`, что незачем тащить в браузерный бандл
   ради двух строк-id (см. заметку ревью T-02 в карточке T-23 — там же был предложен этот вариант).
   По той же причине `Viewport.tsx` берёт `applyOverrides` не из корня пакета, а из отдельного
   subpath-экспорта `@atl/map-data/overrides` (T-24) — он ведёт прямо в
   `packages/map-data/src/compiler/overrides.ts`, который не тянет ничего node-специфичного.
   Если файла нет (в т.ч. когда дев-сервер отвечает 200 с `index.html` вместо 404 — обычное
   поведение SPA-фолбэка) или сеть не прошла gzip-магию/`parseNetwork`, приложение показывает
   встроенную демо-сеть из `src/data/demo-network.ts` (сейчас так для `big` — компилятор ещё не
   прогонялся на большом полигоне), чтобы разработка не блокировалась на T-02.

## Редактор сценариев (T-24)

Вкладка «Сценарии» (`ScenariosTab`/`LinkForm`/`IntersectionForm`, `state/scenarios.ts`) редактирует
`Scenario.overrides` (`@atl/contracts`) формами, без рисования геометрии (docs/DECISIONS.md D12):

- **Клик по карте.** `Viewport`'s canvas слушает `click` и тем же пикингом, что и тултип
  (`scene/picking.ts`), сообщает наверх выбранный узел/линк (`state/store.ts`'s `selection`).
  `ScenariosTab` рендерит `IntersectionForm` для узла (сообщение `notEditableNode`, если он не
  `signalized`) или `LinkForm` для линка; обе формы читают текущие значения прямо из
  `viewport.network` — той сети, что сейчас реально нарисована (после применения сценария она уже
  содержит его overrides, так что форма показывает актуальное состояние, а не «сырую» базовую сеть).
- **«Применить» в форме** — сразу, без пересчёта и рестарта, обновляет override в
  `state.scenarios`/localStorage (`upsertOverrideInActiveScenario`); базовый сценарий недоступен для
  редактирования (`activeScenarioId === "baseline"` прячет обе формы за подсказкой).
- **«Запустить» на вкладке** — единственное действие, которое реально пересчитывает и
  перезапускает сеть: `appliedScenarioId = activeScenarioId` + `restartToken++` через тот же
  `foldRestart`, что и остальные три пути ремонта `<Viewport>` (сеть, пресет времени,
  «Перезапуск») — ревью T-23 просило одно место вместо копипасты, чтобы черновик
  `draftRestartParams` не терялся молча ни на одном из путей. Сам пересчёт (главный поток,
  индикатор "Применение сценария…") — внутри `Viewport`: `applyOverrides(network, overrides,
  defaultSimConfig(configPatch), scenarioId)` из `@atl/map-data/overrides`.
- **Подсветка (контур).** `scene/highlight.ts` рисует контур вокруг того, что реально изменилось,
  читая `provenance === "manual"` прямо из уже скомпилированной сети — не отдельный список
  overrides, значит не может разойтись с тем, что на самом деле нарисовано.
- **Экспорт/импорт JSON.** `exportScenarioJson`/`parseImportedScenario` (`state/scenarios.ts`):
  импорт проверяет `ScenarioSchema` и что `networkId` совпадает с текущей сетью, иначе
  `ScenarioImportError` (код, не готовый текст — тексты в `i18n/ru.ts`, `scenarioImportError.*`).
- **Хранение.** `localStorage["atl.scenarios.v1"]`, один плоский список поверх всех сетей;
  `scenariosForNetwork` фильтрует по `networkId` и всегда добавляет синтетический
  `baselineScenario` первым (он никогда не пишется в localStorage).

### Тесты
`packages/map-data/test/compiler/overrides.test.ts` — сама пересборка сети (см. README пакета).
На стороне apps/web: `test/scenarios.test.ts` (CRUD + сериализация, без React), `test/picking.test.ts`
(пикинг узла/линка на синтетических сетях), `test/ScenariosTab.test.tsx` (сквозной смоук-тест на
`@testing-library/react`: клик -> форма -> «Применить» -> override в сторе, включая ветку
`notEditableNode` и то, что формы скрыты для базового сценария) и добавленные в `test/store.test.ts`
тесты на новые экшены стора (`createScenario`/`duplicateScenario`/.../`runActiveScenario` через
`foldRestart`).

## Узкие места (T-25)

Вкладка «Узкие места» (`ui/BottlenecksTab.tsx`) читает `useStore((s) => s.report)` напрямую — T-23
уже опрашивает `sim.requestReport()` каждые 3с (`store.ts`'s `REPORT_POLL_INTERVAL_MS`), отдельной
подписки не требуется (ревью T-23).

- **Тепловая карта** (`scene/heatmap.ts`). Единственный источник скорости по сегментам —
  `MetricsFrame.speedRatio` из `sim.onMetrics` (не `report.items`, который несёт только Топ-N узких
  мест, а не все сегменты). Буфер `MetricsFrame` — transferable и уходит обратно воркеру сразу после
  колбэка (`@atl/sim-worker`'s `client.ts`), поэтому `speedRatio` копируется в собственный
  `Float32Array` синхронно внутри колбэка, а не хранится как ссылка. Два режима (без отдельного
  "текущего" — в воркере не считается ничего короче окна): «окно 5 мин» (сам `speedRatio`, он и есть
  окно `config.metrics.windowS`) и «выкл» (`setVisible(false)`, подписка на метрики не
  останавливается — это дёшево). Легенда — та же цветовая шкала, что и заливка.
- **Маркеры** (`scene/markers.ts`). Один CSS2D-чип на элемент `report.items` (не на отсортированный
  клиентом список — ранг маркера всегда "по машино-часам", как его посчитал сервер), цвет по LOS.
  Клик — `setSelectedId` + `setExpandedId` + `rig.focus(item.focus[0], item.focus[1], FOCUS_RADIUS_M)`;
  то же самое делает кнопка «Показать» и на уровне строки, и на уровне рекомендации.
- **Таблица.** `smoothBottleneckItems` сглаживает `delayVehH`/`delayPersonH` по стабильному `item.id`
  (`emaStep`, τ = 90с) — иначе в столбце дважды в минуту дёргалась бы пила ±6%/`windowS/8` (ревью
  T-18/T-19). `sortReportItems` — клиентская пересортировка по человеко-часам; `item.rank` при этом
  не пересчитывается, он остаётся «ранг по машино-часам» независимо от текущей сортировки (решение
  карточки T-19, не баг). LOS никогда не показывается в одиночку — всегда рядом с V/C прямо в шапке
  строки, плюс очередь/скорость/устойчивость в раскрытом виде (ревью T-19: «LOS A» рядом с очередью
  95м на реальной сети читается как ошибка панели, если стоит отдельно).
- **Причины и рекомендации.** `CauseBar` — подписи из `CAUSES.ru`, не из `i18n/ru.ts` (это часть
  контракта). Пустой список рекомендаций — штатное состояние примерно у половины Топ-6 на реальной
  сети (нерегулируемый узел, причина без сценария) и верстается явной подсказкой, а не пропускается.
  «Применить в сценарии» — на базовом сценарии сначала создаёт новый (`createScenario`, имя из
  названия узкого места), затем `upsertOverrideInActiveScenario` на каждый `Recommendation.overrides`
  (уже готовые `NetworkOverride[]`, ничего собирать самому не нужно) — то есть ровно то же API,
  которым `LinkForm`/`IntersectionForm` пишут в сценарий (T-24), просто вызванное с другой вкладки.
  (T-26) Рядом — «Применить рекомендацию в Б»: не трогает "Сценарии"/`activeScenarioId`, а вызывает
  `applyRecommendationToScenarioB`, которая пишет в отдельный сценарий Б (создаёт при первом
  использовании, дальше переиспользует по `compareScenarioBId`) и сразу перезапускает сравнение.
- **Спарклайн + мини-карта** — `ui/Sparkline.tsx`/`ui/Minimap.tsx`, см. дерево файлов выше.
- **A/Б-переключатель (T-26).** Отчёт и тепловая карта в этой вкладке следуют за
  `state.abSelected` — `report`/`activeSim` внутри компонента выбирают между A (`s.report`/`s.sim`)
  и Б (`s.reportB`/`s.simB`); построение геометрии тепловой карты (сегменты/меш) остаётся
  завязанным на A (сети A и Б обычно совпадают по разметке сегментов — ревью T-19 про сохранение
  id при большинстве overrides), пересобирается только перекраска (`setSpeedRatios`) при смене
  активного сима. Минимапа сознательно не переключается — она вне объёма п.2 карточки T-26.

### Тесты (T-25)
`test/heatmap.test.ts` (`speedRatioToColor`, вершины/цвета merged-геометрии по индексу сегмента),
`test/CauseBar.test.ts` (`causeLabel`/`causeColor`, `visibleCauses`), `test/Sparkline.test.ts`
(сглаживание, обрезка буфера по 30 минутам) и `test/BottlenecksTab.test.tsx` (`smoothBottleneckItems`,
`sortReportItems` плюс сквозной смоук-тест: пустые состояния, сортировка, раскрытие строки,
«Применить в сценарии» действительно создаёт сценарий и пишет override, «Показать» зовёт `rig.focus`).

## Сравнение A/Б (T-26)

Второй воркер для сценария Б, работающий рядом с уже запущенным A, синхронизация времени между ними
и вкладка «Сравнение» с таблицей дельт и списками изменившихся узких мест.

- **`sim/abRunner.ts`.** "A" — это тот же главный `sim`/`viewport`, что и везде в приложении; Б
  запускается через `startSim` (`sim/client.ts`) на сети, скомпилированной из `viewport.baseNetwork`
  (сеть до применения оверрайдов ЭТОГО монтирования) плюс оверрайды сценария Б, тем же
  `configPatch`/сидом, что и A. `stepAbSync` — чистая функция синхронизации: раз в 500 мс сравнивает
  `simTimeS` обеих сторон и ставит на паузу ту, что вырвалась вперёд больше чем на `AB_SYNC_LAG_S`
  (5 с), пока другая не наверстает; проверяется на фейковых часах (`AbClock` — три метода) без
  worker'а вообще (`test/abRunner.test.ts`). Смена сценария Б (`startB`) диспоузит только предыдущий
  `simB` — A не перезапускается.
- **Переключатель A/Б.** Живёт в баре времени (`ui/TimeBar.tsx`), не в самой вкладке «Сравнение» —
  он глобальный и решает, чьи кадры сейчас рисует 3D-сцена (`ViewportHandle.setCompareSim`,
  `Viewport.tsx`), а заодно — какой отчёт/тепловую карту показывает вкладка «Узкие места» (см. выше).
  Появляется только когда `simB` существует и прогрелся (`abStatus === "ready"`); клавиша Tab дублирует
  клик (слушатель на `window`, проверяет и `event.code`, и `event.key` — некоторые автоматизированные
  источники ввода не заполняют `.code`, это выяснилось на живой проверке в браузере при разработке
  карточки).
- **Вкладка «Сравнение» (`ui/CompareTab.tsx`).** Пикер сценария Б (`scenariosForNetwork`, без
  baseline) + «Запустить сравнение»/«Перезапустить Б»/«Остановить сравнение»
  (`startComparisonWithScenario`/`stopComparison`). Таблица totals A/Б/Δ —
  `state/compareReport.ts`'s `computeTotalsDelta`, цвет Δ зависит от метрики (для задержки/доли
  E-F меньше — лучше, для скоростей больше — лучше, см. `LOWER_IS_BETTER` в `CompareTab.tsx`). Топ-N
  A и Б рядом, ниже — «Новые в Б»/«Исчезли в Б»/«Переехали на другой подход»
  (`diffBottlenecks`, сравнение по `item.id`, «переехавшие» — совпадающий `nodeId` при разном
  `linkId`). Клик по любой строке зовёт `rig.focus` и переключает A/Б на Б, чтобы сразу увидеть то,
  на что кликнули.
- **Числа сравнивать по `totals`, не по абсолютной задержке отдельного узкого места** — та же пила
  ±6%/`windowS/8` (ревью T-18/T-19), что и у вкладки «Узкие места»; таблица дельт здесь её не
  сглаживает намеренно (задержка окна `totals.delayVehH`/`delayPersonH` — накопленная с начала
  прогона величина, а не оконный отчёт по одному узкому месту, так что пила там не так заметна).

### Тесты (T-26)
`test/abRunner.test.ts` (`stepAbSync` на фейковых часах: держит паузу, отпускает по достижении
порога, конвергенция «Б только что прогрелась, A давно играет» без единой паузы Б), `test/
compareReport.test.ts` (`computeTotalsDelta` по фиксированному набору ключей, `diffBottlenecks` —
appeared/disappeared/moved на синтетических отчётах, включая жадное сопоставление при нескольких
кандидатах на один узел) и `test/CompareTab.test.tsx`/новые кейсы в `test/store.test.ts`
(`startComparisonWithScenario` без готовой A, `applyRecommendationToScenarioB` переиспользует
сценарий Б вместо создания нового на каждый клик). Живая проверка в браузере (`pnpm --filter @atl/web
dev`, вкладка «Узкие места» → «Применить рекомендацию в Б» → тумблер A/Б в баре времени → вкладка
«Сравнение») — без ошибок в консоли, таблица дельт и списки appeared/disappeared обновляются.

## Команды

```bash
pnpm --filter @atl/web dev      # то же, что pnpm dev из корня
pnpm --filter @atl/web build    # то же, что pnpm build из корня
pnpm --filter @atl/web test     # vitest, окружение jsdom (T-23: смоук-тест TimeBar на @testing-library/react)
pnpm --filter @atl/web e2e      # то же, что pnpm e2e из корня (см. ниже)
```

## E2E smoke-тест (T-30)

`e2e/smoke.spec.ts` (Playwright, конфиг `playwright.config.ts`) поднимает прод-сборку через `pnpm build`
и `vite preview` (`webServer`), открывает страницу и проверяет: канвас смонтирован, за 15 с пришло
не меньше 10 кадров, в консоли браузера нет ошибок. Сеть не нужна — `data/loadNetwork.ts` при пустом
`data/networks/` использует встроенную демо-сеть. Ход кадров читается из `window.__atl.frames` —
счётчика, который `scene/renderer.ts` увеличивает в цикле `requestAnimationFrame` на каждый вызов
`renderer.render` (тип объявлен в `src/global.d.ts`); тест не читает пиксели и не трогает воркер/сим.

Проект Playwright закреплён на `channel: "chromium"` (полный браузер, который `playwright install
chromium` ставит вместе с лёгким "headless shell") — на "headless shell" этот канвас ловит throttling
`requestAnimationFrame` до ~1 fps (в консоли повторяется `GL Driver Message ... GPU stall due to
ReadPixels`), из-за чего проверка «≥ 10 кадров за 15 с» становится нестабильной; на полном браузере
эта же страница держит 30+ fps без такого стола.

```bash
pnpm exec playwright install --with-deps chromium   # один раз локально; в CI отдельный шаг
pnpm e2e
```

## Вне объёма (T-25)

Содержимое вкладки «Сравнение» было заглушкой со ссылкой на T-26 (навигация между вкладками уже
работала) — реализовано в T-26, см. раздел выше.

## Вне объёма (T-26)

- **Геометрия дорог для Б не пересобирается.** Переключатель A/Б меняет только то, чьи кадры читает
  рендер (`ViewportHandle.setCompareSim`) — полотно/разметка/коннекторы остаются построены по сети A.
  Для сценариев, меняющих только сигналы (карточное «стрелка налево») это не заметно; сценарий,
  реально перестраивающий полосы (например, удлинение кармана), будет правильно посчитан в Б (иная
  геометрия используется при симуляции), но нарисован поверх геометрии A. Полный рендер второй сети
  потребовал бы второй набор `roadSurfaces`/`markings`/`connectors` слоёв — за пределами п.2 карточки
  («рендер читает кадры выбранного клиента», не «рендер вторую сеть»).
- **Мини-карта (`ui/Minimap.tsx`) не следует за A/Б-переключателем** — карточка называет только
  «рендер», «тепловую карту» и «Топ-N» (п.2); минимапа продолжает показывать A.
- **Runtime-safe параметры (`ParamsPanel`) применяются только к A.** `setRuntimeParam` не зовёт
  `simB.setParams` — карточка описывает только синхронизацию play/pause/скорости («общий контроль
  времени», п.1), не глобальных параметров спроса/дисциплины.
- **Скорость «догона» Б ограничена реальным временем.** Если сравнение стартует, когда A уже давно
  идёт, Б после своего прогрева должен нагнать всю разницу, играя с тем же `speedFactor`, что и A, —
  карточка описывает только правило «кто вырвался вперёд — на паузу», не ускоренный догон; на большом
  разрыве переключатель на баре времени, дающий Б поиграть на 10×, закрывает это на практике.
