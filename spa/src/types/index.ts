export interface User {
  id: number
  username: string
  role: string
  office_id?: number | null
  display_name?: string
}

export interface Device {
  id: string
  device_id: string
  name: string
  floor?: number
  location?: string
  status: 'online' | 'offline' | 'warning' | 'alarm' | 'maintenance'
  last_seen: number
  hotel_id?: number
  pending_alerts?: number
}

export interface Telemetry {
  device_id: string
  device_name?: string
  ph: number
  ec: number
  tds: number
  water_temp: number  // mapped from temp field
  temp: number        // our backend uses "temp"
  water_level?: number
  ndvi?: number
  spectral_red?: number
  spectral_green?: number
  spectral_blue?: number
  spectral_nir?: number
  relay1?: number
  relay2?: number
  led?: number        // our backend uses "led" for LED state
  ts_ms?: number
  esp32_ms?: number
  do_ms?: number
  created_at: number
}

export interface Alert {
  id: number
  device_id: string
  type: string
  message: string
  severity: 'info' | 'warning' | 'critical'
  acknowledged: number
  hotel_id?: number
  created_at: number
  device_name?: string
}

export interface Task {
  id: number
  device_id: string | null
  personnel_id: number | null
  type: 'inspection' | 'nutrient' | 'calibration' | 'maintenance'
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  notes: string
  hotel_id: number
  created_at: number
  completed_at: number | null
  device_name?: string
  personnel_name?: string
}

export interface DashboardStats {
  online_devices: number
  total_devices: number
  today_alerts: number
  avg_ph: number
  avg_temp: number
  avg_ndvi: number
  avg_ec?: number
  device_distribution: { status: string; count: number }[]
  recent_alerts: Alert[]
  water_quality_trend: { date: string; ph: number; temp: number }[]
}
export interface LoginResponse {
  token: string
  user: User
}

export interface Office {
  id: number
  name: string
  contact_person: string
  contact_phone: string
  whatsapp_number: string
  notes: string
  active: number
  created_at: number
  rack_count?: number
}

export interface Rack {
  id: number
  name: string
  office_id: number
  device_id: string | null
  location: string
  status: 'active' | 'inactive' | 'maintenance'
  layer_count: number
  created_at: number
  office_name?: string
  device_name?: string
  vegetables?: RackVegetable[]
  latest_environment?: RackEnvironment
}

export interface RackVegetable {
  id: number
  rack_id: number
  layer_number: number
  variety: string
  quantity: number
  planted_at: number
  notes: string
  created_at: number
}

export interface RackEnvironment {
  id: number
  rack_id: number
  temperature: number | null
  humidity: number | null
  light_level: number | null
  ph: number | null
  ec: number | null
  source: 'manual' | 'telemetry'
  recorded_at: number
  created_at: number
}

export interface Automation {
  id: number
  name: string
  type: 'daily_report' | 'env_check' | 'nutrient_reminder' | 'harvest_reminder' | 'custom'
  cron_expr: string
  config: string
  office_id: number | null
  enabled: number
  last_run_at: number | null
  created_at: number
  office_name?: string
}
