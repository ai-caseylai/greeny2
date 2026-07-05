import type { Env } from '../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const url = new URL(c.request.url);
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

    if (c.request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    // GET: ESP32 拉取待處理 relay 指令
    if (c.request.method === 'GET') {
      const deviceId = url.searchParams.get('device_id');
      if (!deviceId) return new Response(JSON.stringify({ error: 'device_id required' }), { status: 400, headers });

      const cmd = await c.env.DB.prepare(
        'SELECT id, relay1, relay2 FROM relay_queue WHERE device_id = ? ORDER BY id DESC LIMIT 1'
      ).bind(deviceId).first<{ id: number; relay1: number | null; relay2: number | null }>();

      if (cmd) {
        // 刪除已處理的指令
        await c.env.DB.prepare('DELETE FROM relay_queue WHERE device_id = ? AND id <= ?').bind(deviceId, cmd.id).run();
        return new Response(JSON.stringify({
          relay1: cmd.relay1, relay2: cmd.relay2,
        }), { headers });
      }
      return new Response(JSON.stringify({}), { headers });
    }

    // POST: 前端發送 relay 指令
    if (c.request.method === 'POST') {
      const body = await c.request.json<{ device_id?: string; relay1?: number; relay2?: number }>();
      if (!body.device_id) {
        return new Response(JSON.stringify({ error: 'device_id required' }), { status: 400, headers });
      }

      await c.env.DB.prepare(
        'INSERT INTO relay_queue (device_id, relay1, relay2) VALUES (?, ?, ?)'
      ).bind(body.device_id, body.relay1, body.relay2).run();

      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }
];
