-- ─────────────────────────────────────────────────────────────────────────────
-- Greeny2 — D1 (`greeny-db`) schema
--
-- ⚠️ 本檔由**線上 D1 實際結構**產生（2026-10-13），是權威版本。
--    舊版曾寫著 `users.salt` 欄位，但線上根本沒有該欄位 ——
--    照舊版建表會讓 Worker 的登入查詢失敗。請以此檔為準。
--
-- 資料庫：greeny-db  (id 7191a23e-c43b-4962-b3fb-96818ac2d07c)
-- 套用：  npx wrangler d1 execute greeny-db --remote --file edge/db/schema.sql
--
-- 注意：`settings` 表的 `jwt_secret` 與 `device_token` 是**運行時機密**，
--       必須用 `INSERT ... ON CONFLICT` 單獨設定，**不要寫進本檔**。
--
-- DO-local SQLite（telemetry_buffer / relay_queue / alert_buffer /
-- device_state / relay_log_buffer）不在本檔 —— 那些由 DeviceHub 的
-- constructor 自行建立，見 edge/src/device-hub.ts 與 edge/EDGE.md。
-- ─────────────────────────────────────────────────────────────────────────────

-- alerts
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL REFERENCES devices(id),
    type TEXT NOT NULL DEFAULT 'ph_abnormal' CHECK (type IN ('ph_abnormal', 'ec_high', 'temp_abnormal', 'do_low', 'offline', 'water_low', 'leak')),
    message TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
    acknowledged INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- automations
CREATE TABLE IF NOT EXISTS automations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('daily_report','env_check','nutrient_reminder','harvest_reminder','custom')),
    cron_expr TEXT NOT NULL DEFAULT '',
    config TEXT NOT NULL DEFAULT '{}',
    office_id INTEGER REFERENCES offices(id),
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- crop_batches
CREATE TABLE IF NOT EXISTS crop_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    office_id INTEGER NOT NULL REFERENCES offices(id),
    rack_id INTEGER REFERENCES racks(id),
    layer_number INTEGER,
    variety TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    unit TEXT NOT NULL DEFAULT '株' CHECK (unit IN ('株','盆','公斤','克')),
    status TEXT NOT NULL DEFAULT 'growing' CHECK (status IN ('growing','ready','harvested','failed')),
    seeded_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expected_harvest_days INTEGER NOT NULL DEFAULT 30,
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- devices
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    floor INTEGER NOT NULL DEFAULT 1,
    location TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'warning', 'alarm', 'maintenance')),
    last_seen INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- harvest_logs
CREATE TABLE IF NOT EXISTS harvest_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL REFERENCES crop_batches(id),
    quantity INTEGER NOT NULL DEFAULT 0,
    unit TEXT NOT NULL DEFAULT '株',
    quality TEXT NOT NULL DEFAULT 'good' CHECK (quality IN ('excellent','good','fair','poor')),
    notes TEXT NOT NULL DEFAULT '',
    harvested_at INTEGER NOT NULL DEFAULT (unixepoch()),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- offices
CREATE TABLE IF NOT EXISTS offices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contact_person TEXT NOT NULL DEFAULT '',
    contact_phone TEXT NOT NULL DEFAULT '',
    whatsapp_number TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- rack_environment
CREATE TABLE IF NOT EXISTS rack_environment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rack_id INTEGER NOT NULL REFERENCES racks(id),
    temperature REAL,
    humidity REAL,
    light_level REAL,
    ph REAL,
    ec REAL,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','telemetry')),
    recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- rack_vegetables
CREATE TABLE IF NOT EXISTS rack_vegetables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rack_id INTEGER NOT NULL REFERENCES racks(id),
    layer_number INTEGER NOT NULL,
    variety TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    planted_at INTEGER NOT NULL DEFAULT (unixepoch()),
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- racks
CREATE TABLE IF NOT EXISTS racks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    office_id INTEGER NOT NULL REFERENCES offices(id),
    device_id TEXT REFERENCES devices(id),
    location TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','maintenance')),
    layer_count INTEGER NOT NULL DEFAULT 3,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- relay_log
CREATE TABLE IF NOT EXISTS relay_log (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, relay1 INTEGER, relay2 INTEGER, ph_cal REAL, status TEXT DEFAULT 'sent', created_at INTEGER DEFAULT (unixepoch()));

-- relay_queue
CREATE TABLE IF NOT EXISTS relay_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  relay1 INTEGER,
  relay2 INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
, ph_cal REAL);

-- settings
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- telemetry
CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL REFERENCES devices(id),
    ph REAL NOT NULL DEFAULT 0.0,
    ec REAL NOT NULL DEFAULT 0.0,
    water_temp REAL NOT NULL DEFAULT 0.0,
    do_value REAL NOT NULL DEFAULT 0.0,
    water_level REAL NOT NULL DEFAULT 0.0,
    ts_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
, ndvi REAL NOT NULL DEFAULT 0.0, spectral_red REAL NOT NULL DEFAULT 0.0, spectral_green REAL NOT NULL DEFAULT 0.0, spectral_blue REAL NOT NULL DEFAULT 0.0, spectral_nir REAL NOT NULL DEFAULT 0.0, relay1 INTEGER NOT NULL DEFAULT 0, relay2 INTEGER NOT NULL DEFAULT 0, tds REAL NOT NULL DEFAULT 0.0, ip TEXT NOT NULL DEFAULT '', ap_ssid TEXT NOT NULL DEFAULT '', ap_bssid TEXT NOT NULL DEFAULT '', rssi INTEGER NOT NULL DEFAULT 0);

-- users
CREATE TABLE IF NOT EXISTS "users" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('superadmin', 'office_admin', 'staff')),
    display_name TEXT NOT NULL DEFAULT '',
    office_id INTEGER REFERENCES offices(id),
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_device ON alerts(device_id);
CREATE INDEX IF NOT EXISTS idx_crop_batches_office ON crop_batches(office_id);
CREATE INDEX IF NOT EXISTS idx_crop_batches_rack ON crop_batches(rack_id);
CREATE INDEX IF NOT EXISTS idx_crop_batches_status ON crop_batches(status);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
CREATE INDEX IF NOT EXISTS idx_harvest_logs_batch ON harvest_logs(batch_id);
CREATE INDEX IF NOT EXISTS idx_offices_active ON offices(active);
CREATE INDEX IF NOT EXISTS idx_rack_env_rack ON rack_environment(rack_id);
CREATE INDEX IF NOT EXISTS idx_rack_veg_layer ON rack_vegetables(rack_id, layer_number);
CREATE INDEX IF NOT EXISTS idx_rack_veg_rack ON rack_vegetables(rack_id);
CREATE INDEX IF NOT EXISTS idx_racks_device ON racks(device_id);
CREATE INDEX IF NOT EXISTS idx_racks_office ON racks(office_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_created ON telemetry(created_at);
CREATE INDEX IF NOT EXISTS idx_telemetry_device ON telemetry(device_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_device_ts ON telemetry(device_id, ts_ms);
CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry(ts_ms);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- ── 必要的 secrets（值不可寫進版控）─────────────────────────────────────────
-- INSERT INTO settings (key, value) VALUES ('jwt_secret', '<64 hex>')
--   ON CONFLICT(key) DO UPDATE SET value = excluded.value;
-- INSERT INTO settings (key, value) VALUES ('device_token', '<48 hex>')
--   ON CONFLICT(key) DO UPDATE SET value = excluded.value;
