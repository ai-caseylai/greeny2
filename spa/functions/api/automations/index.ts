import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const db = c.env.DB;

    if (c.request.method === 'GET') {
      const result = await db.prepare(
        `SELECT a.*, o.name as office_name FROM automations a LEFT JOIN offices o ON a.office_id = o.id ORDER BY a.name`
      ).all();
      return new Response(JSON.stringify(result.results), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'POST') {
      const body = await c.request.json<{ name?: string; type?: string; cron_expr?: string; config?: string; office_id?: number; enabled?: number }>();
      const result = await db.prepare(
        `INSERT INTO automations (name, type, cron_expr, config, office_id, enabled) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(body.name || '', body.type || '', body.cron_expr || null, body.config || null, body.office_id || null, body.enabled !== undefined ? body.enabled : 1).run();
      return new Response(JSON.stringify({ id: result.meta.last_row_id, ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
