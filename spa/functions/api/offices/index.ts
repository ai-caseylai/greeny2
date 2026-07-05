import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const db = c.env.DB;

    if (c.request.method === 'GET') {
      const result = await db.prepare(
        `SELECT * FROM offices WHERE active = 1 ORDER BY name`
      ).all();
      return new Response(JSON.stringify(result.results), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'POST') {
      const body = await c.request.json<{ name?: string; contact_person?: string; contact_phone?: string; whatsapp_number?: string; notes?: string }>();
      const result = await db.prepare(
        `INSERT INTO offices (name, contact_person, contact_phone, whatsapp_number, notes) VALUES (?, ?, ?, ?, ?)`
      ).bind(body.name || '', body.contact_person || null, body.contact_phone || null, body.whatsapp_number || null, body.notes || null).run();
      const office = await db.prepare(`SELECT * FROM offices WHERE id = ?`).bind(result.meta.last_row_id).first();
      return new Response(JSON.stringify(office), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
