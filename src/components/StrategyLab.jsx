import React from 'react';

import { formatMoney, formatSignedMoney } from '../format.js';

const STRATEGY_TRADEOFFS = {
  balanced: ['+ Ровное покрытие', '− Не максимальный резерв'],
  'bybit-first': ['+ Защита при сливе FP', '− Выше нагрузка Bybit'],
  'funded-first': ['+ Ниже Funded-хедж', '− Меньше компенсация'],
  'legacy-original': ['+ Сильнее P2 / Funded', '− Funded payout 5%'],
};

function StakeStrip({ stakes }) {
  return (
    <dl className="strategy-stakes">
      <div><dt>P1</dt><dd>{formatMoney(stakes.bybitP1, 1)}</dd></div>
      <div><dt>P2</dt><dd>{formatMoney(stakes.bybitP2, 1)}</dd></div>
      <div><dt>Funded</dt><dd>{formatMoney(stakes.bybitFunded, 1)}</dd></div>
    </dl>
  );
}

function Tradeoffs({ strategyId }) {
  const items = STRATEGY_TRADEOFFS[strategyId] ?? [
    '+ Под текущую цель',
    '− Ручной профиль',
  ];
  return (
    <span className="strategy-tradeoffs">
      {items.map((item) => <em key={item}>{item}</em>)}
    </span>
  );
}

