import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const db = c.env.DB;
    const url = new URL(c.request.url);
    const user = c.data.user;
    const hotelId = user.role === 'admin'
      ? (parseInt(url.searchParams.get('hotel_id')) || null)
      : user.hotel_id;

    const days = parseInt(url.searchParams.get('days') || '7');
    const now = Math.floor(Date.now() / 1000);
    const from = now - days * 86400;

    let query = `SELECT date(t.created_at, 'unixepoch') as date, d.id as device_id, d.name as device_name,
            SUM(t.flow_lpm / 60.0) as total_liters, AVG(t.flow_lpm) as avg_flow, COUNT(*) as readings
            FROM telemetry t JOIN devices d ON t.device_id = d.id WHERE t.created_at >= ?`;
    const params: unknown[] = [from];
    if (hotelId) { query += ' AND t.hotel_id = ?'; params.push(hotelId); }
    query += ' GROUP BY date, d.id ORDER BY date DESC, d.id';

    const result = await db.prepare(query).bind(...params).all();
    return new Response(JSON.stringify(result.results), { headers: { 'Content-Type': 'application/json' } });
  }
];
