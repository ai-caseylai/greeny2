import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const db = c.env.DB;
    const url = new URL(c.request.url);
    const user = c.data.user;
    const hotelId = user.role === 'admin'
      ? (parseInt(url.searchParams.get('hotel_id')) || null)
      : user.hotel_id;

    const [totalDevices, onlineDevices, totalAlerts, pendingTasks, activeFilters] = await Promise.all([
      db.prepare(`SELECT COUNT(*) as c FROM devices d WHERE 1=1${hotelId ? ' AND d.hotel_id = ?' : ''}`)
        .bind(...(hotelId ? [hotelId] : [])).first<{ c: number }>(),
      db.prepare(`SELECT COUNT(*) as c FROM devices d WHERE d.status = 'online'${hotelId ? ' AND d.hotel_id = ?' : ''}`)
        .bind(...(hotelId ? [hotelId] : [])).first<{ c: number }>(),
      db.prepare(`SELECT COUNT(*) as c FROM alerts a WHERE 1=1${hotelId ? ' AND a.hotel_id = ?' : ''}`)
        .bind(...(hotelId ? [hotelId] : [])).first<{ c: number }>(),
      db.prepare(`SELECT COUNT(*) as c FROM tasks t WHERE t.status = 'pending'${hotelId ? ' AND t.hotel_id = ?' : ''}`)
        .bind(...(hotelId ? [hotelId] : [])).first<{ c: number }>(),
      db.prepare(`SELECT COUNT(*) as c FROM filters f WHERE f.status = 'active'${hotelId ? ' AND f.hotel_id = ?' : ''}`)
        .bind(...(hotelId ? [hotelId] : [])).first<{ c: number }>(),
    ]);

    return new Response(JSON.stringify({
      total_devices: totalDevices?.c || 0,
      online_devices: onlineDevices?.c || 0,
      total_alerts: totalAlerts?.c || 0,
      pending_tasks: pendingTasks?.c || 0,
      active_filters: activeFilters?.c || 0,
    }), { headers: { 'Content-Type': 'application/json' } });
  }
];
