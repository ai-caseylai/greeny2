export interface Env {
  DB: D1Database;
  API_KEY: string;
  /**
   * @deprecated No longer used for signing/verifying JWTs. The JWT secret is
   * read from the D1 `settings` table (key = `jwt_secret`) via `getJwtSecret()`
   * so that it is never a publicly known value committed to this repo.
   */
  JWT_SECRET?: string;
  WB_API_KEY: string;
  WORKBUDDY_API_URL: string;
  WORKBUDDY_API_KEY: string;
}

export interface JwtPayload {
  sub: number;
  username: string;
  role: 'superadmin' | 'office_admin' | 'staff';
  office_id: number | null;
  display_name: string;
}
