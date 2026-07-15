import React from 'react';

import { normalizeFieldValue } from './fieldValue.js';

export default function Field({
  id,
  label,
  value,
  onChange,
  options,
  type = 'number',
  step,
  min,
  max,
  hint,
  className = '',
}) {
  const handleChange = (event) => {
    const nextValue = normalizeFieldValue(event.target.value, { options, type });
    onChange(id, nextValue);
  };

  return (
    <div className={`field ${className}`.trim()}>
      <label htmlFor={id}>{label}</label>
      {options ? (
        <select id={id} value={value} onChange={handleChange}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={type}
          value={value}
          onChange={handleChange}
          inputMode="decimal"
          step={step}
          min={min}
          max={max}
        />
      )}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}
