import { hash } from '../../_lib/password';
import type { Env, JwtPayload } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const user = c.data.user as JwtPayload;
    if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

    // Only superadmin and office_admin can list users
    if (user.role === 'staff') {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    const db = c.env.DB;

    if (c.request.method === 'GET') {
      let query = 'SELECT id, username, role, display_name, office_id, active, created_at FROM users WHERE 1=1';
      const params: unknown[] = [];

      // office_admin can only see users in their office
      if (user.role === 'office_admin') {
        query += ' AND office_id = ?';
        params.push(user.office_id);
      }

      query += ' ORDER BY id';
      const result = await db.prepare(query).bind(...params).all();
      return new Response(JSON.stringify(result.results), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'POST') {
      const body = await c.request.json<{ username: string; password: string; role: string; display_name?: string; office_id?: number }>();

      if (!body.username || !body.password) {
        return new Response(JSON.stringify({ error: 'username and password required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // office_admin can only create staff in their own office
      const role = user.role === 'office_admin' ? 'staff' : body.role || 'staff';
      const officeId = user.role === 'office_admin' ? user.office_id : body.office_id || null;

      const passwordHash = await hash(body.password);

      try {
        await db.prepare(
          'INSERT INTO users (username, password_hash, role, display_name, office_id) VALUES (?, ?, ?, ?, ?)'
        ).bind(body.username, passwordHash, role, body.display_name || '', officeId).run();

        return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      } catch (e: any) {
        if (e.message?.includes('UNIQUE')) {
          return new Response(JSON.stringify({ error: 'Username already exists' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
        }
        throw e;
      }
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
