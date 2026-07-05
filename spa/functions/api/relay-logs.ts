import type { Env } from '../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const url = new URL(c.request.url);
    const deviceId = url.searchParams.get('device_id');
    const limit = parseInt(url.searchParams.get('limit') || '50');

    if (!deviceId) {
      return new Response(JSON.stringify({ error: 'device_id required' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    const logs = await c.env.DB.prepare(
      'SELECT id, relay1, relay2, ph_cal, status, created_at FROM relay_log WHERE device_id = ? ORDER BY id DESC LIMIT ?'
    ).bind(deviceId, limit).all();

    return new Response(JSON.stringify(logs.results), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
];
