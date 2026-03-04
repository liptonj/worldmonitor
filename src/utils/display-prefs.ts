/**
 * Display preferences: time format, timezone mode, temperature unit.
 * Resolves: localStorage (user override) > admin defaults (Supabase) > hardcoded fallback.
 */

import { createClient } from '@supabase/supabase-js';

export type TimeFormat = '24h' | '12h';
export type TimezoneMode = 'utc' | 'local';
export type TempUnit = 'celsius' | 'fahrenheit';

const LS_TIME = 'display-time-format';
const LS_TZ = 'display-timezone-mode';
const LS_TEMP = 'display-temp-unit';

let adminDefaults: {
  time_format: TimeFormat;
  timezone_mode: TimezoneMode;
  temp_unit: TempUnit;
} | null = null;

/**
 * Fetches admin defaults from Supabase. Called once at app startup.
 * On failure, logs error and continues with hardcoded defaults.
 */
export async function initDisplayPrefs(): Promise<void> {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

  if (!url || !anonKey) {
    console.warn('[display-prefs] Supabase URL or anon key not configured; using hardcoded defaults');
    return;
  }

  try {
    const supabase = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data, error } = await supabase.rpc('get_display_settings');

    if (error) {
      console.warn('[display-prefs] Failed to fetch admin defaults:', error.message);
      return;
    }

    if (data && typeof data === 'object') {
      const tf = (data as { time_format?: string }).time_format;
      const tz = (data as { timezone_mode?: string }).timezone_mode;
      const tu = (data as { temp_unit?: string }).temp_unit;

      adminDefaults = {
        time_format: tf === '12h' ? '12h' : '24h',
        timezone_mode: tz === 'local' ? 'local' : 'utc',
        temp_unit: tu === 'fahrenheit' ? 'fahrenheit' : 'celsius',
      };
    }
  } catch (err) {
    console.warn('[display-prefs] Error fetching admin defaults:', err);
  }
}

export function getTimeFormat(): TimeFormat {
  const v = localStorage.getItem(LS_TIME);
  if (v === '24h' || v === '12h') return v;
  return adminDefaults?.time_format ?? '24h';
}

export function getTimezoneMode(): TimezoneMode {
  const v = localStorage.getItem(LS_TZ);
  if (v === 'utc' || v === 'local') return v;
  return adminDefaults?.timezone_mode ?? 'utc';
}

export function getTempUnit(): TempUnit {
  const v = localStorage.getItem(LS_TEMP);
  if (v === 'celsius' || v === 'fahrenheit') return v;
  return adminDefaults?.temp_unit ?? 'celsius';
}

export function setTimeFormat(v: TimeFormat): void {
  localStorage.setItem(LS_TIME, v);
  window.dispatchEvent(new CustomEvent('display-prefs-changed'));
}

export function setTimezoneMode(v: TimezoneMode): void {
  localStorage.setItem(LS_TZ, v);
  window.dispatchEvent(new CustomEvent('display-prefs-changed'));
}

export function setTempUnit(v: TempUnit): void {
  localStorage.setItem(LS_TEMP, v);
  window.dispatchEvent(new CustomEvent('display-prefs-changed'));
}

export function formatClockTime(date: Date): string {
  const tz = getTimezoneMode();
  const fmt = getTimeFormat();
  const options: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: fmt === '12h',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  };
  if (tz === 'utc') {
    options.timeZone = 'UTC';
    options.timeZoneName = 'short';
  }
  return new Intl.DateTimeFormat('en-US', options).format(date);
}

/**
 * Converts temperature DELTAS (anomalies), not absolute temperatures.
 * For deltas, multiply by 9/5 without adding 32.
 */
export function convertTemp(celsiusDelta: number): number {
  if (getTempUnit() === 'fahrenheit') return celsiusDelta * (9 / 5);
  return celsiusDelta;
}

export function getTempUnitLabel(): string {
  return getTempUnit() === 'fahrenheit' ? '°F' : '°C';
}
