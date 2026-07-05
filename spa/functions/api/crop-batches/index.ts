import type { Env, JwtPayload } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const user = c.data.user as JwtPayload;
    if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

    const url = new URL(c.request.url);
    const db = c.env.DB;

    if (c.request.method === 'GET') {
      const officeId = url.searchParams.get('office_id');
      const status = url.searchParams.get('status');

      let query = `
        SELECT cb.*, o.name as office_name, r.name as rack_name
        FROM crop_batches cb
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

      if (status) {
        query += ' AND cb.status = ?';
        params.push(status);
      }

      query += ' ORDER BY cb.seeded_at DESC';
      const result = await db.prepare(query).bind(...params).all();
      return new Response(JSON.stringify(result.results), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'POST') {
      if (user.role === 'staff') {
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      const body = await c.request.json<{
        office_id?: number; rack_id?: number; layer_number?: number;
        variety: string; quantity?: number; unit?: string;
        status?: string; seeded_at?: number; expected_harvest_days?: number; notes?: string;
      }>();

      const officeId = user.role === 'office_admin' ? user.office_id : (body.office_id || null);
      if (!officeId && user.role !== 'superadmin') {
        return new Response(JSON.stringify({ error: 'office_id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      if (!body.variety) {
        return new Response(JSON.stringify({ error: 'variety required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      const result = await db.prepare(
        `INSERT INTO crop_batches (office_id, rack_id, layer_number, variety, quantity, unit, status, seeded_at, expected_harvest_days, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        officeId || null,
        body.rack_id || null,
        body.layer_number || null,
        body.variety,
        body.quantity || 0,
        body.unit || '株',
        body.status || 'growing',
        body.seeded_at || Math.floor(Date.now() / 1000),
        body.expected_harvest_days || 10,
        body.notes || ''
      ).run();

      return new Response(JSON.stringify({ id: result.meta.last_row_id, ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