export default function StrategyLab({
  goals,
  selectedGoal,
  onGoalChange,
  recommendation,
  presets,
  activeStrategyId,
  onOptimize,
  onApply,
}) {
  const activeGoal = goals.find(({ id }) => id === selectedGoal) ?? goals[0];

  return (
    <section className="strategy-lab" aria-labelledby="strategy-title">
      <header className="section-head strategy-lab__head">
        <div>
          <span className="section-code">03 / Strategy optimizer</span>
          <h2 id="strategy-title">Подбор и сравнение стратегий</h2>
        </div>
        <span className="micro-copy">Fee-free model / local</span>
      </header>

      <div className="strategy-lab__layout">
        <section className="optimizer-card" aria-labelledby="optimizer-title">
          <span className="section-code">Objective function</span>
          <h3 id="optimizer-title">Оптимизатор стратегии</h3>

          <label className="optimizer-select" htmlFor="strategy-goal">
            <span>Цель подбора</span>
            <select
              id="strategy-goal"
              value={selectedGoal}
              onChange={(event) => onGoalChange(event.target.value)}
            >
              {goals.map((goal) => (
                <option key={goal.id} value={goal.id}>{goal.label}</option>
              ))}
            </select>
          </label>

          <p className="optimizer-description">{activeGoal.description}</p>
          <button className="primary-action" type="button" onClick={onOptimize}>
            Подобрать параметры
          </button>

          {recommendation?.status === 'ready' ? (
            <div className="optimizer-result" aria-live="polite">
              <span className="optimizer-result__status">Рекомендация готова</span>
              <h4>{recommendation.label}</h4>
              <StakeStrip stakes={recommendation.stakes} />
              <dl className="optimizer-metrics">
                <div>
                  <dt>Безубыток</dt>
                  <dd>{recommendation.safeBreakEvenPct.toFixed(2)}%</dd>
                </div>
                <div>
                  <dt>Худший слив FP</dt>
                  <dd className={recommendation.failureFloor >= 0 ? 'positive' : 'negative'}>
                    {formatSignedMoney(recommendation.failureFloor, 2)}
                  </dd>
                </div>
              </dl>
              <p>{recommendation.description}</p>
              <button
                className="secondary-action"
                type="button"
                onClick={() => onApply(recommendation)}
              >
                Применить параметры
              </button>
            </div>
          ) : (
            <p className="optimizer-empty" aria-live="polite">
              Выберите приоритет — движок пересчитает ставки по текущему аккаунту, риску и лимитам.
            </p>
          )}
        </section>

        <section className="comparison-card" aria-labelledby="comparison-title">
          <div className="comparison-card__head">
            <div>
              <span className="section-code">Prepared profiles</span>
              <h3 id="comparison-title">Сравнение стратегий</h3>
            </div>
            <span>Аккаунт/риск текущие · payout профиля</span>
          </div>

          <div className="table-scroll" tabIndex="0" aria-label="Сравнение готовых стратегий">
            <table className="strategy-table">
              <thead>
                <tr>
                  <th scope="col">Стратегия</th>
                  <th scope="col">P1</th>
                  <th scope="col">P2</th>
                  <th scope="col">Funded</th>
                  <th scope="col">Payout</th>
                  <th scope="col">БУ</th>
                  <th scope="col">Слив P1</th>
                  <th scope="col">Слив P2</th>
                  <th scope="col">Слив Funded</th>
                  <th scope="col"><span className="visually-hidden">Действие</span></th>
                </tr>
              </thead>
              <tbody>
                {presets.map((strategy) => (
                  <tr
                    className={strategy.id === activeStrategyId ? 'is-active' : ''}
                    key={strategy.id}
                  >
                    <th scope="row">
                      <strong>{strategy.label}</strong>
                      <small>{strategy.description}</small>
                      <Tradeoffs strategyId={strategy.id} />
                    </th>
                    <td>{formatMoney(strategy.stakes.bybitP1, 1)}</td>
                    <td>{formatMoney(strategy.stakes.bybitP2, 1)}</td>
                    <td>{formatMoney(strategy.stakes.bybitFunded, 1)}</td>
                    <td>{strategy.fundedPayout.toFixed(0)}%</td>
                    <td>{strategy.safeBreakEvenPct?.toFixed(2) ?? '—'}%</td>
                    <td className={strategy.phaseOneFailure >= 0 ? 'positive' : 'negative'}>
                      {formatSignedMoney(strategy.phaseOneFailure, 2)}
                    </td>
                    <td className={strategy.phaseTwoFailure >= 0 ? 'positive' : 'negative'}>
                      {formatSignedMoney(strategy.phaseTwoFailure, 2)}
                    </td>
                    <td className={strategy.fundedFailure >= 0 ? 'positive' : 'negative'}>
                      {formatSignedMoney(strategy.fundedFailure, 2)}
                    </td>
                    <td>
                      <button
                        className="table-action"
                        type="button"
                        onClick={() => onApply(strategy)}
                        aria-label={`Применить стратегию ${strategy.label}`}
                        aria-pressed={strategy.id === activeStrategyId}
                      >
                        {strategy.id === activeStrategyId ? 'Активна' : 'Применить'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="strategy-cards" aria-label="Готовые стратегии">
            {presets.map((strategy) => (
              <article
                className={`strategy-card ${strategy.id === activeStrategyId ? 'is-active' : ''}`}
                key={strategy.id}
              >
                <header>
                  <div>
                    <span>{strategy.id === activeStrategyId ? 'ACTIVE PROFILE' : 'PRESET'}</span>
                    <h4>{strategy.label}</h4>
                  </div>
                  <strong>{strategy.safeBreakEvenPct?.toFixed(2) ?? '—'}% БУ</strong>
                </header>
                <p>{strategy.description}</p>
                <Tradeoffs strategyId={strategy.id} />
                <dl>
                  <div><dt>P1</dt><dd>{formatMoney(strategy.stakes.bybitP1, 1)}</dd></div>
                  <div><dt>P2</dt><dd>{formatMoney(strategy.stakes.bybitP2, 1)}</dd></div>
                  <div><dt>Funded</dt><dd>{formatMoney(strategy.stakes.bybitFunded, 1)}</dd></div>
                  <div><dt>Payout</dt><dd>{strategy.fundedPayout.toFixed(0)}%</dd></div>
                </dl>
                <footer>
                  <span>
                    Слив P2
                    <b className={strategy.phaseTwoFailure >= 0 ? 'positive' : 'negative'}>
                      {formatSignedMoney(strategy.phaseTwoFailure, 2)}
                    </b>
                  </span>
                  <span>
                    Слив Funded
                    <b className={strategy.fundedFailure >= 0 ? 'positive' : 'negative'}>
                      {formatSignedMoney(strategy.fundedFailure, 2)}
                    </b>
                  </span>
                </footer>
                <button
                  className="table-action"
                  type="button"
                  onClick={() => onApply(strategy)}
                  aria-pressed={strategy.id === activeStrategyId}
                >
                  {strategy.id === activeStrategyId ? 'Профиль активен' : 'Применить профиль'}
                </button>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}
