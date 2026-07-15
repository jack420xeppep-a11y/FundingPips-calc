import React from 'react';

import { INSTRUMENTS } from '../domain/calculator.js';
import Field from './Field.jsx';

const instrumentOptions = Object.keys(INSTRUMENTS).map((instrument) => ({
  value: instrument,
  label: instrument,
}));

export default function PositionControls({ values, onChange }) {
  return (
    <section className="input-rail" aria-label="Основные параметры позиции">
      <Field
        id="instrument"
        label="Инструмент"
        value={values.instrument}
        onChange={onChange}
        options={instrumentOptions}
      />
      <Field
        id="entryPrice"
        label="Цена входа"
        value={values.entryPrice}
        onChange={onChange}
        step={INSTRUMENTS[values.instrument]?.step ?? 0.00001}
        min="0"
      />
      <Field
        id="fpDirection"
        label="Направление FP"
        value={values.fpDirection}
        onChange={onChange}
        options={[
          { value: 'long', label: 'LONG' },
          { value: 'short', label: 'SHORT' },
        ]}
      />
      <Field
        id="slPct"
        label="SL от входа"
        value={values.slPct}
        onChange={onChange}
        step="0.01"
        min="0.01"
        max="10"
      />
      <Field
        id="stage"
        label="Этап"
        value={values.stage}
        onChange={onChange}
        options={[
          { value: 'p1', label: 'PHASE 1' },
          { value: 'p2', label: 'PHASE 2' },
          { value: 'funded', label: 'FUNDED' },
        ]}
      />
    </section>
  );
}

