import { verify, extractBearerToken } from '../_lib/jwt';
import type { Env, JwtPayload } from '../_lib/types';

declare global {
  interface EventContext<Env = any, Params = any, Data = any> {
    data: { user?: JwtPayload };
  }
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const path = url.pathname;

  if (path === '/api/auth/login') return context.next();
  if (path.startsWith('/api/auth/')) return context.next();
  if (path.startsWith('/api/wb/')) return context.next();
  if (path === '/api/telemetry' && context.request.method === 'POST') return context.next();
  if (path === '/api/relay' && context.request.method === 'GET') return context.next();

  const token = extractBearerToken(context.request);
  if (!token) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  const payload = await verify(token, context.env.JWT_SECRET);
  if (!payload) {
    return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  context.data.user = payload;
  return context.next();
};
