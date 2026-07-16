import { calculateScenarios, getAccountSettings } from './calculator.js';

const MONEY_STEP = 0.5;

const PRESET_META = Object.freeze({
  balanced: {
    label: 'Сбалансированная',
    description: 'Базовый запас по каждому этапу без перекоса в одну из сторон.',
  },
  'bybit-first': {
    label: 'Bybit-first',
    description: 'Повышенная компенсация, если аккаунт FP не проходит этап.',
  },
  'funded-first': {
    label: 'Funded-first',
    description: 'Меньше нагрузка на хедж и ниже требуемая цель Funded.',
  },
});

export const STRATEGY_GOALS = Object.freeze([
  {
    id: 'minimum-load',
    label: 'Минимальная нагрузка на Bybit',
    description: 'Минимальные ставки, при которых каждый сценарий слива FP остаётся неотрицательным.',
  },
  {
    id: 'fast-break-even',
    label: 'Быстрый выход в безубыток',
    description: 'Минимальная цель Funded при сохранении полного покрытия трёх сценариев слива.',
  },
  {
    id: 'max-fp-failure-profit',
    label: 'Максимум при сливе FP',
    description: 'Максимальные ставки в пределах профиля Bybit-first для большего запаса при провале FP.',
  },
  {
    id: 'minimum-funded-tp',
    label: 'Минимальный Funded TP',
    description: 'Сохраняет ставки P1/P2 и уменьшает Funded-хедж до границы полного покрытия.',
  },
  {
    id: 'balanced',
    label: 'Сбалансированный режим',
    description: 'Рекомендованный базовый профиль для выбранного аккаунта и риска.',
  },
]);

