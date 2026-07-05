import type { Env } from '../../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const db = c.env.DB;
    const id = c.params.id as string;

    if (c.request.method === 'POST') {
      await db.prepare(`UPDATE automations SET last_run_at = unixepoch() WHERE id = ?`).bind(id).run();
      return new Response(JSON.stringify({ ok: true, message: 'Automation triggered' }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
