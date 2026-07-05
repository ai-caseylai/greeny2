import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const url = new URL(c.request.url);
    const db = c.env.DB;

    if (c.request.method === 'GET') {
      const rack_id = url.searchParams.get('rack_id');
      if (!rack_id) {
        return new Response(JSON.stringify({ error: 'rack_id is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const result = await db.prepare(
        `SELECT * FROM rack_environment WHERE rack_id = ? ORDER BY recorded_at DESC LIMIT 100`
      ).bind(rack_id).all();
      return new Response(JSON.stringify(result.results), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'POST') {
      const body = await c.request.json<{ rack_id?: number; temperature?: number; humidity?: number; light_level?: number; ph?: number; ec?: number; source?: string }>();
      const result = await db.prepare(
        `INSERT INTO rack_environment (rack_id, temperature, humidity, light_level, ph, ec, source) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(body.rack_id || null, body.temperature || null, body.humidity || null, body.light_level || null, body.ph || null, body.ec || null, body.source || null).run();
      return new Response(JSON.stringify({ id: result.meta.last_row_id, ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
