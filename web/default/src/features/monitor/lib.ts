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
import type { TFunction } from 'i18next'
import type { MonitorStatus } from './types'

export const MONITOR_QUERY_KEY = ['monitor', 'availability'] as const

export const MONITOR_STATUS_META: Record<
  MonitorStatus,
  { label: string; className: string; dotClassName: string }
> = {
  normal: {
    label: 'Normal',
    className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    dotClassName: 'bg-emerald-500',
  },
  degraded: {
    label: 'Degraded',
    className: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    dotClassName: 'bg-amber-500',
  },
  abnormal: {
    label: 'Abnormal',
    className: 'bg-red-500/10 text-red-700 dark:text-red-300',
    dotClassName: 'bg-red-500',
  },
  disabled: {
    label: 'Disabled',
    className: 'bg-muted text-muted-foreground',
    dotClassName: 'bg-muted-foreground',
  },
  no_data: {
    label: 'No data',
    className: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
    dotClassName: 'bg-sky-500',
  },
}

export function formatMonitorPercent(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return '-'
  return `${(value * 100).toFixed(1)}%`
}

export function formatMonitorSeconds(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return '-'
  return `${value.toFixed(value >= 10 ? 1 : 2)}s`
}

export function monitorStatusLabel(status: MonitorStatus, t: TFunction) {
  return t(MONITOR_STATUS_META[status]?.label ?? 'Unknown')
}
