import React from 'react';

export default function ThemeToggle({ theme, onToggle }) {
  const isDark = theme === 'dark';

  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label="Переключить цветовую тему"
      aria-pressed={isDark}
      title={isDark ? 'Включить светлую тему' : 'Включить тёмную тему'}
      onClick={onToggle}
    >
      <span className="theme-toggle__track" aria-hidden="true">
        <span className="theme-toggle__knob" />
      </span>
      <span className="theme-toggle__label">{isDark ? 'Тёмная' : 'Светлая'}</span>
    </button>
  );
}
