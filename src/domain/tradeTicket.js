const formatPrice = (value, decimals) =>
  Number(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: false,
  });

function formatLeg(name, leg, decimals) {
  return [
    `${name} · ${leg.direction}`,
    `Lots: ${Number(leg.lots).toFixed(2)}`,
    `TP: ${formatPrice(leg.takeProfit, decimals)}`,
    `SL: ${formatPrice(leg.stopLoss, decimals)}`,
  ];
}

export function buildTradeTicket(result, instrument) {
  if (result?.status !== 'ready') return '';

  return [
    `CalcPro · ${instrument} · ${result.stage}`,
    '',
    ...formatLeg('BYBIT', result.bybit, result.decimals),
    '',
    ...formatLeg('FUNDINGPIPS', result.fundingPips, result.decimals),
  ].join('\n');
}
