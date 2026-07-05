import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const db = c.env.DB;
    const id = c.params.id as string;

    if (c.request.method === 'PUT') {
      const body = await c.request.json<{ variety?: string; quantity?: number; notes?: string }>();
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.variety !== undefined) { sets.push('variety = ?'); params.push(body.variety); }
      if (body.quantity !== undefined) { sets.push('quantity = ?'); params.push(body.quantity); }
      if (body.notes !== undefined) { sets.push('notes = ?'); params.push(body.notes); }
      if (sets.length === 0) {
        return new Response(JSON.stringify({ error: 'No fields to update' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      params.push(id);
      await db.prepare(`UPDATE rack_vegetables SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'DELETE') {
      await db.prepare(`DELETE FROM rack_vegetables WHERE id = ?`).bind(id).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
