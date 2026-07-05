import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const db = c.env.DB;
    const id = c.params.id as string;

    if (c.request.method === 'PUT') {
      const body = await c.request.json<{ name?: string; contact_person?: string; contact_phone?: string; whatsapp_number?: string; notes?: string }>();
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.name !== undefined) { sets.push('name = ?'); params.push(body.name); }
      if (body.contact_person !== undefined) { sets.push('contact_person = ?'); params.push(body.contact_person); }
      if (body.contact_phone !== undefined) { sets.push('contact_phone = ?'); params.push(body.contact_phone); }
      if (body.whatsapp_number !== undefined) { sets.push('whatsapp_number = ?'); params.push(body.whatsapp_number); }
      if (body.notes !== undefined) { sets.push('notes = ?'); params.push(body.notes); }
      if (sets.length === 0) {
        return new Response(JSON.stringify({ error: 'No fields to update' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      params.push(id);
      await db.prepare(`UPDATE offices SET ${sets.join(', ')} WHERE id = ? AND active = 1`).bind(...params).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (c.request.method === 'DELETE') {
      await db.prepare(`UPDATE offices SET active = 0 WHERE id = ?`).bind(id).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
];
