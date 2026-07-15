export const formatMoney = (value, maximumFractionDigits = 0) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits,
  }).format(Number(value) || 0);

export const formatSignedMoney = (value, maximumFractionDigits = 0) => {
  const number = Number(value) || 0;
  if (number === 0) return '—';
  return `${number > 0 ? '+' : '−'}${formatMoney(Math.abs(number), maximumFractionDigits)}`;
};

export const formatPrice = (value, decimals = 5) =>
  Number(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: false,
  });

