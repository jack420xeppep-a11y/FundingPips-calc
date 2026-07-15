# CalcPro — Linear Risk Console

## Brief and assumptions

CalcPro is a focused prop-hedge position engine for a trader synchronizing a FundingPips account with an opposing Bybit leg. The primary job is to turn strategy inputs into immediately readable lot sizes, TP/SL levels, challenge outcomes, and recovery steps. The current calculator remains the source of truth for behavior; this project separates that behavior from the React presentation layer.

Assumption: this is a private decision-support tool, not a public trading platform. Values update locally and no market-data or execution API is implied.

## Brand thesis

Precise enough to trust, fast enough to use during execution. The interface should feel like a professional console with quiet density, not a consumer trading app or a generic SaaS dashboard.

## Aesthetic direction

**Linear Precision Fintech / Data-Dense Executive.** Exact grid alignment, restrained rectangular geometry, tabular numbers, compact controls, and one blue system accent. Platform identity is communicated by structural color bands: Bybit uses cobalt-blue, FundingPips uses amber. Profit and loss remain semantic green and red and never double as platform identity.

## Reference extraction

- Preserve the selected reference's light canvas grid, hairlines, oversized lot values, and compact mono labels.
- Preserve the original calculator's complete input and scenario model.
- Do not copy a branded trading terminal; platform colors are product-local wayfinding.

## Color tokens

Light theme:

- Canvas `#f3f5f7`, surface `#ffffff`, raised `#f7f8fa`.
- Ink `#101419`, muted `#68717d`, line `#d9dfe5`, strong line `#b8c1cb`.
- Accent `#246bfd`; positive `#007f5f`; negative `#d43d51`; warning `#9a6500`.
- Bybit `#315ee8` / soft `#eef3ff`; FundingPips `#a86400` / soft `#fff6e8`.

Dark theme deliberately avoids near-black:

- Canvas `#252b33`, surface `#2d343e`, raised `#353e49`.
- Ink `#f3f6f8`, muted `#b1bac5`, line `#46515e`, strong line `#627080`.
- Accent `#82a7ff`; positive `#5be0b3`; negative `#ff8997`; warning `#f4c66b`.
- Bybit soft `#2d3d63`; FundingPips soft `#4a3c29`.

## Typography

- UI: `Arial`, `Helvetica Neue`, system sans for highly reliable local rendering.
- Numeric/data roles: `SFMono-Regular`, `Consolas`, `Liberation Mono`, monospace.
- One compact page title, 11–12px uppercase metadata, tabular numbers, decisive lot-size scale.

## Grid and spacing

- Desktop container max-width 1480px with a 12-column logic.
- Primary execution area plus a 320–360px settings/limits rail.
- Spacing scale: 4, 8, 12, 16, 24, 32, 48, 64px.
- Dense sections use 16–24px padding; no oversized empty dashboard gutters.

## Radius, borders, and shadows

- Radii: 4px for controls, 8px for panels, 999px only for status/toggle pills.
- Hairline borders define hierarchy; shadows are limited to the main console and sticky mobile controls.
- Platform result panels use colored top rules and lightly tinted backgrounds, not gradients.

## Motion

- Only theme toggle, tab underline, disclosure, and value refresh feedback.
- 140–180ms ease-out transitions; no spring or scale-hover effects.
- `prefers-reduced-motion` disables nonessential transitions.

## Component families and states

- App header: product ID, live/local status, theme control.
- Primary rail: instrument, entry, direction, SL distance, stage.
- Execution result: paired platform legs with direction, lots, TP, SL, and P&L intent.
- Risk summary: account/challenge limits and exposure status.
- Settings deck: FundingPips parameters and Bybit stakes, packed in expandable groups.
- Scenario ledger: full cycle outcomes with signed semantic values.
- Recovery ladder: separate strategy inputs, table, and compact summary.
- Validation: invalid numeric inputs produce an inline message without breaking the layout.

## Responsive strategy

- 1024–1440px: execution workspace plus side rail.
- 768–1023px: result full-width; settings and limits form a two-column lower deck.
- 320–767px: one-column reading order, two-column compact inputs where labels allow, stacked platform legs, sticky view tabs, horizontally scrollable data tables with an explicit label.
- Mobile result order: inputs → exposure → Bybit leg → FundingPips leg → settings → scenarios.
- All touch targets are at least 44px; no page-level horizontal overflow.

## Accessibility

- One `h1`, logical headings, skip link, native controls, explicit labels, table header scopes.
- Theme button and tabs expose current state; computed results use `aria-live="polite"`.
- Color never acts alone: TP/SL, platform names, directions, and signs remain textual.
- Visible focus and AA-oriented contrast in both themes.

## Forbidden patterns

- Near-black dark theme, neon terminal glow, generic purple gradient.
- Identical platform panels distinguished only by text.
- Color-only P&L meaning, hidden settings, decorative fake market data.
- Nested rounded cards, excessive shadows, chart libraries for simple data.

## QA checklist

- Engine tests cover position sizing, scenarios, account presets, and recovery steps.
- All original controls and outputs have a React equivalent.
- Both themes work and persist; dark theme remains visibly graphite rather than black.
- Bybit/FundingPips and TP/SL are visually and textually distinct.
- Verify 320, 390, 768, 1024, and 1440px without horizontal page overflow.
- Production build succeeds with no external runtime assets.

