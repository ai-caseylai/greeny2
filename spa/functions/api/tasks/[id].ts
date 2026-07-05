import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const db = c.env.DB;
    const id = c.params.id as string;

    if (c.request.method === 'PATCH') {
      const body = await c.request.json<{ status?: string; notes?: string; personnel_id?: number }>();
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.status) {
        sets.push('status = ?');
        params.push(body.status);
        if (body.status === 'completed') {
          sets.push('completed_at = ?');
          params.push(Math.floor(Date.now() / 1000));
        }
      }
      if (body.notes !== undefined) { sets.push('notes = ?'); params.push(body.notes); }
      if (body.personnel_id !== undefined) { sets.push('personnel_id = ?'); params.push(body.personnel_id); }
      if (sets.length === 0) {
        return new Response(JSON.stringify({ error: 'No fields to update' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      params.push(id);
      await db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
