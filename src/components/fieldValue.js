export function normalizeFieldValue(rawValue, { options, type = 'number' } = {}) {
  if (options) {
    const selectedOption = options.find((option) => String(option.value) === rawValue);
    return selectedOption ? selectedOption.value : rawValue;
  }

  if (type === 'number') {
    return rawValue === '' ? '' : Number(rawValue);
  }

  return rawValue;
}
