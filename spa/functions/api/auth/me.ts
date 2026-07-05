import type { Env } from '../../_lib/types';

export const onRequest: PagesFunction<Env>[] = [
  async (c) => {
    const user = c.data.user;
    return new Response(JSON.stringify({
      id: user.sub,
      username: user.username,
      role: user.role,
      office_id: user.office_id,
      display_name: user.display_name,
    }), { headers: { 'Content-Type': 'application/json' } });
  }
];
