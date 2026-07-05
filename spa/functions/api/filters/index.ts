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
      let query = `SELECT f.*, d.name as device_name, d.floor,
              (f.installed_at + f.lifespan_days * 86400) as expire_at,
              CAST((f.installed_at + f.lifespan_days * 86400 - unixepoch()) AS REAL) / 86400 as days_remaining
       FROM filters f LEFT JOIN devices d ON f.device_id = d.id
       WHERE f.status = 'active'`;
      const params: unknown[] = [];
      if (hotelId) { query += ' AND d.hotel_id = ?'; params.push(hotelId); }
      query += ' ORDER BY days_remaining ASC';

      const result = await db.prepare(query).bind(...params).all();
      return new Response(JSON.stringify(result.results), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'POST') {
      const body = await c.request.json<{ device_id: string; filter_type?: string; lifespan_days?: number }>();
      const now = Math.floor(Date.now() / 1000);
      const recordHotelId = hotelId || 1;

      if (hotelId) {
        const device = await db.prepare('SELECT hotel_id FROM devices WHERE id = ?').bind(body.device_id).first<{ hotel_id: number }>();
        if (!device || device.hotel_id !== hotelId) {
          return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }
      }

      await db.prepare("UPDATE filters SET status = 'replaced' WHERE device_id = ? AND status = 'active'")
        .bind(body.device_id).run();

      await db.prepare(
        `INSERT INTO filters (device_id, filter_type, installed_at, lifespan_days, status, hotel_id) VALUES (?, ?, ?, ?, 'active', ?)`
      ).bind(body.device_id, body.filter_type || 'PP棉濾芯', now, body.lifespan_days || 90, recordHotelId).run();

      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
