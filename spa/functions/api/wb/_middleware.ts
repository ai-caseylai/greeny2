import type { Env } from '../../../_lib/types';

export const onRequest: PagesFunction<Env> = async (context) => {
  const auth = context.request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Missing API key' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  const key = auth.slice(7);
  if (key !== context.env.WB_API_KEY) {
    return new Response(JSON.stringify({ error: 'Invalid API key' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }
  return context.next();
};
