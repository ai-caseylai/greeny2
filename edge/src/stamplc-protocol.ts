
export type RelayValue = boolean | null;
export type RelayValues = [RelayValue, RelayValue, RelayValue, RelayValue];
export type Role = 'superadmin' | 'office_admin' | 'staff';
export interface User { sub: number; id: number; username: string; role: Role; office_id: number | null; display_name: string; }
export interface RelayRequest { device_id: string; command_id: string; channel: number; state: boolean; }
export interface SensorSample { ph: number; ec: number; temp: number; tds: number | null; utc_ms: number; date_time_hk: string; esp32_ms: number; received_ms: number; }
export const RELAY_TTL_MS = 15000;
export const RELAY_REPORT_FRESH_MS = 15000;
export const SAMPLE_FRESH_MS = 30000;
export const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SESSION_RE = /^(?:[0-9a-f]{16}|[0-9a-f]{32})$/i;
export function json(data: unknown, status = 200): Response { return new Response(JSON.stringify(data), {status, headers: {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}}); }
export function hkTime(utcMs: number): string {
  const d = new Date(utcMs + 28800000);
  const p = (n: number) => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + '-' + p(d.getUTCMonth() + 1) + '-' + String(d.getUTCFullYear()).slice(-2) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}
export function relayValues(value: unknown, valid: unknown): RelayValues | null {
  if (!Array.isArray(value) || value.length !== 4 || typeof valid !== 'boolean') return null;
  if (valid ? !value.every(x => typeof x === 'boolean') : !value.every(x => x === null)) return null;
  return value.slice() as RelayValues;
}
export function relayRequest(value: any): RelayRequest | null {
  if (!value || typeof value.device_id !== 'string' || typeof value.command_id !== 'string' || !DEVICE_ID_RE.test(value.device_id) || !UUID_RE.test(value.command_id) || !Number.isInteger(value.channel) || value.channel < 1 || value.channel > 4 || typeof value.state !== 'boolean') return null;
  return {device_id:value.device_id,command_id:value.command_id.toLowerCase(),channel:value.channel,state:value.state};
}
export function sensorSample(value: any, now: number): SensorSample | null {
  if (!value || typeof value.ph !== 'number' || !Number.isFinite(value.ph) || value.ph < 0 || value.ph > 14 || typeof value.ec !== 'number' || !Number.isFinite(value.ec) || value.ec < 0 || value.ec > 1000000 || typeof value.temp !== 'number' || !Number.isFinite(value.temp) || value.temp < -40 || value.temp > 125) return null;
  if (value.tds !== null && (typeof value.tds !== 'number' || !Number.isFinite(value.tds) || value.tds < 0)) return null;
  if (!Number.isSafeInteger(value.utc_ms) || value.utc_ms < 1609459200000 || value.utc_ms > now + 2000) return null;
  if (!Number.isSafeInteger(value.esp32_ms) || value.esp32_ms < 0) return null;
  const formatted = hkTime(value.utc_ms);
  if (value.date_time_hk !== undefined && value.date_time_hk !== formatted) return null;
  return {ph:value.ph, ec:value.ec, temp:value.temp, tds:value.tds, utc_ms:value.utc_ms,date_time_hk:formatted,esp32_ms:value.esp32_ms,received_ms:now};
}
