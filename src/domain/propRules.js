const MODEL_RULES = Object.freeze({
  standard: Object.freeze({
    label: '2 Step Standard',
    p1Target: 8,
    p2Target: 5,
    dailyLossLimit: 5,
    maxDrawdown: 10,
    defaultProfitSplit: 0.8,
  }),
  flex: Object.freeze({
    label: '2 Step Flex',
    p1Target: 10,
    p2Target: 6,
    dailyLossLimit: 4,
    maxDrawdown: 12,
    defaultProfitSplit: 0.85,
  }),
});

export const PROFIT_SPLIT_OPTIONS = Object.freeze({
  standard: Object.freeze([
    { value: 0.6, label: 'Weekly — 60%' },
    { value: 0.8, label: 'Bi-Weekly — 80%' },
    { value: 0.9, label: 'On Demand — 90%' },
    { value: 1, label: 'Monthly — 100%' },
  ]),
  flex: Object.freeze([
    { value: 0.85, label: 'Bi-Weekly — 85%' },
    { value: 0.95, label: 'Bi-Weekly + 3 дня — 95%' },
  ]),
});

const STAGES = Object.freeze(['p1', 'p2', 'funded']);
const MAX_DAY_COUNT = 4;
const FUNDED_TP_STEP = 100;
const EVALUATION_LOSS_PLANS = Object.freeze({
  standard: Object.freeze([4, 4, 2]),
  flex: Object.freeze([3, 3, 3, 3]),
});
const STANDARD_SCHEME_10K = Object.freeze({
  p1: Object.freeze({
    sl: Object.freeze([50, 50, 25]),
    tp: Object.freeze([-100, -150, -200]),
  }),
  p2: Object.freeze({
    sl: Object.freeze([100, 100, 50]),
    tp: Object.freeze([-130, -230, -330]),
  }),
});
const EMPTY_DAY = Object.freeze({
  outcome: 'none',
  amount: 0,
  bybitOutcome: null,
  bybitAmount: null,
  bybitSource: null,
  bybitStake: null,
  bybitLoss: null,
});

