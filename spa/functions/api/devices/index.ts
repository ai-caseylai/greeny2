import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const db = c.env.DB;
    const now = Math.floor(Date.now() / 1000);

    if (c.request.method === 'GET') {
      const result = await db.prepare(
        `SELECT d.*,
          (SELECT MAX(t.created_at) FROM telemetry t WHERE t.device_id = d.id) as last_telemetry,
          (SELECT COUNT(*) FROM alerts WHERE device_id = d.id AND acknowledged = 0) as pending_alerts
         FROM devices d ORDER BY d.id`
      ).all<{
        id: string; name: string; status: string; last_seen: number | null;
        last_telemetry: number | null; location: string; floor: number;
        pending_alerts: number;
      }>();

      const enriched = result.results.map(d => ({
        ...d,
        last_seen: d.last_telemetry || d.last_seen,
        status: (d.last_telemetry && d.last_telemetry > now - 300) ? 'online' : 'offline',
      }));

      return new Response(JSON.stringify(enriched), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
