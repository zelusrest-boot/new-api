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
import { api } from '@/lib/api'
import type {
  ProfitChannelMultiplierRule,
  ProfitExcludedUser,
  ProfitOverviewData,
  QuotaDataItem,
  UptimeGroupResult,
} from './types'

// ============================================================================
// Dashboard APIs
// ============================================================================

// ----------------------------------------------------------------------------
// Quota & Usage Data
// ----------------------------------------------------------------------------

// Get user quota data within a time range
// Admin users get all users' data by default (matching classic frontend behavior)
export async function getUserQuotaDates(
  params: {
    start_timestamp: number
    end_timestamp: number
    default_time?: string
    username?: string
  },
  isAdmin = false
) {
  const endpoint = isAdmin ? '/api/data' : '/api/data/self'
  const res = await api.get<{ success: boolean; data: QuotaDataItem[] }>(
    endpoint,
    { params }
  )
  return res.data
}

export async function getProfitOverview(params: {
  start_timestamp: number
  end_timestamp: number
}) {
  const res = await api.get<{ success: boolean; data: ProfitOverviewData }>(
    '/api/data/profit',
    { params }
  )
  return res.data
}

export async function updateProfitProviderMultipliers(
  rules: ProfitChannelMultiplierRule[]
) {
  const res = await api.put<{
    success: boolean
    message: string
    data: {
      multipliers: Record<string, number>
      rules: ProfitChannelMultiplierRule[]
    }
  }>('/api/data/profit/multipliers', { rules })
  return res.data
}

export async function updateProfitExcludedUsers(users: ProfitExcludedUser[]) {
  const res = await api.put<{
    success: boolean
    message: string
    data: ProfitExcludedUser[]
  }>('/api/data/profit/excluded-users', { users })
  return res.data
}

// ----------------------------------------------------------------------------
// System Monitoring
// ----------------------------------------------------------------------------

export async function getUserQuotaDataByUsers(params: {
  start_timestamp: number
  end_timestamp: number
}) {
  const res = await api.get<{ success: boolean; data: QuotaDataItem[] }>(
    '/api/data/users',
    { params }
  )
  return res.data
}

// Get uptime monitoring status for all services
export async function getUptimeStatus() {
  const res = await api.get<{ success: boolean; data: UptimeGroupResult[] }>(
    '/api/uptime/status'
  )
  return res.data
}
