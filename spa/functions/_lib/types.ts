export interface Env {
  DB: D1Database;
  API_KEY: string;
  JWT_SECRET: string;
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
