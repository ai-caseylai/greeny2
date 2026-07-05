import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const url = new URL(c.request.url);
    const db = c.env.DB;

    if (c.request.method === 'GET') {
      const office_id = url.searchParams.get('office_id');
      let query = `SELECT r.*, o.name as office_name, d.name as device_name
                   FROM racks r LEFT JOIN offices o ON r.office_id = o.id LEFT JOIN devices d ON r.device_id = d.id WHERE 1=1`;
      const params: unknown[] = [];
      if (office_id) { query += ' AND r.office_id = ?'; params.push(office_id); }
      query += ' ORDER BY r.name';

      const result = await db.prepare(query).bind(...params).all();
      return new Response(JSON.stringify(result.results), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'POST') {
      const body = await c.request.json<{ name?: string; office_id?: number; device_id?: string; location?: string; status?: string; layer_count?: number }>();
      const result = await db.prepare(
        `INSERT INTO racks (name, office_id, device_id, location, status, layer_count) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(body.name || '', body.office_id || null, body.device_id || null, body.location || null, body.status || 'active', body.layer_count || null).run();
      return new Response(JSON.stringify({ id: result.meta.last_row_id, ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
