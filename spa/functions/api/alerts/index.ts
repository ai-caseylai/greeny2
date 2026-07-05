import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const url = new URL(c.request.url);
    const db = c.env.DB;

    const acknowledged = url.searchParams.get('acknowledged');
    const device_id = url.searchParams.get('device_id');
    let query = 'SELECT a.*, d.name as device_name FROM alerts a LEFT JOIN devices d ON a.device_id = d.id WHERE 1=1';
    const params: unknown[] = [];

    if (acknowledged !== null) { query += ' AND a.acknowledged = ?'; params.push(parseInt(acknowledged)); }
    if (device_id) { query += ' AND a.device_id = ?'; params.push(device_id); }
    query += ' ORDER BY a.created_at DESC LIMIT 200';

    const result = await db.prepare(query).bind(...params).all();
    return new Response(JSON.stringify(result.results), { headers: { 'Content-Type': 'application/json' } });
  }
];
