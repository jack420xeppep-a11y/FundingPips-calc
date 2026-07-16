import { useEffect, useRef, useState } from 'react';

import {
  buildGoldIntelligenceContextKey,
  createGoldIntelligenceFeed,
} from '../services/goldIntelligence.js';

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
  resumeAfter = null,
  onResynced = () => {},
}) {
  const [state, setState] = useState(OFF_STATE);
  const directionRef = useRef(onDirection);
  const lockedRef = useRef(locked);
  const resumeAfterRef = useRef(resumeAfter);
  const resyncCandidateRef = useRef({ direction: null, since: 0 });
  const resyncedRef = useRef(onResynced);

  directionRef.current = onDirection;
  lockedRef.current = locked;
  resumeAfterRef.current = resumeAfter;
  resyncedRef.current = onResynced;
  const setupKey = setup ? buildGoldIntelligenceContextKey(setup) : '';

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
        if (resumeAfterRef.current && !lockedRef.current) {
          const actionable =
            snapshot.recommendation.autoEligible &&
            snapshot.recommendation.stable &&
            ['long', 'short'].includes(direction);
          if (!actionable) {
            resyncCandidateRef.current = { direction: null, since: 0 };
            return;
          }
          const currentTime = Date.now();
          if (resyncCandidateRef.current.direction !== direction) {
            resyncCandidateRef.current = { direction, since: currentTime };
            return;
          }
          const evidenceSince = Math.max(
            resumeAfterRef.current,
            resyncCandidateRef.current.since,
          );
          if (currentTime - evidenceSince < 60_000) return;
          directionRef.current?.(direction);
          resyncCandidateRef.current = { direction: null, since: 0 };
          resyncedRef.current?.();
          return;
        }
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
