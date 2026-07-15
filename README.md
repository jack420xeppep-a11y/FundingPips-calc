# FundingPips Calc

React-интерфейс и независимый расчётный движок для синхронизированной позиции FundingPips / Bybit.

Production: [farmcalc.duckdns.org](https://farmcalc.duckdns.org)

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
```

Тесты проверяют расчёт лотов и TP/SL, пресеты аккаунтов, сценарии цикла, лестницу восстановления и контракт React-интерфейса.

## Структура

- `src/domain/calculator.js` — чистые вычисления без React и DOM.
- `src/components/` — поля, результаты двух платформ, настройки, сценарии и recovery view.
- `src/App.jsx` — состояние приложения, переключение разделов и синхронизация параметров.
- `src/styles.css` — Linear Precision Fintech, светлая и облегчённая графитовая темы, mobile layout.
- `DESIGN.md` — дизайн-система и QA-критерии.

Приложение выполняет расчёты локально и не подключается к биржам или торговым аккаунтам.

## CI/CD

Каждый pull request и push в `main` проходит тесты, аудит зависимостей и production-сборку в GitHub Actions. Успешный push в `main` автоматически публикует содержимое `dist/` на production ограниченным SSH-ключом без root-доступа.

- Workflow: `.github/workflows/deploy.yml`.
- Серверный forced-command: `ops/fundingpips-calc-deploy`.
- Rollback: revert проблемного коммита и push в `main`; workflow автоматически развернёт предыдущую сборку.
