import { verify, extractBearerToken, getJwtSecret } from '../_lib/jwt';
import type { Env, JwtPayload } from '../_lib/types';

declare global {
  interface EventContext<Env = any, Params = any, Data = any> {
    data: { user?: JwtPayload };
  }
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const path = url.pathname;

  // 只有 login 免認證。舊版寫成 path.startsWith('/api/auth/') 會連
  // /api/auth/me 一起放行 → middleware 沒設 context.data.user → me.ts 讀
  // user.sub 時 TypeError → 500。
  if (path === '/api/auth/login') return context.next();
  if (path.startsWith('/api/wb/')) return context.next();
  // POST /api/telemetry 由 handler 自己驗證（device token 或 JWT），
  // 所以這裡跳過 header 式 JWT 中介層；未授權者會在 handler 內回 401。
  if (path === '/api/telemetry' && context.request.method === 'POST') return context.next();
  if (path === '/api/relay' && context.request.method === 'GET') return context.next();

  const token = extractBearerToken(context.request);
  if (!token) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Read JWT secret from D1 (same source as Worker). No fallback to a default.
  const jwtSecret = await getJwtSecret(context.env);
  if (!jwtSecret) {
    return new Response(JSON.stringify({ error: 'Server misconfigured: jwt_secret missing from D1 settings' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const payload = await verify(token, jwtSecret);
  if (!payload) {
    return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  context.data.user = payload;
  return context.next();
};
