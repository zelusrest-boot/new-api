/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
export type MonitorStatus =
  | 'normal'
  | 'degraded'
  | 'abnormal'
  | 'disabled'
  | 'no_data'

export interface MonitorAvailabilityParams {
  q?: string
  group?: string
  channel_type?: number
  status?: MonitorStatus | 'all'
}

export interface MonitorAvailabilitySummary {
  channels: number
  models: number
  normal: number
  abnormal: number
  disabled: number
  no_data: number
  availability_3h: number
  total_requests_3h: number
  success_requests_3h: number
  error_requests_3h: number
  recent_window_minutes: number
  updated_at: number
}

export interface MonitorAvailabilityOption {
  value: string
  label: string
}

export interface MonitorAvailabilityBucket {
  start_at: number
  total: number
  success: number
  error: number
  status: MonitorStatus | 'empty'
}

export interface MonitorAvailabilityItem {
  channel_id: number
  channel_name: string
  channel_type: number
  channel_type_name: string
  channel_status: number
  channel_response_time_ms: number
  channel_test_time: number
  model_name: string
  groups: string[]
  ability_enabled: boolean
  status: MonitorStatus
  availability_3h: number
  availability_15m: number
  total_requests_3h: number
  success_requests_3h: number
  error_requests_3h: number
  total_requests_15m: number
  success_requests_15m: number
  error_requests_15m: number
  average_latency_seconds?: number | null
  average_first_byte_seconds?: number | null
  last_checked_at: number
  recent_buckets: MonitorAvailabilityBucket[]
}

export interface MonitorAvailabilityData {
  summary: MonitorAvailabilitySummary
  items: MonitorAvailabilityItem[]
  groups: MonitorAvailabilityOption[]
  channel_types: MonitorAvailabilityOption[]
  statuses: MonitorAvailabilityOption[]
}

export interface MonitorAvailabilityResponse {
  success: boolean
  message?: string
  data?: MonitorAvailabilityData
}
