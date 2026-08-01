export const PHASE_LEDGER_STORAGE_KEY = 'calcpro-phase-ledgers-v1';

export function buildPhaseLedgerKey(accountModel, accountPreset) {
  return `${accountModel || 'standard'}:${accountPreset || '10k'}`;
}

export function readPhaseLedgers(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(PHASE_LEDGER_STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writePhaseLedgers(phaseLedgers, storage = globalThis.localStorage) {
  try {
    storage?.setItem(PHASE_LEDGER_STORAGE_KEY, JSON.stringify(phaseLedgers ?? {}));
  } catch {
    // Журнал продолжает работать в памяти, если браузер запретил localStorage.
  }
}
