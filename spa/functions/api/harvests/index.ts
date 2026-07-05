import type { Env, JwtPayload } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const user = c.data.user as JwtPayload;
    if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

    const url = new URL(c.request.url);
    const db = c.env.DB;

    if (c.request.method === 'GET') {
      const batchId = url.searchParams.get('batch_id');
      const officeId = url.searchParams.get('office_id');

      let query = `
        SELECT hl.*, cb.variety, cb.office_id, o.name as office_name, r.name as rack_name
        FROM harvest_logs hl
        LEFT JOIN crop_batches cb ON hl.batch_id = cb.id
        LEFT JOIN offices o ON cb.office_id = o.id
        LEFT JOIN racks r ON cb.rack_id = r.id
        WHERE 1=1
      `;
      const params: unknown[] = [];

      if (user.role === 'office_admin' || user.role === 'staff') {
        query += ' AND cb.office_id = ?';
        params.push(user.office_id);
      } else if (officeId) {
        query += ' AND cb.office_id = ?';
        params.push(Number(officeId));
      }

      if (batchId) {
        query += ' AND hl.batch_id = ?';
        params.push(Number(batchId));
      }

      query += ' ORDER BY hl.harvested_at DESC';
      const result = await db.prepare(query).bind(...params).all();
      return new Response(JSON.stringify(result.results), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'POST') {
      if (user.role === 'staff') {
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      const body = await c.request.json<{
        batch_id: number; quantity?: number; unit?: string;
        quality?: string; notes?: string; harvested_at?: number;
      }>();

      if (!body.batch_id) {
        return new Response(JSON.stringify({ error: 'batch_id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // Verify batch is in user's scope
      const batch = await db.prepare('SELECT office_id FROM crop_batches WHERE id = ?').bind(body.batch_id).first<{ office_id: number }>();
      if (!batch) return new Response(JSON.stringify({ error: 'Batch not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      if (user.role !== 'superadmin' && batch.office_id !== user.office_id) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }

      const result = await db.prepare(
        `INSERT INTO harvest_logs (batch_id, quantity, unit, quality, notes, harvested_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        body.batch_id,
        body.quantity || 0,
        body.unit || '株',
        body.quality || 'good',
        body.notes || '',
        body.harvested_at || Math.floor(Date.now() / 1000)
      ).run();

      // Auto-update batch status to harvested
      await db.prepare('UPDATE crop_batches SET status = ? WHERE id = ?').bind('harvested', body.batch_id).run();

      return new Response(JSON.stringify({ id: result.meta.last_row_id, ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
