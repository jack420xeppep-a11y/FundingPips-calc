import { useEffect, useRef, useState } from 'react';

import { createGoldIntelligenceFeed } from '../services/goldIntelligence.js';

const OFF_STATE = Object.freeze({
  status: 'off',
  snapshot: null,
  message: '',
});

export default function useGoldIntelligence({
  enabled,
  setup,
  locked,
  onDirection,
}) {
  const [state, setState] = useState(OFF_STATE);
  const directionRef = useRef(onDirection);
  const lockedRef = useRef(locked);

  directionRef.current = onDirection;
  lockedRef.current = locked;
  const setupKey = setup ? JSON.stringify(setup) : '';

  useEffect(() => {
    if (!enabled || !setup) {
      setState(OFF_STATE);
      return undefined;
    }

    const feed = createGoldIntelligenceFeed({
      setup,
      onSnapshot(snapshot) {
        setState({ status: snapshot.status, snapshot, message: '' });
        const direction = snapshot.recommendation.stableDirection;
        if (
          !lockedRef.current &&
          snapshot.recommendation.autoEligible &&
          snapshot.recommendation.stable &&
          ['long', 'short'].includes(direction)
        ) {
          directionRef.current?.(direction);
        }
      },
      onStatus(next) {
        setState((current) => ({
          ...current,
          status: current.snapshot && ['connected', 'reconnecting'].includes(next.status)
            ? current.status
            : next.status,
          message: next.message ?? '',
        }));
      },
      onError(error) {
        setState((current) => ({
          ...current,
          status: 'error',
          message: error.message,
        }));
      },
    });
    feed.start();
    return () => feed.stop();
  }, [enabled, setupKey]);

  return state;
}

