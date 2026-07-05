import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const url = new URL(c.request.url);
    const db = c.env.DB;
    const user = c.data.user;
    const hotelId = user.role === 'admin'
      ? (parseInt(url.searchParams.get('hotel_id')) || null)
      : user.hotel_id;

    if (c.request.method === 'GET') {
      const status = url.searchParams.get('status');
      let query = `SELECT t.*, d.name as device_name, p.name as personnel_name
                   FROM tasks t LEFT JOIN devices d ON t.device_id = d.id LEFT JOIN personnel p ON t.personnel_id = p.id WHERE 1=1`;
      const params: unknown[] = [];
      if (hotelId) { query += ' AND t.hotel_id = ?'; params.push(hotelId); }
      if (status) { query += ' AND t.status = ?'; params.push(status); }
      query += ' ORDER BY t.created_at DESC LIMIT 200';

      const result = await db.prepare(query).bind(...params).all();
      return new Response(JSON.stringify(result.results), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'POST') {
      const body = await c.request.json<{ device_id?: string; personnel_id?: number; type?: string; notes?: string }>();
      const recordHotelId = hotelId || 1;
      const result = await db.prepare(
        `INSERT INTO tasks (device_id, personnel_id, type, notes, hotel_id) VALUES (?, ?, ?, ?, ?)`
      ).bind(body.device_id || null, body.personnel_id || null, body.type || 'inspection', body.notes || '', recordHotelId).run();
      return new Response(JSON.stringify({ id: result.meta.last_row_id, ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
