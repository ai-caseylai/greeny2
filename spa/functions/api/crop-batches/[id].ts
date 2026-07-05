import type { Env, JwtPayload } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const user = c.data.user as JwtPayload;
    if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

    const url = new URL(c.request.url);
    const id = parseInt(url.pathname.split('/').pop()!);
    const db = c.env.DB;

    const batch = await db.prepare('SELECT * FROM crop_batches WHERE id = ?').bind(id).first<{ id: number; office_id: number }>();
    if (!batch) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

    if (user.role !== 'superadmin' && batch.office_id !== user.office_id) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'PATCH') {
      if (user.role === 'staff') {
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      const body = await c.request.json<{
        variety?: string; quantity?: number; unit?: string;
        status?: string; rack_id?: number; layer_number?: number;
        expected_harvest_days?: number; notes?: string;
      }>();

      const updates: string[] = [];
      const params: unknown[] = [];

      if (body.variety !== undefined) { updates.push('variety = ?'); params.push(body.variety); }
      if (body.quantity !== undefined) { updates.push('quantity = ?'); params.push(body.quantity); }
      if (body.unit !== undefined) { updates.push('unit = ?'); params.push(body.unit); }
      if (body.status !== undefined) { updates.push('status = ?'); params.push(body.status); }
      if (body.rack_id !== undefined) { updates.push('rack_id = ?'); params.push(body.rack_id); }
      if (body.layer_number !== undefined) { updates.push('layer_number = ?'); params.push(body.layer_number); }
      if (body.expected_harvest_days !== undefined) { updates.push('expected_harvest_days = ?'); params.push(body.expected_harvest_days); }
      if (body.notes !== undefined) { updates.push('notes = ?'); params.push(body.notes); }

      if (updates.length === 0) {
        return new Response(JSON.stringify({ error: 'No fields to update' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      params.push(id);
      await db.prepare(`UPDATE crop_batches SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'DELETE') {
      if (user.role === 'staff') {
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      await db.prepare('DELETE FROM crop_batches WHERE id = ?').bind(id).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
