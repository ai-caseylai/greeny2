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
      let query = 'SELECT n.*, d.name as device_name FROM notifications n LEFT JOIN devices d ON n.device_id = d.id WHERE 1=1';
      const params: unknown[] = [];
      if (hotelId) { query += ' AND n.hotel_id = ?'; params.push(hotelId); }
      query += ' ORDER BY n.created_at DESC LIMIT 50';

      const result = await db.prepare(query).bind(...params).all();
      return new Response(JSON.stringify(result.results), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'POST') {
      const body = await c.request.json<{ type?: string; title: string; message: string; device_id?: string }>();
      const now = Math.floor(Date.now() / 1000);
      const recordHotelId = hotelId || 1;
      const result = await db.prepare(
        `INSERT INTO notifications (type, title, message, device_id, hotel_id) VALUES (?, ?, ?, ?, ?)`
      ).bind(body.type || 'info', body.title, body.message, body.device_id || null, recordHotelId).run();

      return new Response(JSON.stringify({ id: result.meta.last_row_id, ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
