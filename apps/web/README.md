# @atl/web

Three.js-рендер полотна дорог и разметки по `Network` из `@atl/contracts`, инстансы машин/светофоров/
пешеходов по `FrameBuffers` из `@atl/sim-worker`, плюс React-оболочка (раскладка, управление временем,
глобальные параметры, HUD, легенда допущений, тултип) поверх неё (T-23), плюс редактор сценариев
(T-24: клик по перекрёстку/улице на карте, формы, вкладка «Сценарии», применение = пересборка сети
`@atl/map-data`'s `applyOverrides` в главном потоке + перезапуск). Сам ничего не считает про движение —
только читает буферы кадров и метрики (`sim-core`/`sim-worker`).

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
                           наверх выбранный узел/линк для форм редактора
  sim/client.ts                 (T-23) `SimHandle` дополнен `setParams`/`requestReport`/`onMetrics`/
                           `onReport`/`latestFrameMeta()` — тонкие проброс-обёртки над `SimClient`
                           из `@atl/sim-worker`, плюс мутируемый снимок последнего кадра
                           (rtFactor/vehicleCount/timeOfDayMin) для HUD
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
                           параметров переносился одинаково везде (ревью T-23 про этот баг)
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
    format.ts                   formatClock/rtFactorLevel/roundKph/roundHours/formatFps/formatShare —
                           чистые функции без Русских строк (юниты — в i18n/ru.ts)
  ui/
    App.tsx                     композиция: подписывается на стор, строит `configPatch`
                           (useMemo) и монтирует `<Viewport key={restartToken}>` + панели
    Layout.tsx                   раскладка: канвас на весь экран, поверх — боковая панель,
                           HUD, тултип, атрибуция, время внизу (все — absolute/CSS, без
                           сторонних UI-библиотек)
    TimeBar.tsx                   play/pause, 1×/2×/5×/10×, часы, пресеты, «Перезапуск»,
                           прогресс-бар прогрева
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
  i18n/ru.ts                   все строки интерфейса (единственное исключение — коды причин
                           в `@atl/contracts/causes.ts`, там это часть контракта, не UI)
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

## Команды

```bash
pnpm --filter @atl/web dev      # то же, что pnpm dev из корня
pnpm --filter @atl/web build    # то же, что pnpm build из корня
pnpm --filter @atl/web test     # vitest, окружение jsdom (T-23: смоук-тест TimeBar на @testing-library/react)
```

## Вне объёма (T-24)

Содержимое вкладок «Узкие места»/«Сравнение» — заглушки со ссылкой на T-25/T-26 соответственно (сама
навигация между вкладками уже работает). Тепловая карта — T-25. Панель А/Б сравнения двух сценариев
в одном 3D-окне (D12) — T-26.
