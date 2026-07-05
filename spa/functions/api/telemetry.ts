import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const url = new URL(c.request.url);
    const db = c.env.DB;

    if (c.request.method === 'POST') {
      const body = await c.request.json<{
        device_id?: string;
        ph?: number;
        ec?: number;
        water_temp?: number;
        water_level?: number;
        ndvi?: number;
        spectral_red?: number;
        spectral_green?: number;
        spectral_blue?: number;
        spectral_nir?: number;
        relay1?: number;
        relay2?: number;
        ts_ms?: number;
      }>();

      if (!body.device_id) {
        return new Response(JSON.stringify({ error: 'device_id is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      const now = Math.floor(Date.now() / 1000);
      const tsMs = body.ts_ms || Date.now();

      await db.prepare(
        `INSERT INTO devices (id, name, floor, location, status, last_seen)
         VALUES (?, ?, 1, '', 'online', ?)
         ON CONFLICT(id) DO UPDATE SET status = 'online', last_seen = ?`
      ).bind(body.device_id, body.device_id, now, now).run();

      await db.prepare(
        `INSERT INTO telemetry (device_id, ph, ec, water_temp, water_level, ndvi, spectral_red, spectral_green, spectral_blue, spectral_nir, relay1, relay2, ts_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        body.device_id,
        body.ph || 0,
        body.ec || 0,
        body.water_temp || 0,
        body.water_level || 0,
        body.ndvi || 0,
        body.spectral_red || 0,
        body.spectral_green || 0,
        body.spectral_blue || 0,
        body.spectral_nir || 0,
        body.relay1 || 0,
        body.relay2 || 0,
        tsMs, now
      ).run();

      if (body.ph && (body.ph < 5.5 || body.ph > 7.0)) {
        await db.prepare(
          `INSERT INTO alerts (device_id, type, message, severity, created_at) VALUES (?, 'ph_abnormal', ?, 'warning', ?)`
        ).bind(body.device_id, `${body.device_id} pH值異常：${body.ph}`, now).run();
      }
      if (body.ec && body.ec > 2000) {
        await db.prepare(
          `INSERT INTO alerts (device_id, type, message, severity, created_at) VALUES (?, 'ec_high', ?, 'warning', ?)`
        ).bind(body.device_id, `${body.device_id} EC值過高：${body.ec} μS/cm`, now).run();
      }
      if (body.water_temp && (body.water_temp < 18 || body.water_temp > 30)) {
        await db.prepare(
          `INSERT INTO alerts (device_id, type, message, severity, created_at) VALUES (?, 'temp_abnormal', ?, 'warning', ?)`
        ).bind(body.device_id, `${body.device_id} 水溫異常：${body.water_temp}°C`, now).run();
      }

      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    const device_id = url.searchParams.get('device_id');
    const office_id = url.searchParams.get('office_id');
    const limit = parseInt(url.searchParams.get('limit') || '100');

    let query = 'SELECT t.*, d.name as device_name FROM telemetry t JOIN devices d ON t.device_id = d.id WHERE 1=1';
    const params: unknown[] = [];

    if (device_id) { query += ' AND t.device_id = ?'; params.push(device_id); }
    query += ' ORDER BY t.ts_ms DESC LIMIT ?';
    params.push(limit);

    const result = await db.prepare(query).bind(...params).all();
    return new Response(JSON.stringify(result.results), { headers: { 'Content-Type': 'application/json' } });
  }
];
