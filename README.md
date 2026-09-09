# Almaty Traffic Lab

[![check](https://github.com/glymskii/almaty-traffic-lab/actions/workflows/check.yml/badge.svg)](https://github.com/glymskii/almaty-traffic-lab/actions/workflows/check.yml)

Интерактивная 3D-микросимуляция движения в центре Алматы с детекцией и объяснением узких мест.
Цель проекта: показать, что с помощью ИИ можно собрать полноценную симуляцию города с учётом нюансов движения
(скорости, полосы, левые карманы, дополнительные секции светофоров, автобусные выделенки, пешеходы, слияния),
на условных данных и с заменяемым источником.

- План и волны задач: [docs/PLAN.md](docs/PLAN.md)
- Архитектура: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Контракты: [docs/CONTRACTS.md](docs/CONTRACTS.md)
- Нюансы и их тесты: [docs/NUANCES.md](docs/NUANCES.md)
- Журнал решений: [docs/DECISIONS.md](docs/DECISIONS.md)
- Карточки задач для агентов: [docs/tasks](docs/tasks)
- Правила для агентов: [CLAUDE.md](CLAUDE.md)

## Команды

```bash
pnpm install
pnpm check          # typecheck + lint + determinism + tests: Definition of Done любой задачи
pnpm run import --bbox small|big
pnpm run compile --bbox small|big
pnpm sim --network data/networks/<id>.network.json.gz --minutes 10 --seed 1
pnpm dev
pnpm build           # прод-сборка apps/web → apps/web/dist
pnpm e2e             # Playwright smoke-тест (apps/web/e2e/smoke.spec.ts) поверх pnpm preview
```

## CI (docs/tasks/T-30)

`.github/workflows/check.yml`, три job'а:
- **check** — на каждый push/PR: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build`. Зелёный бейдж выше = зелёный этот job на `main`.
- **e2e** — отдельный job, ставит браузер Playwright (`playwright install --with-deps chromium`) и гоняет `pnpm e2e`.
- **bench** — только ручной запуск (`workflow_dispatch`), `pnpm test` с `ATL_BENCH=1` (нюанс N27 из `docs/tasks/T-28`, `describe.skipIf(!process.env.ATL_BENCH)`); порог не жёсткий, поэтому не идёт на каждый push/PR.

## Деплой (Vercel, волна 6)

Статическая сборка `apps/web` описана в `vercel.json` (`buildCommand: pnpm build`, `outputDirectory: apps/web/dist`).
**Деплой делает только владелец репозитория** — агенты и CI деплой не запускают. Разово для владельца:

```bash
npm i -g vercel@latest
vercel link      # один раз, привязать репозиторий к проекту Vercel
vercel --prod    # деплой в прод
```

Данные карты: © OpenStreetMap contributors, ODbL.
