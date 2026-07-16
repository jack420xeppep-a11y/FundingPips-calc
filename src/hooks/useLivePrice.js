import { useEffect, useRef, useState } from 'react';

import { createBybitTradfiFeed } from '../services/bybitTradfi.js';

const OFF_STATE = Object.freeze({ status: 'off', quote: null, message: '' });

export default function useLivePrice({ enabled, instrument, onPrice }) {
  const [state, setState] = useState(OFF_STATE);
  const instrumentRef = useRef(instrument);
  const onPriceRef = useRef(onPrice);
  const quoteCacheRef = useRef(new Map());

  instrumentRef.current = instrument;
  onPriceRef.current = onPrice;

  useEffect(() => {
    if (!enabled) {
      quoteCacheRef.current.clear();
      setState(OFF_STATE);
      return undefined;
    }

    const feed = createBybitTradfiFeed({
      onQuotes(quotes) {
        for (const quote of quotes) quoteCacheRef.current.set(quote.instrument, quote);
        const quote = quoteCacheRef.current.get(instrumentRef.current);
        if (!quote) return;
        setState({ status: 'live', quote, message: '' });
        onPriceRef.current?.(quote);
      },
      onStatus(next) {
        setState((current) => ({
          ...current,
          status: next.status === 'connected' && current.quote ? 'live' : next.status,
          message: '',
        }));
      },
      onError(error) {
        setState((current) => ({ ...current, status: 'error', message: error.message }));
      },
    });

    feed.start();
    return () => feed.stop();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const quote = quoteCacheRef.current.get(instrument);
    if (quote) {
      setState({ status: 'live', quote, message: '' });
      onPriceRef.current?.(quote);
      return;
    }
    setState((current) => ({ ...current, status: 'connecting', quote: null, message: '' }));
  }, [enabled, instrument]);

  return state;
}
