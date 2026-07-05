import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    if (c.request.method === 'GET') {
      try {
        const apiUrl = `${c.env.WORKBUDDY_API_URL}/status`;
        const response = await fetch(apiUrl, {
          headers: {
            'Authorization': `Bearer ${c.env.WORKBUDDY_API_KEY}`,
          },
        });

        const data = await response.json() as Record<string, unknown>;
        return new Response(JSON.stringify({ connected: response.ok, ...data }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch {
        return new Response(JSON.stringify({ connected: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
