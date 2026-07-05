import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const db = c.env.DB;
    const now = Math.floor(Date.now() / 1000);
    const todayStart = now - (now % 86400);

    const [onlineDevices, totalDevices, todayAlerts, avgPh, avgTemp, avgEc, statusDist, recentAlerts] = await Promise.all([
      db.prepare(`SELECT COUNT(DISTINCT d.id) as count FROM devices d
        WHERE EXISTS (SELECT 1 FROM telemetry t WHERE t.device_id = d.id AND t.created_at > ?)`)
        .bind(now - 300).first<{ count: number }>(),
      db.prepare(`SELECT COUNT(*) as count FROM devices`).first<{ count: number }>(),
      db.prepare(`SELECT COUNT(*) as count FROM alerts WHERE created_at >= ?`).bind(todayStart).first<{ count: number }>(),
      db.prepare(`SELECT AVG(ph) as avg FROM telemetry WHERE created_at >= ?`).bind(todayStart).first<{ avg: number }>(),
      db.prepare(`SELECT AVG(water_temp) as avg FROM telemetry WHERE created_at >= ?`).bind(todayStart).first<{ avg: number }>(),
      db.prepare(`SELECT AVG(ec) as avg FROM telemetry WHERE created_at >= ? AND ec > 0`).bind(todayStart).first<{ avg: number }>(),
      db.prepare(`SELECT status, COUNT(*) as count FROM devices GROUP BY status`).all(),
      db.prepare(`SELECT a.*, d.name as device_name FROM alerts a LEFT JOIN devices d ON a.device_id = d.id
                  WHERE a.acknowledged = 0 ORDER BY a.created_at DESC LIMIT 10`).all(),
    ]);

    return new Response(JSON.stringify({
      online_devices: onlineDevices?.count || 0,
      total_devices: totalDevices?.count || 0,
      today_alerts: todayAlerts?.count || 0,
      avg_ph: Math.round((avgPh?.avg || 0) * 10) / 10,
      avg_temp: Math.round((avgTemp?.avg || 0) * 10) / 10,
      avg_ec: Math.round(avgEc?.avg || 0),
      device_distribution: statusDist.results,
      recent_alerts: recentAlerts.results,
    }), { headers: { 'Content-Type': 'application/json' } });
  }
];