const round = (value, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

const modelRules = (model) => MODEL_RULES[model] ?? MODEL_RULES.standard;

export function getSchemeBybitPnl({
  accountModel = 'standard',
  accountSize = 10_000,
  stage = 'p1',
  day = 1,
  outcome = 'none',
} = {}) {
  const path = accountModel === 'standard' ? STANDARD_SCHEME_10K[stage] : null;
  const dayIndex = Number(day) - 1;
  const basePnl = path?.[outcome]?.[dayIndex];
  if (!Number.isFinite(basePnl)) return null;
  return round(basePnl * Math.max(0, Number(accountSize) || 0) / 10_000);
}

const normalizeDay = (entry) => {
  const outcome = ['sl', 'tp'].includes(entry?.outcome) ? entry.outcome : 'none';
  const amount = Math.max(0, Number(entry?.amount) || 0);
  const bybitOutcome = ['tp', 'sl', 'none'].includes(entry?.bybitOutcome)
    ? entry.bybitOutcome
    : null;
  const bybitSource = ['manual', 'reference', 'position'].includes(entry?.bybitSource)
    ? entry.bybitSource
    : null;
  const rawBybitAmount = Number(entry?.bybitAmount);
  const bybitAmount = entry?.bybitAmount !== null && entry?.bybitAmount !== undefined &&
    Number.isFinite(rawBybitAmount)
    ? round(Math.max(0, rawBybitAmount))
    : null;
  const rawBybitStake = Number(entry?.bybitStake);
  const bybitStake = entry?.bybitStake !== null && entry?.bybitStake !== undefined &&
    Number.isFinite(rawBybitStake)
    ? round(Math.max(0, rawBybitStake))
    : null;
  const rawBybitLoss = Number(entry?.bybitLoss);
  const bybitLoss = entry?.bybitLoss !== null && entry?.bybitLoss !== undefined &&
    Number.isFinite(rawBybitLoss)
    ? round(Math.max(0, rawBybitLoss))
    : null;
  return {
    outcome,
    amount: round(amount),
    bybitOutcome,
    bybitAmount,
    bybitSource,
    bybitStake,
    bybitLoss,
  };
};

export function getPropModelPreset(accountModel = 'standard') {
  const model = MODEL_RULES[accountModel] ? accountModel : 'standard';
  const rules = modelRules(model);
  return {
    accountModel: model,
    p1Target: rules.p1Target,
    p2Target: rules.p2Target,
    dailyLossLimit: rules.dailyLossLimit,
    maxDrawdown: rules.maxDrawdown,
    profitSplit: rules.defaultProfitSplit,
  };
}

export function getPropRules({
  accountModel = 'standard',
  accountSize = 10_000,
  stage = 'p1',
  profitSplit,
  fundedPayout = 8,
} = {}) {
  const model = MODEL_RULES[accountModel] ? accountModel : 'standard';
  const rules = modelRules(model);
  const size = Math.max(0, Number(accountSize) || 0);
  const normalizedStage = STAGES.includes(stage) ? stage : 'p1';
  const split = Number(profitSplit) || rules.defaultProfitSplit;
  const targetPct = normalizedStage === 'p1'
    ? rules.p1Target
    : normalizedStage === 'p2'
      ? rules.p2Target
      : Math.max(0, Number(fundedPayout) || 0);
  const evaluation = normalizedStage !== 'funded';
  const lossPlanPct = evaluation
    ? [...EVALUATION_LOSS_PLANS[model]]
    : Array.from({ length: 3 }, () => rules.dailyLossLimit);
  const concentrationThreshold = evaluation && size >= 25_000
    ? round(size * targetPct * 0.006)
    : null;
  const tradeIdeaLimitPct = model === 'flex' && normalizedStage === 'funded'
    ? size === 25_000
      ? 3
      : size > 25_000
        ? 2
        : null
    : null;

  return {
    accountModel: model,
    modelLabel: rules.label,
    accountSize: size,
    stage: normalizedStage,
    evaluation,
    targetPct,
    targetAmount: round(size * targetPct / 100),
    dailyLossPct: rules.dailyLossLimit,
    dailyLossAmount: round(size * rules.dailyLossLimit / 100),
    maxLossPct: rules.maxDrawdown,
    maxLossAmount: round(size * rules.maxDrawdown / 100),
    concentrationThreshold,
    tradeIdeaLimitPct,
    tradeIdeaLimitAmount: tradeIdeaLimitPct === null
      ? null
      : round(size * tradeIdeaLimitPct / 100),
    requiredTradingDays: evaluation && model === 'standard' ? 3 : 0,
    requiredProfitableDays: model === 'flex' && split === 0.95 ? 3 : 0,
    profitableDayAmount: round(size * 0.005),
    lossPlanPct,
    dayCount: lossPlanPct.length,
  };
}

export function createEmptyPhaseLedger() {
  return Object.fromEntries(STAGES.map((stage) => [
    stage,
    Array.from({ length: MAX_DAY_COUNT }, () => ({ ...EMPTY_DAY })),
  ]));
}

export function updatePhaseLedger(ledger, stage, day, entry) {
  if (!STAGES.includes(stage)) return ledger;
  const dayIndex = Number(day) - 1;
  if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= MAX_DAY_COUNT) return ledger;

  const next = {
    ...createEmptyPhaseLedger(),
    ...(ledger ?? {}),
  };
  const stageDays = Array.from({ length: MAX_DAY_COUNT }, (_, index) => (
    normalizeDay(next[stage]?.[index])
  ));
  stageDays[dayIndex] = normalizeDay(entry);
  return { ...next, [stage]: stageDays };
}

