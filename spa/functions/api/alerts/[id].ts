import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const db = c.env.DB;
    const id = c.params.id as string;

    if (c.request.method === 'PUT') {
      const url = new URL(c.request.url);
      if (url.pathname.endsWith('/acknowledge')) {
        await db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').bind(id).run();
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (c.request.method === 'PATCH') {
      const body = await c.request.json<{ acknowledged?: number }>();
      if (body.acknowledged !== undefined) {
        await db.prepare('UPDATE alerts SET acknowledged = ? WHERE id = ?').bind(body.acknowledged, id).run();
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
