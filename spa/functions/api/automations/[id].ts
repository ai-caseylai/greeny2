import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const db = c.env.DB;
    const id = c.params.id as string;

    if (c.request.method === 'PUT') {
      const body = await c.request.json<{ name?: string; type?: string; cron_expr?: string; config?: string; office_id?: number; enabled?: number }>();
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.name !== undefined) { sets.push('name = ?'); params.push(body.name); }
      if (body.type !== undefined) { sets.push('type = ?'); params.push(body.type); }
      if (body.cron_expr !== undefined) { sets.push('cron_expr = ?'); params.push(body.cron_expr); }
      if (body.config !== undefined) { sets.push('config = ?'); params.push(body.config); }
      if (body.office_id !== undefined) { sets.push('office_id = ?'); params.push(body.office_id); }
      if (body.enabled !== undefined) { sets.push('enabled = ?'); params.push(body.enabled); }
      if (sets.length === 0) {
        return new Response(JSON.stringify({ error: 'No fields to update' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      params.push(id);
      await db.prepare(`UPDATE automations SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'DELETE') {
      await db.prepare(`DELETE FROM automations WHERE id = ?`).bind(id).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
