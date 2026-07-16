export function createActivePositionReconciler({
  database,
  infoClient,
  now = Date.now,
  logger = () => {},
  maxWallets = 250,
} = {}) {
  if (
    !database?.listActiveWalletAddresses ||
    !database?.recordGoldPosition ||
    !infoClient?.fetchGoldPosition ||
    typeof now !== 'function' ||
    typeof logger !== 'function' ||
    !Number.isInteger(maxWallets) ||
    maxWallets < 1 ||
    maxWallets > 1_000
  ) {
    throw new Error('Active position reconciler dependencies are invalid.');
  }

  let running = false;

  return {
    async runOnce() {
      if (running) return { reviewed: 0, updated: 0, failed: 0, skipped: true };
      running = true;
      const result = { reviewed: 0, updated: 0, failed: 0 };
      const at = now();
      try {
        const addresses = database.listActiveWalletAddresses({ limit: maxWallets });
        for (const address of addresses) {
          result.reviewed += 1;
          try {
            const position = await infoClient.fetchGoldPosition(address);
            database.recordGoldPosition(address, position, { at });
            result.updated += 1;
          } catch (error) {
            result.failed += 1;
            logger({
              event: 'active_position_reconciliation_failed',
              errorType: error?.name ?? 'Error',
              timestamp: at,
            });
          }
        }
        return result;
      } finally {
        running = false;
      }
    },
  };
}
