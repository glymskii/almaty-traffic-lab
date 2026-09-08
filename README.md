# Almaty Traffic Lab

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
```

Данные карты: © OpenStreetMap contributors, ODbL.
