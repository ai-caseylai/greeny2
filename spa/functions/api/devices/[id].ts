import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const db = c.env.DB;
    const id = c.params.id as string;

    if (c.request.method === 'GET') {
      const device = await db.prepare(
        `SELECT d.*, (SELECT COUNT(*) FROM alerts WHERE device_id = d.id AND acknowledged = 0) as pending_alerts
         FROM devices d WHERE d.id = ?`
      ).bind(id).first();
      if (!device) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(device), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'PUT') {
      const body = await c.request.json<{ name?: string; floor?: number; location?: string; status?: string }>();
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.name !== undefined) { sets.push('name = ?'); params.push(body.name); }
      if (body.floor !== undefined) { sets.push('floor = ?'); params.push(body.floor); }
      if (body.location !== undefined) { sets.push('location = ?'); params.push(body.location); }
      if (body.status !== undefined) { sets.push('status = ?'); params.push(body.status); }
      if (sets.length === 0) {
        return new Response(JSON.stringify({ error: 'No fields to update' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      params.push(id);
      await db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'DELETE') {
      // 刪除關聯資料
      await db.prepare('DELETE FROM telemetry WHERE device_id = ?').bind(id).run();
      await db.prepare('DELETE FROM alerts WHERE device_id = ?').bind(id).run();
      // 處理 racks 關聯
      const racks = await db.prepare('SELECT id FROM racks WHERE device_id = ?').bind(id).all<{id: number}>();
      for (const rack of racks.results) {
        await db.prepare('DELETE FROM rack_vegetables WHERE rack_id = ?').bind(rack.id).run();
        await db.prepare('DELETE FROM rack_environment WHERE rack_id = ?').bind(rack.id).run();
        await db.prepare('DELETE FROM automations WHERE rack_id = ?').bind(rack.id).run();
      }
      await db.prepare('DELETE FROM racks WHERE device_id = ?').bind(id).run();
      // 刪除裝置
      await db.prepare('DELETE FROM devices WHERE id = ?').bind(id).run();
      return new Response(JSON.stringify({ ok: true, deleted: id }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
