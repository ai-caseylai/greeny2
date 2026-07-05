import { sign } from '../../_lib/jwt';
import { verify as verifyPassword } from '../../_lib/password';
import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    if (c.request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
    }

    const body = await c.request.json<{ username: string; password: string }>();
    if (!body.username || !body.password) {
      return new Response(JSON.stringify({ error: 'Username and password required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const db = c.env.DB;
    const user = await db.prepare(
      'SELECT id, username, password_hash, role, display_name, office_id, active FROM users WHERE username = ? AND active = 1'
    ).bind(body.username).first<{ id: number; username: string; password_hash: string; role: string; display_name: string; office_id: number | null; active: number }>();

    if (!user) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const valid = await verifyPassword(body.password, user.password_hash);
    if (!valid) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const token = await sign({
      sub: user.id,
      username: user.username,
      role: user.role as any,
      office_id: user.office_id,
      display_name: user.display_name,
    }, c.env.JWT_SECRET);

    return new Response(JSON.stringify({
      token,
      user: { id: user.id, username: user.username, role: user.role, office_id: user.office_id, display_name: user.display_name }
    }), { headers: { 'Content-Type': 'application/json' } });
  }
];
