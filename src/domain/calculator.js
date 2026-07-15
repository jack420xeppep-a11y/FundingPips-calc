export const ACCOUNTS = Object.freeze({
  '10k': { size: 10000, challenge: 66, p1: 25, p2: 45, funded: 45 },
  '25k': { size: 25000, challenge: 156, p1: 63, p2: 113, funded: 113 },
  '50k': { size: 50000, challenge: 289, p1: 125, p2: 225, funded: 225 },
  '100k': { size: 100000, challenge: 529, p1: 250, p2: 450, funded: 450 },
});

export const INSTRUMENTS = Object.freeze({
  EURUSD: { contract: 100000, defaultPrice: 1.1559, step: 0.00001, decimals: 5 },
  GBPUSD: { contract: 100000, defaultPrice: 1.333, step: 0.00001, decimals: 5 },
  XAUUSD: { contract: 100, defaultPrice: 2900, step: 0.01, decimals: 2 },
});

const round = (value, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

const isPositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

export function getAccountSettings(preset, riskPerTrade = 2, fundedRisk = 1) {
  const account = ACCOUNTS[preset] ?? ACCOUNTS['10k'];
  const challengeRiskScale = Number(riskPerTrade) / 2;
  const fundedRiskScale = Number(fundedRisk);

  return {
    accountSize: account.size,
    challengeCost: account.challenge,
    bybitP1: round(account.p1 * challengeRiskScale),
    bybitP2: round(account.p2 * challengeRiskScale),
    bybitFunded: round(account.funded * fundedRiskScale),
  };
}

export function calculatePosition(input) {
  const instrument = INSTRUMENTS[input.instrument];
  const entryPrice = Number(input.entryPrice);
  const slPct = Number(input.slPct);
  const rrRatio = Number(input.rrRatio);

  if (!instrument || !isPositive(entryPrice)) {
    return { status: 'invalid', message: 'Укажите корректный инструмент и цену входа.' };
  }
  if (!isPositive(slPct) || !isPositive(rrRatio)) {
    return { status: 'invalid', message: 'SL и соотношение TP/SL должны быть больше нуля.' };
  }

  const stageConfig = {
    p1: {
      label: 'Phase 1',
      bybitStake: Number(input.bybitP1),
      fundingPipsRisk: Number(input.riskPerTrade),
    },
    p2: {
      label: 'Phase 2',
      bybitStake: Number(input.bybitP2),
      fundingPipsRisk: Number(input.riskPerTrade),
    },
    funded: {
      label: 'Funded',
      bybitStake: Number(input.bybitFunded),
      fundingPipsRisk: Number(input.fundedRisk),
    },
  }[input.stage];

  if (!stageConfig || !isPositive(stageConfig.bybitStake) || !isPositive(stageConfig.fundingPipsRisk)) {
    return { status: 'invalid', message: 'Проверьте этап, риск и ставку Bybit.' };
  }

  const accountSize = Number(input.accountSize);
  if (!isPositive(accountSize)) {
    return { status: 'invalid', message: 'Размер FundingPips аккаунта должен быть больше нуля.' };
  }

  const distanceTarget = (entryPrice * slPct) / 100;
  const bybitLots = round(stageConfig.bybitStake / (instrument.contract * distanceTarget));

  if (!isPositive(bybitLots)) {
    return { status: 'invalid', message: 'Расчёт дал нулевой объём. Увеличьте ставку или уменьшите SL.' };
  }

  const stopDistance = stageConfig.bybitStake / (instrument.contract * bybitLots);
  const takeProfitDistance = stopDistance * rrRatio;
  const actualSlPct = round((stopDistance / entryPrice) * 100, 3);
  const fundingPipsLots = round(
    ((accountSize * stageConfig.fundingPipsRisk) / 100) /
      (instrument.contract * stopDistance),
  );

  const fundingPipsIsLong = input.fpDirection !== 'short';
  const fundingPipsStop = fundingPipsIsLong
    ? entryPrice - stopDistance
    : entryPrice + stopDistance;
  const fundingPipsTarget = fundingPipsIsLong
    ? entryPrice + takeProfitDistance
    : entryPrice - takeProfitDistance;
  const price = (value) => round(value, instrument.decimals);

  return {
    status: 'ready',
    stage: stageConfig.label,
    stake: stageConfig.bybitStake,
    actualSlPct,
    requestedSlPct: slPct,
    decimals: instrument.decimals,
    bybit: {
      platform: 'Bybit',
      direction: fundingPipsIsLong ? 'SHORT' : 'LONG',
      lots: bybitLots,
      takeProfit: price(fundingPipsStop),
      stopLoss: price(fundingPipsTarget),
      takeProfitPnl: stageConfig.bybitStake,
      stopLossPnl: round(stageConfig.bybitStake * rrRatio),
    },
    fundingPips: {
      platform: 'FundingPips',
      direction: fundingPipsIsLong ? 'LONG' : 'SHORT',
      lots: fundingPipsLots,
      takeProfit: price(fundingPipsTarget),
      stopLoss: price(fundingPipsStop),
      riskPct: stageConfig.fundingPipsRisk,
    },
  };
}

export function calculateScenarios(input) {
  const riskPerTrade = Number(input.riskPerTrade);
  const fundedRisk = Number(input.fundedRisk);

  if (!isPositive(riskPerTrade) || !isPositive(fundedRisk)) return [];

  const accountSize = Number(input.accountSize);
  const challengeCost = Number(input.challengeCost);
  const p1Units = Number(input.p1Target) / riskPerTrade;
  const p2Units = Number(input.p2Target) / riskPerTrade;
  const failUnits = Number(input.maxDrawdown) / riskPerTrade;
  const fundedPayoutUnits = Number(input.fundedPayout) / fundedRisk;
  const fundedFailUnits = Number(input.maxDrawdown) / fundedRisk;
  const payout =
    (accountSize * Number(input.fundedPayout) * Number(input.profitSplit)) / 100;

  const p1Expenses = p1Units * Number(input.bybitP1);
  const p2Expenses = p2Units * Number(input.bybitP2);
  const fundedExpenses = fundedPayoutUnits * Number(input.bybitFunded);
  const p1Recovery = failUnits * Number(input.bybitP1);
  const p2Recovery = failUnits * Number(input.bybitP2);
  const fundedRecovery = fundedFailUnits * Number(input.bybitFunded);

  return [
    {
      name: 'Слив Phase 1',
      bybitExpenses: 0,
      challengeCost,
      bybitRecovery: p1Recovery,
      fundingPipsPayout: 0,
      total: -challengeCost + p1Recovery,
    },
    {
      name: 'P1 пройдена → слив P2',
      bybitExpenses: p1Expenses,
      challengeCost,
      bybitRecovery: p2Recovery,
      fundingPipsPayout: 0,
      total: -p1Expenses - challengeCost + p2Recovery,
    },
    {
      name: 'P1 + P2 пройдены → слив Funded',
      bybitExpenses: p1Expenses + p2Expenses,
      challengeCost,
      bybitRecovery: fundedRecovery,
      fundingPipsPayout: 0,
      total: -(p1Expenses + p2Expenses) - challengeCost + fundedRecovery,
    },
    {
      name: `Funded: выплата ${Number(input.fundedPayout)}%`,
      bybitExpenses: p1Expenses + p2Expenses + fundedExpenses,
      challengeCost,
      bybitRecovery: 0,
      fundingPipsPayout: payout,
      total: -(p1Expenses + p2Expenses + fundedExpenses) - challengeCost + payout,
    },
  ].map((scenario) => ({
    ...scenario,
    bybitExpenses: round(scenario.bybitExpenses),
    challengeCost: round(scenario.challengeCost),
    bybitRecovery: round(scenario.bybitRecovery),
    fundingPipsPayout: round(scenario.fundingPipsPayout),
    total: round(scenario.total),
  }));
}

export function calculateRecovery(input) {
  const instrument = INSTRUMENTS[input.instrument];
  const entryPrice = Number(input.entryPrice);
  const slPct = Number(input.slPct);
  const rrRatio = Number(input.rrRatio);
  const baseTakeProfit = Number(input.bybitTakeProfit);
  const multiplier = Number(input.multiplier);
  const fpBybitRatio = Number(input.fpBybitRatio);

  if (
    !instrument ||
    !isPositive(entryPrice) ||
    !isPositive(slPct) ||
    !isPositive(rrRatio) ||
    !isPositive(baseTakeProfit) ||
    !isPositive(multiplier) ||
    !isPositive(fpBybitRatio)
  ) {
    return { status: 'invalid', message: 'Проверьте параметры лестницы восстановления.', rows: [] };
  }

  const steps = Math.min(20, Math.max(2, Math.round(Number(input.steps) || 2)));
  const widenFrom = Math.max(0, Math.round(Number(input.widenFrom) || 0));
  const rangeMultiplier = isPositive(input.rangeMultiplier)
    ? Number(input.rangeMultiplier)
    : 1;
  let cumulativeLoss = 0;
  let cumulativeBybitWin = 0;
  const rows = [];

  for (let index = 1; index <= steps; index += 1) {
    const rangeChanged = widenFrom > 0 && index >= widenFrom;
    const currentSlPct = slPct * (rangeChanged ? rangeMultiplier : 1);
    const stopDistance = (entryPrice * currentSlPct) / 100;
    const takeProfitDistance = stopDistance * rrRatio;
    const bybitTarget = round(baseTakeProfit * multiplier ** (index - 1));
    const bybitLots = round(bybitTarget / (instrument.contract * stopDistance));
    const fundingPipsLots = round(bybitLots * fpBybitRatio);
    const fundingPipsWin = round(
      fundingPipsLots * instrument.contract * takeProfitDistance,
    );
    const fundingPipsLoss = round(
      fundingPipsLots * instrument.contract * stopDistance,
    );
    const bybitWin = round(bybitLots * instrument.contract * stopDistance);
    const bybitLoss = round(bybitLots * instrument.contract * takeProfitDistance);

    cumulativeLoss = round(cumulativeLoss + fundingPipsLoss);
    cumulativeBybitWin = round(cumulativeBybitWin + bybitWin);

    rows.push({
      step: index,
      rangeChanged: widenFrom > 0 && index === widenFrom,
      slPct: round(currentSlPct, 3),
      fundingPipsLots,
      bybitLots,
      bybitWin,
      bybitLoss,
      fundingPipsWin,
      fundingPipsLoss,
      cumulativeLoss,
      recovery: round(fundingPipsWin - (cumulativeLoss - fundingPipsLoss)),
    });
  }

  return {
    status: 'ready',
    rows,
    summary: {
      firstLossesCount: Math.min(5, steps),
      firstLosses: round(
        rows.slice(0, 5).reduce((total, row) => total + row.fundingPipsLoss, 0),
      ),
      cumulativeBybitWin,
      baseSlPct: slPct,
      widenedSlPct: widenFrom > 0 ? round(slPct * rangeMultiplier, 3) : null,
      baseTakeProfitPct: round(slPct * rrRatio, 3),
      widenedTakeProfitPct:
        widenFrom > 0 ? round(slPct * rangeMultiplier * rrRatio, 3) : null,
    },
  };
}
