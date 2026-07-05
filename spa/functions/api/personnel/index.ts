import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const db = c.env.DB;
    const url = new URL(c.request.url);
    const user = c.data.user;
    const hotelId = user.role === 'admin'
      ? (parseInt(url.searchParams.get('hotel_id')) || null)
      : user.hotel_id;

    if (c.request.method === 'GET') {
      let query = `SELECT p.*, (SELECT COUNT(*) FROM tasks WHERE personnel_id = p.id AND status = 'pending') as pending_tasks
       FROM personnel p WHERE p.active = 1`;
      const params: unknown[] = [];
      if (hotelId) { query += ' AND p.hotel_id = ?'; params.push(hotelId); }
      query += ' ORDER BY p.name';

      const result = await db.prepare(query).bind(...params).all();
      return new Response(JSON.stringify(result.results), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'POST') {
      const body = await c.request.json<{ name: string; phone?: string; role?: string; assigned_floors?: number[] }>();
      const recordHotelId = hotelId || 1;
      const result = await db.prepare(
        `INSERT INTO personnel (name, phone, role, assigned_floors, hotel_id) VALUES (?, ?, ?, ?, ?)`
      ).bind(body.name, body.phone || '', body.role || '維護員', JSON.stringify(body.assigned_floors || []), recordHotelId).run();

      return new Response(JSON.stringify({ id: result.meta.last_row_id, ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
