# FundingPips Calc

React-интерфейс и независимый расчётный движок для синхронизированной позиции FundingPips / Bybit.

Production: [farmcalc.duckdns.org](https://farmcalc.duckdns.org)

## Возможности

- синхронный расчёт противоположных ног FundingPips / Bybit с явными лотами, TP и SL;
- опциональная live-синхронизация `EURUSD+`, `GBPUSD+` и `XAUUSD+` через серверный CalcPro Quote Relay;
- золотой `HL Intelligence OFF/AUTO`: агрегирует `xyz:GOLD`, Bybit `XAUUSD+`,
  рыночный режим и проверенные когорты направленных трейдеров, затем показывает
  вероятности `BB TP / FP SL`, `BB SL / FP TP` и отсутствия касания;
- динамический порог безубытка, текущая Funded-цель и запас до порога;
- пять целей оптимизатора: минимальная нагрузка, быстрый безубыток, максимум при сливе FP, минимальный Funded TP и баланс;
- сравнение и применение профилей `Сбалансированная`, `Bybit-first`, `Funded-first`;
- сценарии полного цикла и отдельная лестница восстановления;
- мобильный Quick Mode с пятью входами, двумя ногами сделки, копированием тикета и раскрываемой аналитикой;
- светлая и облегчённая графитовая темы, PWA-иконка и адаптация от 320 px.

Экономика считается без комиссий и спреда, поэтому live-режим использует
середину Bid/Ask. Quote Relay один раз читает публичный поток Bybit.
Отдельный HyperGold-процесс читает только `xyz:GOLD`, хранит ограниченную
приватную SQLite-базу и отдаёт React только агрегированные вероятности через
same-origin SSE. Адреса кошельков и индивидуальные позиции не попадают в
публичный API. Сделки не исполняются.

## Запуск

```bash
npm install
npm run relay        # терминал 1: Bybit → локальный SSE API, :8787
INTELLIGENCE_DB_PATH=/tmp/calcpro-intelligence.sqlite \
  npm run intelligence # терминал 2: HyperGold API, :8788
npm run dev          # терминал 3: React с proxy на оба API
```

Vite выведет локальный адрес приложения. Для production-сборки:

```bash
npm run build
npm run preview
```

## Проверка

```bash
npm test
npm run test:browser # при запущенном npm run dev и установленном Chrome
```

Тесты проверяют расчёт лотов и TP/SL, динамический безубыток, пресеты и
оптимизатор, сценарии цикла, лестницу восстановления, копируемый тикет,
контракты обоих live-сервисов, реконструкцию эпизодов, жизненный цикл кошельков,
когорты, outcomes/calibration, AUTO-стабилизацию и React-интерфейс.
Browser-smoke дополнительно проходит Quick Mode, drawer, применение стратегии,
копирование, intelligence lock/unlock и live-переключения инструментов.

## Структура

- `src/domain/calculator.js` — чистые вычисления без React и DOM.
- `src/domain/strategies.js` — безубыток, готовые профили и цели оптимизатора.
- `src/domain/tradeTicket.js` — текст двух ног для безопасного копирования сделки.
- `server/quote-relay.js` — Bybit WebSocket, gzip, allowlist, quote store, staleness и SSE API.
- `server/index.js` — production-процесс релея на loopback-интерфейсе.
- `intelligence/market-collector.js` — ограниченный публичный поток
  Hyperliquid `xyz:GOLD` и рыночные признаки.
- `intelligence/database.js` — независимая приватная SQLite/WAL-база,
  retention и агрегированные health-метрики.
- `intelligence/candidate-observer.js`, `episodes.js`, `cohorts.js` —
  наблюдение, реконструкция и ротация направленных gold-когорт.
- `intelligence/market-model.js`, `probability-engine.js` — market/wallet
  вероятности, Bybit outcomes, maturity и phase-aware рекомендация.
- `intelligence/api-server.js`, `runtime.js`, `index.js` — loopback API,
  same-origin SSE и production orchestration.
- `src/services/quoteRelay.js` — валидируемый same-origin EventSource-клиент.
- `src/hooks/useLivePrice.js` — связь SSE-релея с выбранным React-инструментом.
- `src/components/` — поля, результаты двух платформ, настройки, сценарии и recovery view.
- `src/App.jsx` — состояние приложения, переключение разделов и синхронизация параметров.
- `src/styles.css` — Linear Precision Fintech, светлая и облегчённая графитовая темы, mobile layout.
- `scripts/smoke-position-workspace.mjs` — реальный smoke-тест интерфейса через headless Chrome.
- `DESIGN.md` — дизайн-система и QA-критерии.

## CI/CD

Каждый pull request и push в `main` проходит тесты, operations-контракты, аудит
зависимостей и production-сборку в GitHub Actions. Успешный push в `main`
автоматически публикует frontend, quote relay и HyperGold service ограниченным
SSH-ключом без общего root-доступа.

- Workflow: `.github/workflows/deploy.yml`.
- Серверный forced-command: `ops/fundingpips-calc-deploy`.
- Caddy-конфигурация домена: `ops/farmcalc.caddy`; `/api/quotes` и
  `/api/intelligence/*` проксируются на разные loopback-сервисы, CSP оставляет
  браузеру только `self`.
- Systemd-сервисы: `ops/calcpro-quote-relay.service` и
  `ops/calcpro-gold-intelligence.service`.
- Данные HyperGold живут в `/var/lib/calcpro-intelligence`, вне release-каталога;
  deploy их не удаляет.
- Перед каждым intelligence deploy restricted preflight проверяет минимум 1 GiB
  свободного места и `PRAGMA quick_check`, затем создаёт SQLite `.backup` с
  правами `0600`; старые predeploy-копии хранятся 30 дней.
- Deploy key может обновлять только три CalcPro-каталога и перезапускать два
  CalcPro-сервиса.
- Aggregate health публикует только безопасные счётчики raw/sentiment/decision
  cadence, распределение устойчивых состояний, cooldown/emergency counts,
  maturity, freshness и decision lag — без адресов и индивидуальных позиций.
- Rollback HyperGold v1: tag `prehypergold` указывает на последнюю production
  версию до intelligence-слоя. Обычный rollback выполняется revert-коммитом и
  push в `main`, чтобы CI/CD сохранил проверяемую историю.
