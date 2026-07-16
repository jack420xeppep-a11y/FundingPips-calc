# FundingPips Calc

React-интерфейс и независимый расчётный движок для синхронизированной позиции FundingPips / Bybit.

Production: [farmcalc.duckdns.org](https://farmcalc.duckdns.org)

## Возможности

- синхронный расчёт противоположных ног FundingPips / Bybit с явными лотами, TP и SL;
- опциональная live-синхронизация цены `EURUSD+`, `GBPUSD+` и `XAUUSD+` из публичного Bybit TradFi WebSocket;
- динамический порог безубытка, текущая Funded-цель и запас до порога;
- пять целей оптимизатора: минимальная нагрузка, быстрый безубыток, максимум при сливе FP, минимальный Funded TP и баланс;
- сравнение и применение профилей `Сбалансированная`, `Bybit-first`, `Funded-first`;
- сценарии полного цикла и отдельная лестница восстановления;
- мобильный Quick Mode с пятью входами, двумя ногами сделки, копированием тикета и раскрываемой аналитикой;
- светлая и облегчённая графитовая темы, PWA-иконка и адаптация от 320 px.

Экономика считается без комиссий и спреда, поэтому live-режим использует середину Bid/Ask. Все вычисления выполняются локально; подключение к Bybit только читает публичные котировки и никогда не исполняет сделки.

## Запуск

```bash
npm install
npm run dev
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

Тесты проверяют расчёт лотов и TP/SL, динамический безубыток, пресеты и оптимизатор, сценарии цикла, лестницу восстановления, копируемый тикет, контракт live-котировок и React-интерфейс. Browser-smoke дополнительно проходит Quick Mode, drawer, применение стратегии, копирование и реальные live-переключения `XAUUSD+ → EURUSD+ → GBPUSD+`.

## Структура

- `src/domain/calculator.js` — чистые вычисления без React и DOM.
- `src/domain/strategies.js` — безубыток, готовые профили и цели оптимизатора.
- `src/domain/tradeTicket.js` — текст двух ног для безопасного копирования сделки.
- `src/services/bybitTradfi.js` — независимый адаптер Bybit TradFi: WebSocket, gzip, snapshot/delta и переподключение.
- `src/hooks/useLivePrice.js` — связь live-адаптера с выбранным React-инструментом.
- `src/components/` — поля, результаты двух платформ, настройки, сценарии и recovery view.
- `src/App.jsx` — состояние приложения, переключение разделов и синхронизация параметров.
- `src/styles.css` — Linear Precision Fintech, светлая и облегчённая графитовая темы, mobile layout.
- `scripts/smoke-position-workspace.mjs` — реальный smoke-тест интерфейса через headless Chrome.
- `DESIGN.md` — дизайн-система и QA-критерии.

## CI/CD

Каждый pull request и push в `main` проходит тесты, аудит зависимостей и production-сборку в GitHub Actions. Успешный push в `main` автоматически публикует содержимое `dist/` на production ограниченным SSH-ключом без root-доступа.

- Workflow: `.github/workflows/deploy.yml`.
- Серверный forced-command: `ops/fundingpips-calc-deploy`.
- Caddy-конфигурация домена: `ops/farmcalc.caddy` (CSP разрешает только публичный WebSocket Bybit).
- Rollback: revert проблемного коммита и push в `main`; workflow автоматически развернёт предыдущую сборку.