export function calculatePhaseCheckpoint({
  accountModel = 'standard',
  accountSize = 10_000,
  stage = 'p1',
  selectedDay = 1,
  ledger = createEmptyPhaseLedger(),
  profitSplit,
  fundedPayout = 8,
  bybitStake = 0,
  bybitLoss = 0,
  challengeCost = 0,
  purchaseDiscountPct = 0,
} = {}) {
  const rules = getPropRules({
    accountModel,
    accountSize,
    stage,
    profitSplit,
    fundedPayout,
  });
  const size = Math.max(0, Number(accountSize) || 0);
  const day = Math.min(rules.dayCount, Math.max(1, Number(selectedDay) || 1));
  const entries = Array.from({ length: rules.dayCount }, (_, index) => (
    normalizeDay(ledger?.[rules.stage]?.[index])
  ));
  const signedPnl = (entry) => (
    entry.outcome === 'sl' ? -entry.amount : entry.outcome === 'tp' ? entry.amount : 0
  );
  const included = entries.slice(0, day);
  const previousPnl = entries.slice(0, day - 1).reduce(
    (total, entry) => total + signedPnl(entry),
    0,
  );
  const realizedPnl = included.reduce((total, entry) => total + signedPnl(entry), 0);
  const selectedEntry = entries[day - 1];
  const dayOpeningBalance = size + previousPnl;
  const officialSelectedDayLossLimit = Math.max(
    0,
    dayOpeningBalance * rules.dailyLossPct / 100,
  );
  const remainingLossRoomBeforeDay = Math.max(0, rules.maxLossAmount + previousPnl);
  const plannedLossPct = rules.lossPlanPct[day - 1] ?? rules.dailyLossPct;
  const plannedLossAmount = Math.max(0, size * plannedLossPct / 100);
  const selectedDayLossLimit = Math.min(plannedLossAmount, remainingLossRoomBeforeDay);
  const recommendedTpAmount = Math.max(0, rules.targetAmount - previousPnl);
  const dailyBreach = selectedEntry.outcome === 'sl' &&
    selectedEntry.amount >= officialSelectedDayLossLimit;
  const maxLossBreach = realizedPnl <= -rules.maxLossAmount;
  const tradingDays = included.filter((entry) => entry.outcome !== 'none' && entry.amount > 0).length;
  const profitableDays = included.filter((entry) => (
    entry.outcome === 'tp' && entry.amount >= rules.profitableDayAmount
  )).length;
  const targetReached = realizedPnl >= rules.targetAmount;
  const dayRequirementMet = tradingDays >= rules.requiredTradingDays &&
    profitableDays >= rules.requiredProfitableDays;
  const concentrationTriggered = rules.concentrationThreshold !== null && included.some((entry) => (
    entry.outcome === 'tp' && entry.amount > rules.concentrationThreshold
  ));
  const recommendedTpTriggersConcentration = rules.concentrationThreshold !== null &&
    recommendedTpAmount > rules.concentrationThreshold;
  const mirroredStake = Math.max(0, Number(bybitStake) || 0);
  const mirroredLoss = Math.max(0, Number(bybitLoss) || mirroredStake);
  const buildMirroredDay = (entry, index, mirroredStage = rules.stage) => {
    if (entry.outcome === 'none' || entry.amount <= 0) return null;
    const fpPnl = signedPnl(entry);
    const fpLost = entry.outcome === 'sl';
    const dayStake = entry.bybitStake ?? mirroredStake;
    const dayLoss = entry.bybitLoss ?? (
      mirroredStake > 0 ? dayStake * mirroredLoss / mirroredStake : mirroredLoss
    );
    const actualBybitAmount = entry.bybitAmount;
    const schemePnl = getSchemeBybitPnl({
      accountModel: rules.accountModel,
      accountSize: size,
      stage: mirroredStage,
      day: index + 1,
      outcome: entry.outcome,
    });
    const manualBybitOutcome = ['tp', 'sl', 'none'].includes(entry.bybitOutcome)
      ? entry.bybitOutcome
      : null;
    let bybitOutcome;
    let bybitPnl;
    let bybitSource;

    if (manualBybitOutcome !== null) {
      bybitOutcome = manualBybitOutcome;
      bybitPnl = manualBybitOutcome === 'tp'
        ? actualBybitAmount ?? 0
        : manualBybitOutcome === 'sl'
          ? -(actualBybitAmount ?? 0)
          : 0;
      bybitSource = entry.bybitSource ?? 'manual';
    } else if (schemePnl !== null) {
      bybitOutcome = schemePnl >= 0 ? 'tp' : 'sl';
      bybitPnl = schemePnl;
      bybitSource = 'reference';
    } else {
      bybitOutcome = fpLost ? 'tp' : 'sl';
      bybitPnl = fpLost
        ? actualBybitAmount ?? dayStake
        : -(actualBybitAmount ?? dayLoss);
      bybitSource = 'position';
    }

    return {
      day: index + 1,
      outcome: entry.outcome,
      fpPnl: round(fpPnl),
      bybitOutcome,
      bybitPnl: round(bybitPnl),
      bybitSource,
    };
  };
  const recordedDays = entries.flatMap((entry, index) => {
    const record = buildMirroredDay(entry, index);
    return record ? [record] : [];
  });
  const accountedStages = STAGES.slice(0, STAGES.indexOf(rules.stage) + 1);
  const getStageEntries = (accountedStage) => {
    const accountedRules = getPropRules({
      accountModel: rules.accountModel,
      accountSize: size,
      stage: accountedStage,
      profitSplit,
      fundedPayout,
    });
    return Array.from({ length: accountedRules.dayCount }, (_, index) => (
      normalizeDay(ledger?.[accountedStage]?.[index])
    ));
  };
  const sumStageBybit = (accountedStage, stageEntries) => (
    stageEntries.reduce((stageTotal, entry, index) => (
      stageTotal + (buildMirroredDay(entry, index, accountedStage)?.bybitPnl ?? 0)
    ), 0)
  );
  const bybitPnl = accountedStages.reduce((total, accountedStage) => {
    return total + sumStageBybit(accountedStage, getStageEntries(accountedStage));
  }, 0);
  const bybitPnlBeforeSelectedDay = accountedStages.reduce((total, accountedStage) => {
    const stageEntries = getStageEntries(accountedStage);
    const includedEntries = accountedStage === rules.stage
      ? stageEntries.slice(0, day - 1)
      : stageEntries;
    return total + sumStageBybit(accountedStage, includedEntries);
  }, 0);
  const propBaseCost = round(Math.max(0, Number(challengeCost) || 0));
  const normalizedPurchaseDiscountPct = round(Math.min(
    100,
    Math.max(0, Number(purchaseDiscountPct) || 0),
  ));
  const propCost = round(propBaseCost * (1 - normalizedPurchaseDiscountPct / 100));
  const normalizedProfitSplit = Math.max(
    0,
    Number(profitSplit) || modelRules(rules.accountModel).defaultProfitSplit,
  );
  const rewardGross = rules.stage === 'funded' ? Math.max(0, realizedPnl) : 0;
  const rewardAfterSplit = round(rewardGross * normalizedProfitSplit);
  const referenceBybitTpPnl = getSchemeBybitPnl({
    accountModel: rules.accountModel,
    accountSize: size,
    stage: rules.stage,
    day,
    outcome: 'tp',
  });
  const projectedBybitLoss = round(Math.abs(
    referenceBybitTpPnl ?? mirroredLoss,
  ));
  const farmBreakEvenTpAmount = rules.stage === 'funded' && normalizedProfitSplit > 0
    ? round(Math.max(
      0,
      (propCost - bybitPnlBeforeSelectedDay + projectedBybitLoss) /
        normalizedProfitSplit - previousPnl,
    ))
    : null;
  const rawRecommendedFarmTpAmount = Math.max(
    recommendedTpAmount,
    farmBreakEvenTpAmount ?? 0,
  );
  const recommendedFarmTpAmount = rules.stage === 'funded'
    ? round(Math.ceil(rawRecommendedFarmTpAmount / FUNDED_TP_STEP) * FUNDED_TP_STEP)
    : round(recommendedTpAmount);
  const projectedRewardAfterSplit = rules.stage === 'funded'
    ? Math.max(0, previousPnl + recommendedFarmTpAmount) * normalizedProfitSplit
    : 0;
  const projectedFarmNetAtRecommendedTp = rules.stage === 'funded'
    ? round(
      projectedRewardAfterSplit + bybitPnlBeforeSelectedDay -
        projectedBybitLoss - propCost,
    )
    : null;
  const netCashResult = round(bybitPnl + rewardAfterSplit - propCost);

  let status = 'tracking';
  if (dailyBreach || maxLossBreach) status = 'breached';
  else if (targetReached && dayRequirementMet) status = 'passed';
  else if (targetReached) status = 'target_reached_days_pending';
  return {
    ...rules,
    selectedDay: day,
    entries,
    selectedEntry,
    dayOpeningBalance: round(dayOpeningBalance),
    selectedDayLossLimit: round(selectedDayLossLimit),
    officialSelectedDayLossLimit: round(officialSelectedDayLossLimit),
    remainingLossRoomBeforeDay: round(remainingLossRoomBeforeDay),
    plannedLossPct,
    plannedLossAmount: round(plannedLossAmount),
    recommendedTpAmount: round(recommendedTpAmount),
    recommendedTpTriggersConcentration,
    realizedPnl: round(realizedPnl),
    currentBalance: round(size + realizedPnl),
    remainingToTarget: round(Math.max(0, rules.targetAmount - realizedPnl)),
    remainingLossRoom: round(Math.max(0, rules.maxLossAmount + realizedPnl)),
    tradingDays,
    profitableDays,
    targetReached,
    dayRequirementMet,
    dailyBreach,
    maxLossBreach,
    concentrationTriggered,
    recordedDays,
    bybitPnl: round(bybitPnl),
    bybitPnlBeforeSelectedDay: round(bybitPnlBeforeSelectedDay),
    propBaseCost,
    purchaseDiscountPct: normalizedPurchaseDiscountPct,
    propCost,
    profitSplit: normalizedProfitSplit,
    rewardGross: round(rewardGross),
    rewardAfterSplit,
    projectedBybitLoss,
    farmBreakEvenTpAmount,
    recommendedFarmTpAmount,
    projectedFarmNetAtRecommendedTp,
    netCashResult,
    status,
  };
}
