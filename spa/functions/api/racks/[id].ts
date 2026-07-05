import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const db = c.env.DB;
    const id = c.params.id as string;

    if (c.request.method === 'GET') {
      const rack = await db.prepare(
        `SELECT r.*, o.name as office_name, d.name as device_name
         FROM racks r LEFT JOIN offices o ON r.office_id = o.id LEFT JOIN devices d ON r.device_id = d.id WHERE r.id = ?`
      ).bind(id).first();
      if (!rack) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(rack), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'PUT') {
      const body = await c.request.json<{ name?: string; office_id?: number; device_id?: string; location?: string; status?: string; layer_count?: number }>();
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.name !== undefined) { sets.push('name = ?'); params.push(body.name); }
      if (body.office_id !== undefined) { sets.push('office_id = ?'); params.push(body.office_id); }
      if (body.device_id !== undefined) { sets.push('device_id = ?'); params.push(body.device_id); }
      if (body.location !== undefined) { sets.push('location = ?'); params.push(body.location); }
      if (body.status !== undefined) { sets.push('status = ?'); params.push(body.status); }
      if (body.layer_count !== undefined) { sets.push('layer_count = ?'); params.push(body.layer_count); }
      if (sets.length === 0) {
        return new Response(JSON.stringify({ error: 'No fields to update' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      params.push(id);
      await db.prepare(`UPDATE racks SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'DELETE') {
      await db.prepare(`DELETE FROM racks WHERE id = ?`).bind(id).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
