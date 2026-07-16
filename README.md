# FundingPips Calc

React-интерфейс и независимый расчётный движок для синхронизированной позиции FundingPips / Bybit.

Production: [farmcalc.duckdns.org](https://farmcalc.duckdns.org)

## Возможности

- синхронный расчёт противоположных ног FundingPips / Bybit с явными лотами, TP и SL;
- динамический порог безубытка, текущая Funded-цель и запас до порога;
- пять целей оптимизатора: минимальная нагрузка, быстрый безубыток, максимум при сливе FP, минимальный Funded TP и баланс;
- сравнение и применение профилей `Сбалансированная`, `Bybit-first`, `Funded-first`;
- сценарии полного цикла и отдельная лестница восстановления;
- мобильный Quick Mode с пятью входами, двумя ногами сделки, копированием тикета и раскрываемой аналитикой;
- светлая и облегчённая графитовая темы, PWA-иконка и адаптация от 320 px.

Экономика считается без комиссий и спреда. Все вычисления выполняются локально; приложение не подключается к биржам и не исполняет сделки.

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

Тесты проверяют расчёт лотов и TP/SL, динамический безубыток, пресеты и оптимизатор, сценарии цикла, лестницу восстановления, копируемый тикет и контракт React-интерфейса. Browser-smoke дополнительно проходит Quick Mode, drawer, применение стратегии, копирование и переключение на XAUUSD.

## Структура

- `src/domain/calculator.js` — чистые вычисления без React и DOM.
- `src/domain/strategies.js` — безубыток, готовые профили и цели оптимизатора.
- `src/domain/tradeTicket.js` — текст двух ног для безопасного копирования сделки.
- `src/components/` — поля, результаты двух платформ, настройки, сценарии и recovery view.
- `src/App.jsx` — состояние приложения, переключение разделов и синхронизация параметров.
- `src/styles.css` — Linear Precision Fintech, светлая и облегчённая графитовая темы, mobile layout.
- `scripts/smoke-position-workspace.mjs` — реальный smoke-тест интерфейса через headless Chrome.
- `DESIGN.md` — дизайн-система и QA-критерии.

## CI/CD

Каждый pull request и push в `main` проходит тесты, аудит зависимостей и production-сборку в GitHub Actions. Успешный push в `main` автоматически публикует содержимое `dist/` на production ограниченным SSH-ключом без root-доступа.

- Workflow: `.github/workflows/deploy.yml`.
- Серверный forced-command: `ops/fundingpips-calc-deploy`.
- Rollback: revert проблемного коммита и push в `main`; workflow автоматически развернёт предыдущую сборку.