const round = (value, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

const isPositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

const roundStakeUp = (value) =>
  round(Math.ceil((Number(value) - Number.EPSILON) / MONEY_STEP) * MONEY_STEP);

const roundStake = (value) =>
  round(Math.round(Number(value) / MONEY_STEP) * MONEY_STEP);

const safePercentage = (value) =>
  Math.ceil((Number(value) - Number.EPSILON) * 100) / 100;

function validateEconomics(input) {
  const required = [
    'accountSize',
    'challengeCost',
    'p1Target',
    'p2Target',
    'maxDrawdown',
    'riskPerTrade',
    'profitSplit',
    'fundedRisk',
    'fundedPayout',
    'bybitP1',
    'bybitP2',
    'bybitFunded',
  ];

  return required.every((field) => isPositive(input[field]));
}

export function calculateBreakEven(input) {
  if (!validateEconomics(input)) {
    return {
      status: 'invalid',
      message: 'Для расчёта безубытка все параметры цикла должны быть больше нуля.',
      breakEvenPct: null,
      safeBreakEvenPct: null,
      marginPct: null,
    };
  }

  const p1Units = Number(input.p1Target) / Number(input.riskPerTrade);
  const p2Units = Number(input.p2Target) / Number(input.riskPerTrade);
  const fixedCosts =
    Number(input.challengeCost) +
    p1Units * Number(input.bybitP1) +
    p2Units * Number(input.bybitP2);
  const payoutPerPct =
    (Number(input.accountSize) * Number(input.profitSplit)) / 100;
  const fundedHedgePerPct = Number(input.bybitFunded) / Number(input.fundedRisk);
  const netPerPct = payoutPerPct - fundedHedgePerPct;
  const currentTargetPct = Number(input.fundedPayout);
  const projectedTotal = calculateScenarios(input).at(-1)?.total ?? null;

  if (netPerPct <= 0) {
    return {
      status: 'unreachable',
      message: 'Ставка Funded на Bybit поглощает всю выплату FP. Уменьшите ставку Funded или увеличьте Profit Split.',
      fixedCosts: round(fixedCosts),
      payoutPerPct: round(payoutPerPct),
      fundedHedgePerPct: round(fundedHedgePerPct),
      netPerPct: round(netPerPct),
      currentTargetPct,
      projectedTotal,
      breakEvenPct: null,
      safeBreakEvenPct: null,
      marginPct: null,
    };
  }

  const exactBreakEven = fixedCosts / netPerPct;
  const safeBreakEvenPct = safePercentage(exactBreakEven);

  return {
    status: 'ready',
    message: 'Без учёта комиссий и спреда, по текущим параметрам.',
    fixedCosts: round(fixedCosts),
    payoutPerPct: round(payoutPerPct),
    fundedHedgePerPct: round(fundedHedgePerPct),
    netPerPct: round(netPerPct),
    breakEvenPct: round(exactBreakEven, 4),
    safeBreakEvenPct,
    currentTargetPct,
    marginPct: round(currentTargetPct - safeBreakEvenPct),
    projectedTotal,
  };
}

function buildStrategy(input, id, stakes, meta = PRESET_META[id]) {
  const nextInput = { ...input, ...stakes };
  const economics = calculateBreakEven(nextInput);
  const failureScenarios = calculateScenarios(nextInput).slice(0, 3);

  return {
    id,
    label: meta?.label ?? id,
    description: meta?.description ?? '',
    status: economics.status,
    stakes,
    safeBreakEvenPct: economics.safeBreakEvenPct,
    breakEvenPct: economics.breakEvenPct,
    phaseOneFailure: failureScenarios[0]?.total ?? null,
    failureFloor: failureScenarios.length
      ? Math.min(...failureScenarios.map(({ total }) => total))
      : null,
    economics,
  };
}

function getBalancedStakes(input) {
  const preset = getAccountSettings(
    input.accountPreset,
    input.riskPerTrade,
    input.fundedRisk,
  );

  return {
    bybitP1: preset.bybitP1,
    bybitP2: preset.bybitP2,
    bybitFunded: preset.bybitFunded,
  };
}

export function buildStrategyPresets(input) {
  const balanced = getBalancedStakes(input);
  const bybitFirst = {
    bybitP1: roundStake(balanced.bybitP1 * 1.4),
    bybitP2: roundStake(balanced.bybitP2 * (4 / 3)),
    bybitFunded: roundStake(balanced.bybitFunded * (11 / 9)),
  };
  const fundedFirst = {
    bybitP1: roundStake(balanced.bybitP1 * 0.8),
    bybitP2: roundStake(balanced.bybitP2 * (7 / 9)),
    bybitFunded: roundStake(balanced.bybitFunded * (7 / 9)),
  };

  return [
    buildStrategy(input, 'balanced', balanced),
    buildStrategy(input, 'bybit-first', bybitFirst),
    buildStrategy(input, 'funded-first', fundedFirst),
  ];
}

function buildMinimumLosslessStakes(input) {
  const challengeCost = Number(input.challengeCost);
  const phaseLossUnits = Number(input.maxDrawdown) / Number(input.riskPerTrade);
  const fundedLossUnits = Number(input.maxDrawdown) / Number(input.fundedRisk);
  const p1Units = Number(input.p1Target) / Number(input.riskPerTrade);
  const p2Units = Number(input.p2Target) / Number(input.riskPerTrade);

  const bybitP1 = roundStakeUp(challengeCost / phaseLossUnits);
  const p1Expenses = p1Units * bybitP1;
  const bybitP2 = roundStakeUp((challengeCost + p1Expenses) / phaseLossUnits);
  const p2Expenses = p2Units * bybitP2;
  const bybitFunded = roundStakeUp(
    (challengeCost + p1Expenses + p2Expenses) / fundedLossUnits,
  );

  return { bybitP1, bybitP2, bybitFunded };
}

function buildMinimumFundedStake(input) {
  const balanced = getBalancedStakes(input);
  const p1Units = Number(input.p1Target) / Number(input.riskPerTrade);
  const p2Units = Number(input.p2Target) / Number(input.riskPerTrade);
  const fundedLossUnits = Number(input.maxDrawdown) / Number(input.fundedRisk);
  const previousCosts =
    Number(input.challengeCost) +
    p1Units * balanced.bybitP1 +
    p2Units * balanced.bybitP2;

  return {
    ...balanced,
    bybitFunded: roundStakeUp(previousCosts / fundedLossUnits),
  };
}

export function optimizeStrategy(input, goalId) {
  const goal = STRATEGY_GOALS.find(({ id }) => id === goalId);

  if (!goal || !validateEconomics(input)) {
    return {
      status: 'invalid',
      message: goal
        ? 'Проверьте параметры цикла перед подбором стратегии.'
        : 'Неизвестная цель оптимизации.',
    };
  }

  let stakes;

  switch (goalId) {
    case 'minimum-load':
    case 'fast-break-even':
      stakes = buildMinimumLosslessStakes(input);
      break;
    case 'max-fp-failure-profit':
      stakes = buildStrategyPresets(input).find(({ id }) => id === 'bybit-first').stakes;
      break;
    case 'minimum-funded-tp':
      stakes = buildMinimumFundedStake(input);
      break;
    case 'balanced':
      stakes = getBalancedStakes(input);
      break;
    default:
      return { status: 'invalid', message: 'Неизвестная цель оптимизации.' };
  }

  const result = buildStrategy(input, goalId, stakes, goal);

  if (goalId === 'fast-break-even') {
    result.description += ' В модели без комиссий этот результат совпадает с минимальной нагрузкой.';
  }

  return result;
}
