import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    if (c.request.method === 'POST') {
      const body = await c.request.json<{ phone?: string; message?: string }>();
      if (!body.phone || !body.message) {
        return new Response(JSON.stringify({ error: 'phone and message are required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      const apiUrl = `${c.env.WORKBUDDY_API_URL}/chat/send`;
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${c.env.WORKBUDDY_API_KEY}`,
        },
        body: JSON.stringify({ phone: body.phone, message: body.message }),
      });

      const data = await response.json();
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
