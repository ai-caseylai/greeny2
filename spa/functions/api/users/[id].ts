import { hash } from '../../_lib/password';
import type { Env, JwtPayload } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const user = c.data.user as JwtPayload;
    if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

    if (user.role === 'staff') {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    const url = new URL(c.request.url);
    const id = parseInt(url.pathname.split('/').pop()!);
    const db = c.env.DB;

    // Verify target user is in scope
    const target = await db.prepare('SELECT id, office_id FROM users WHERE id = ?').bind(id).first<{ id: number; office_id: number | null }>();
    if (!target) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

    if (user.role === 'office_admin' && target.office_id !== user.office_id) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'PATCH') {
      const body = await c.request.json<{ role?: string; display_name?: string; password?: string; office_id?: number; active?: number }>();
      const updates: string[] = [];
      const params: unknown[] = [];

      if (body.display_name !== undefined) { updates.push('display_name = ?'); params.push(body.display_name); }
      if (body.password) {
        updates.push('password_hash = ?');
        params.push(await hash(body.password));
      }
      if (user.role === 'superadmin') {
        if (body.role) { updates.push('role = ?'); params.push(body.role); }
        if (body.office_id !== undefined) { updates.push('office_id = ?'); params.push(body.office_id); }
      }
      if (body.active !== undefined) { updates.push('active = ?'); params.push(body.active); }

      if (updates.length === 0) {
        return new Response(JSON.stringify({ error: 'No fields to update' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      params.push(id);
      await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'DELETE') {
      await db.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(id).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
