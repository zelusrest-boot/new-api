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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarDays,
  Loader2,
  Plus,
  ReceiptText,
  RotateCcw,
  Save,
} from 'lucide-react'
import type { DateRange as CalendarDateRange } from 'react-day-picker'
import { enUS, fr, ja, ru, vi, zhCN } from 'react-day-picker/locale'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { getEndOfDay, getRollingDateRange, getStartOfDay } from '@/lib/time'
import {
  formatCompactNumber,
  formatDateTimeStr,
  formatNumber,
  formatQuota,
} from '@/lib/format'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  getProfitOverview,
  updateProfitExcludedUsers,
  updateProfitProviderMultipliers,
} from '@/features/dashboard/api'
import { getChannel, getChannels } from '@/features/channels/api'
import { TIME_RANGE_PRESETS } from '@/features/dashboard/constants'
import type { Channel } from '@/features/channels/types'
import type {
  ProfitChannelMultiplierRule,
  ProfitExcludedUser,
  ProfitOverviewData,
  ProfitOverviewItem,
  ProfitOverviewTrendItem,
} from '@/features/dashboard/types'

const MAX_PROVIDER_MULTIPLIER = 10
const PROFIT_ROW_LIMIT = 25
const PROFIT_OVERVIEW_QUERY_KEY = ['dashboard', 'profit-overview'] as const
const ALL_VALUE = '__all__'
const CHANNEL_MULTIPLIER_SEPARATOR = '::'
const DEFAULT_PROFIT_RANGE_DAYS =
  TIME_RANGE_PRESETS[TIME_RANGE_PRESETS.length - 1]?.days ?? 29
const calendarLocales = {
  en: enUS,
  zh: zhCN,
  fr,
  ru,
  ja,
  vi,
} as const

const EMPTY_PROFIT_DATA: ProfitOverviewData = {
  items: [],
  groups: [],
  providers: [],
  trends: [],
  multipliers: {},
  multiplier_rules: [],
  excluded_users: [],
}

type ProviderMultipliers = Record<string, ProfitChannelMultiplierRule>
type ProfitStatus = 'all' | 'profitable' | 'loss'
type ProfitDateRange = { start: Date; end: Date }

interface ProfitProviderRow {
  providerType: number
  providerName: string
  groupName: string
  multiplier: number
  revenueQuota: number
  estimatedCostQuota: number
  grossProfitQuota: number
  profitMargin: number
  requestCount: number
  tokenCount: number
  revenueShare: number
  saved: boolean
}

interface ProfitOverviewRow extends ProfitProviderRow {
  channelId: number
  channelName: string
  modelName: string
  averageRevenueQuota: number
}

interface ProfitChannelOption {
  providerType: number
  providerName: string
  groupName: string
  channelId: number
  channelName: string
  revenueQuota: number
  requestCount: number
  tokenCount: number
}

interface ProfitChannelSelectOption {
  channelId: number
  channelName: string
}

interface ProfitMultiplierRuleRow extends ProfitChannelOption {
  multiplier: number | null
  effectiveAt: number | null
  note?: string
  saved: boolean
}

interface ProfitProviderOption {
  value: string
  label: string
  type: string
}

interface ProfitTrendPoint {
  key: string
  label: string
  revenueQuota: number
  estimatedCostQuota: number
  grossProfitQuota: number
}

type ExcludedUserRow = ProfitExcludedUser

function normalizeExcludedUsers(
  users: ProfitExcludedUser[] | undefined
): ExcludedUserRow[] {
  if (!users) return []
  const seen = new Set<string>()
  return users.flatMap((user) => {
    const username = user.username?.trim()
    if (!username) return []
    const key = username.toLowerCase()
    if (seen.has(key)) return []
    seen.add(key)
    return [{
      username,
      reason: user.reason?.trim() || '-',
      effective_time: user.effective_time || '',
      affected_requests: Number(user.affected_requests) || 0,
    }]
  })
}

function getGroupName(item: Pick<ProfitOverviewItem, 'group'>) {
  return item.group?.trim() || 'default'
}

function providerKey(groupName: string) {
  return groupName || 'default'
}

function channelMultiplierKey(groupName: string, channelId: number) {
  return `${providerKey(groupName)}${CHANNEL_MULTIPLIER_SEPARATOR}${channelId}`
}

function parseChannelMultiplierKey(key: string) {
  const separatorIndex = key.lastIndexOf(CHANNEL_MULTIPLIER_SEPARATOR)
  if (separatorIndex <= 0) return null

  const groupName = key.slice(0, separatorIndex).trim()
  const channelId = Number(
    key.slice(separatorIndex + CHANNEL_MULTIPLIER_SEPARATOR.length)
  )
  if (!groupName || !Number.isInteger(channelId) || channelId <= 0) {
    return null
  }
  return { groupName, channelId }
}

function clampProviderMultiplier(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(
    MAX_PROVIDER_MULTIPLIER,
    Math.max(0, Number(value.toFixed(4)))
  )
}

function getChannelMultiplier(
  multipliers: ProviderMultipliers,
  groupName: string,
  channelId: number
) {
  return multipliers[channelMultiplierKey(groupName, channelId)]?.multiplier
}

function getChannelMultiplierRule(
  multipliers: ProviderMultipliers,
  groupName: string,
  channelId: number
) {
  return multipliers[channelMultiplierKey(groupName, channelId)]
}

function normalizeMultiplierRules(
  rules: ProfitChannelMultiplierRule[] | undefined,
  legacyMultipliers?: Record<string, number>
): ProfitChannelMultiplierRule[] {
  const sourceRules: ProfitChannelMultiplierRule[] =
    rules !== undefined
      ? rules
      : Object.entries(legacyMultipliers ?? {}).map(([key, multiplier]) => ({
          key,
          multiplier,
          effective_at: 0,
        }))

  const normalized: ProfitChannelMultiplierRule[] = []
  sourceRules.forEach((rule) => {
    const parsed = parseChannelMultiplierKey(rule.key.trim())
    const multiplier = clampProviderMultiplier(Number(rule.multiplier))
    const effectiveAt = Number(rule.effective_at) || 0
    if (!parsed || !Number.isFinite(Number(rule.multiplier)) || effectiveAt < 0) {
      return
    }
    normalized.push({
      key: channelMultiplierKey(parsed.groupName, parsed.channelId),
      multiplier,
      effective_at: effectiveAt,
      note: rule.note?.trim() || undefined,
    })
  })

  return normalized.sort((a, b) => {
    if (a.key === b.key) return a.effective_at - b.effective_at
    return a.key.localeCompare(b.key)
  })
}

function latestMultiplierRulesByKey(
  rules: ProfitChannelMultiplierRule[] | undefined
): ProviderMultipliers {
  const latest: ProviderMultipliers = {}
  normalizeMultiplierRules(rules).forEach((rule) => {
    const existing = latest[rule.key]
    if (!existing || rule.effective_at >= existing.effective_at) {
      latest[rule.key] = rule
    }
  })
  return latest
}

function buildDefaultDateRange(days: number): ProfitDateRange {
  const { start, end } = getRollingDateRange(days)
  return { start: getStartOfDay(start), end: getEndOfDay(end) }
}

function buildTimeRangeFromDates(range: ProfitDateRange) {
  return {
    start_timestamp: Math.floor(getStartOfDay(range.start).getTime() / 1000),
    end_timestamp: Math.floor(getEndOfDay(range.end).getTime() / 1000),
  }
}

function getCostTone(value: number) {
  if (value >= 30) return 'text-emerald-600 dark:text-emerald-400'
  if (value >= 10) return 'text-amber-600 dark:text-amber-400'
  return 'text-destructive'
}

function getProfitTone(value: number) {
  if (value >= 0) return 'text-emerald-600 dark:text-emerald-400'
  return 'text-destructive'
}

function getModelName(item: ProfitOverviewItem) {
  return item.model_name || 'Unknown'
}

function getChannelName(item: Pick<ProfitOverviewItem, 'channel_id' | 'channel_name'>) {
  if (item.channel_name) return item.channel_name
  if (item.channel_id > 0) return `#${item.channel_id}`
  return '-'
}

function formatMultiplier(value: number) {
  return `${formatNumber(value)}x`
}

function formatDateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatDateLabel(dateKey: string) {
  const parts = dateKey.split('-')
  if (parts.length === 3) return `${parts[1]}/${parts[2]}`
  return dateKey
}

function formatDatePickerLabel(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${month}/${day}`
}

function getEffectiveQuota(
  item: Pick<ProfitOverviewItem | ProfitOverviewTrendItem, 'effective_quota'>
) {
  return Number(item.effective_quota) || 0
}

function getEstimatedCostQuota(
  item: Pick<ProfitOverviewItem | ProfitOverviewTrendItem, 'estimated_cost_quota'>
) {
  return Number(item.estimated_cost_quota) || 0
}

function getEffectiveRequestCount(
  item: Pick<ProfitOverviewItem | ProfitOverviewTrendItem, 'effective_request_count'>
) {
  return Number(item.effective_request_count) || 0
}

function buildCalculatedProviderRow(
  item: ProfitOverviewItem,
  totalRevenueQuota: number
): ProfitProviderRow {
  const revenueQuota = getEffectiveQuota(item)
  const groupName = getGroupName(item)
  const estimatedCostQuota = getEstimatedCostQuota(item)
  const grossProfitQuota = revenueQuota - estimatedCostQuota
  const profitMargin =
    revenueQuota > 0 ? (grossProfitQuota / revenueQuota) * 100 : 0
  const multiplier = revenueQuota > 0 ? estimatedCostQuota / revenueQuota : 0

  return {
    providerType: item.provider_type,
    providerName: groupName,
    groupName,
    multiplier,
    revenueQuota,
    estimatedCostQuota,
    grossProfitQuota,
    profitMargin,
    requestCount: getEffectiveRequestCount(item),
    tokenCount: Number(item.total_tokens) || 0,
    revenueShare:
      totalRevenueQuota > 0 ? (revenueQuota / totalRevenueQuota) * 100 : 0,
    saved: revenueQuota > 0,
  }
}

function deriveProviders(items: ProfitOverviewItem[]) {
  const providers = new Map<string, ProfitOverviewItem>()

  items.forEach((item) => {
    const groupName = getGroupName(item)
    const existing = providers.get(groupName)
    if (!existing) {
      providers.set(groupName, {
        ...item,
        group: groupName,
        channel_id: 0,
        channel_name: '',
        model_name: '',
      })
      return
    }

    existing.quota += Number(item.quota) || 0
    existing.effective_quota =
      (Number(existing.effective_quota) || 0) + getEffectiveQuota(item)
    existing.estimated_cost_quota =
      (Number(existing.estimated_cost_quota) || 0) +
      getEstimatedCostQuota(item)
    existing.request_count += Number(item.request_count) || 0
    existing.effective_request_count =
      (Number(existing.effective_request_count) || 0) +
      getEffectiveRequestCount(item)
    existing.prompt_tokens += Number(item.prompt_tokens) || 0
    existing.completion_tokens += Number(item.completion_tokens) || 0
    existing.total_tokens += Number(item.total_tokens) || 0
    existing.first_request_at =
      existing.first_request_at === 0
        ? item.first_request_at
        : Math.min(existing.first_request_at, item.first_request_at)
    existing.last_request_at = Math.max(
      existing.last_request_at,
      item.last_request_at
    )
  })

  return Array.from(providers.values())
}

function buildChannelOptions(items: ProfitOverviewItem[]) {
  const channels = new Map<string, ProfitChannelOption>()

  items.forEach((item) => {
    const channelId = Number(item.channel_id) || 0
    if (channelId <= 0) return

    const groupName = getGroupName(item)
    const key = channelMultiplierKey(groupName, channelId)
    const existing = channels.get(key)
    if (!existing) {
      channels.set(key, {
        providerType: item.provider_type,
        providerName: groupName,
        groupName,
        channelId,
        channelName: getChannelName(item),
        revenueQuota: Number(item.quota) || 0,
        requestCount: Number(item.request_count) || 0,
        tokenCount: Number(item.total_tokens) || 0,
      })
      return
    }

    existing.revenueQuota += Number(item.quota) || 0
    existing.requestCount += Number(item.request_count) || 0
    existing.tokenCount += Number(item.total_tokens) || 0
  })

  return Array.from(channels.values()).sort((a, b) => {
    const groupOrder = a.groupName.localeCompare(b.groupName)
    if (groupOrder !== 0) return groupOrder
    return a.channelName.localeCompare(b.channelName)
  })
}

function buildChannelsFromCatalog(channels: Channel[]) {
  const options = new Map<string, ProfitChannelOption>()

  channels.forEach((channel) => {
    const channelId = Number(channel.id) || 0
    if (channelId <= 0) return

    const groupName = channel.group?.trim() || 'default'
    const key = channelMultiplierKey(groupName, channelId)
    if (options.has(key)) return

    options.set(key, {
      providerType: Number(channel.type) || 0,
      providerName: groupName,
      groupName,
      channelId,
      channelName: channel.name?.trim() || `#${channelId}`,
      revenueQuota: 0,
      requestCount: 0,
      tokenCount: 0,
    })
  })

  return Array.from(options.values()).sort((a, b) => {
    const groupOrder = a.groupName.localeCompare(b.groupName)
    if (groupOrder !== 0) return groupOrder
    return a.channelName.localeCompare(b.channelName)
  })
}

function mergeChannelOptions(
  baseChannels: ProfitChannelOption[],
  catalogChannels: ProfitChannelOption[],
  multipliers: ProviderMultipliers
) {
  const channels = new Map<string, ProfitChannelOption>()
  const channelsById = new Map<number, ProfitChannelOption>()

  ;[...catalogChannels, ...baseChannels].forEach((channel) => {
    const existingById = channelsById.get(channel.channelId)
    if (
      !existingById ||
      existingById.channelName.startsWith('#') ||
      channel.requestCount > existingById.requestCount
    ) {
      channelsById.set(channel.channelId, channel)
    }
    channels.set(channelMultiplierKey(channel.groupName, channel.channelId), {
      ...channels.get(channelMultiplierKey(channel.groupName, channel.channelId)),
      ...channel,
    })
  })

  Object.values(multipliers).forEach((rule) => {
    const parsed = parseChannelMultiplierKey(rule.key)
    if (!parsed) return
    const key = channelMultiplierKey(parsed.groupName, parsed.channelId)
    if (channels.has(key)) return
    const knownChannel = channelsById.get(parsed.channelId)
    channels.set(key, {
      providerType: knownChannel?.providerType ?? 0,
      providerName: parsed.groupName,
      groupName: parsed.groupName,
      channelId: parsed.channelId,
      channelName: knownChannel?.channelName ?? `#${parsed.channelId}`,
      revenueQuota: 0,
      requestCount: 0,
      tokenCount: 0,
    })
  })

  return Array.from(channels.values()).sort((a, b) => {
    const groupOrder = a.groupName.localeCompare(b.groupName)
    if (groupOrder !== 0) return groupOrder
    return a.channelName.localeCompare(b.channelName)
  })
}

function buildChannelSelectOptions(
  channels: ProfitChannelOption[],
  selectedProvider: string
): ProfitChannelSelectOption[] {
  const channelsById = new Map<number, ProfitChannelOption>()

  channels.forEach((channel) => {
    if (
      selectedProvider !== ALL_VALUE &&
      providerKey(channel.groupName) !== selectedProvider
    ) {
      return
    }

    const existing = channelsById.get(channel.channelId)
    if (!existing) {
      channelsById.set(channel.channelId, channel)
      return
    }

    const existingHasUsage =
      existing.requestCount > 0 || existing.revenueQuota > 0 || existing.tokenCount > 0
    const channelHasUsage =
      channel.requestCount > 0 || channel.revenueQuota > 0 || channel.tokenCount > 0
    if (!existingHasUsage && channelHasUsage) {
      channelsById.set(channel.channelId, channel)
    }
  })

  const dedupedChannels = Array.from(channelsById.values()).sort((a, b) => {
    const nameOrder = a.channelName.localeCompare(b.channelName)
    if (nameOrder !== 0) return nameOrder
    return a.channelId - b.channelId
  })
  const nameCounts = dedupedChannels.reduce((counts, channel) => {
    const name = (channel.channelName.trim() || `#${channel.channelId}`).toLowerCase()
    counts.set(name, (counts.get(name) ?? 0) + 1)
    return counts
  }, new Map<string, number>())

  return dedupedChannels.map((channel) => {
    const name = channel.channelName.trim() || `#${channel.channelId}`
    const duplicatedName = (nameCounts.get(name.toLowerCase()) ?? 0) > 1
    return {
      channelId: channel.channelId,
      channelName: duplicatedName ? `${name} (#${channel.channelId})` : name,
    }
  })
}

function buildMultiplierRuleRows(
  channels: ProfitChannelOption[],
  multipliers: ProviderMultipliers
) {
  return channels.map((channel): ProfitMultiplierRuleRow => {
    const rule = getChannelMultiplierRule(
      multipliers,
      channel.groupName,
      channel.channelId
    )
    return {
      ...channel,
      multiplier: rule?.multiplier ?? null,
      effectiveAt: rule?.effective_at ?? null,
      note: rule?.note,
      saved: rule !== undefined,
    }
  })
}

function buildProviderRows(data: ProfitOverviewData) {
  const providers =
    (data.groups?.length ?? 0) > 0
      ? data.groups ?? []
      : data.providers.length > 0
        ? data.providers
        : deriveProviders(data.items)
  const totalRevenueQuota = providers.reduce(
    (sum, item) => sum + getEffectiveQuota(item),
    0
  )

  return providers
    .map((item): ProfitProviderRow =>
      buildCalculatedProviderRow(item, totalRevenueQuota)
    )
    .sort((a, b) => b.revenueQuota - a.revenueQuota)
}

function buildProviderOptions(data: ProfitOverviewData) {
  const providers =
    (data.groups?.length ?? 0) > 0
      ? data.groups ?? []
      : data.providers.length > 0
        ? data.providers
        : deriveProviders(data.items)

  return providers
    .map((item) => {
      const groupName = getGroupName(item)
      return {
        value: providerKey(groupName),
        label: groupName,
        type: groupName,
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
}

function mergeProviderOptions(
  dataOptions: ProfitProviderOption[],
  channelOptions: ProfitChannelOption[]
) {
  const options = new Map<string, ProfitProviderOption>()
  dataOptions.forEach((option) => {
    options.set(option.value, option)
  })
  channelOptions.forEach((channel) => {
    const value = providerKey(channel.groupName)
    if (options.has(value)) return
    options.set(value, {
      value,
      label: channel.groupName,
      type: channel.groupName,
    })
  })
  return Array.from(options.values()).sort((a, b) =>
    a.label.localeCompare(b.label)
  )
}

function buildProfitRows(
  items: ProfitOverviewItem[],
  totalRevenueQuota: number
) {
  return items
    .flatMap((item): ProfitOverviewRow[] => {
      const channelId = Number(item.channel_id) || 0
      if (channelId <= 0 || getEffectiveQuota(item) <= 0) return []

      const base = buildCalculatedProviderRow(item, totalRevenueQuota)
      return [{
        ...base,
        channelId,
        channelName: getChannelName(item),
        modelName: getModelName(item),
        averageRevenueQuota:
          base.requestCount > 0 ? base.revenueQuota / base.requestCount : 0,
      }]
    })
    .sort((a, b) => b.grossProfitQuota - a.grossProfitQuota)
}

function buildTrendPoints(
  trends: ProfitOverviewTrendItem[],
  startTimestamp: number,
  endTimestamp: number
) {
  const points = new Map<string, ProfitTrendPoint>()
  const start = new Date(startTimestamp * 1000)
  const end = new Date(endTimestamp * 1000)
  start.setHours(0, 0, 0, 0)
  end.setHours(0, 0, 0, 0)

  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const key = formatDateKey(cursor)
    points.set(key, {
      key,
      label: formatDateLabel(key),
      revenueQuota: 0,
      estimatedCostQuota: 0,
      grossProfitQuota: 0,
    })
  }

  trends.forEach((trend) => {
    const channelId = Number(trend.channel_id) || 0
    if (channelId <= 0 || getEffectiveQuota(trend) <= 0) return

    const key = trend.time
    const point =
      points.get(key) ??
      ({
        key,
        label: formatDateLabel(key),
        revenueQuota: 0,
        estimatedCostQuota: 0,
        grossProfitQuota: 0,
      } satisfies ProfitTrendPoint)
    const revenueQuota = getEffectiveQuota(trend)
    const estimatedCostQuota = getEstimatedCostQuota(trend)
    point.revenueQuota += revenueQuota
    point.estimatedCostQuota += estimatedCostQuota
    point.grossProfitQuota += revenueQuota - estimatedCostQuota
    points.set(key, point)
  })

  return Array.from(points.values()).slice(-12)
}

function ProfitMetricCard(props: {
  title: string
  value: string
  description: string
  loading?: boolean
  valueClassName?: string
}) {
  return (
    <Card size='sm' className='rounded-lg'>
      <CardContent className='min-h-24'>
        <div className='text-muted-foreground text-xs font-medium'>
          {props.title}
        </div>
        {props.loading ? (
          <div className='mt-3 space-y-2'>
            <Skeleton className='h-7 w-28' />
            <Skeleton className='h-3 w-36' />
          </div>
        ) : (
          <>
            <div
              className={cn(
                'mt-2 font-mono text-2xl font-bold tracking-tight tabular-nums',
                props.valueClassName
              )}
            >
              {props.value}
            </div>
            <div className='text-muted-foreground mt-1 text-xs'>
              {props.description}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function ProfitTrendChart({
  points,
  loading,
}: {
  points: ProfitTrendPoint[]
  loading: boolean
}) {
  const { t } = useTranslation()
  const maxValue = Math.max(
    1,
    ...points.flatMap((point) => [
      point.revenueQuota,
      point.estimatedCostQuota,
      Math.max(0, point.grossProfitQuota),
    ])
  )

  if (loading) {
    return <Skeleton className='h-72 w-full rounded-lg' />
  }

  return (
    <div className='h-72 min-w-[720px] px-3 pt-4 pb-3'>
      <div className='border-border/70 relative flex h-56 items-end gap-4 border-b border-l px-3'>
        <div className='pointer-events-none absolute inset-x-3 top-1/4 border-t border-dashed' />
        <div className='pointer-events-none absolute inset-x-3 top-1/2 border-t border-dashed' />
        <div className='pointer-events-none absolute inset-x-3 top-3/4 border-t border-dashed' />
        {points.map((point) => {
          const revenueHeight = Math.max(3, (point.revenueQuota / maxValue) * 100)
          const costHeight = Math.max(
            3,
            (point.estimatedCostQuota / maxValue) * 100
          )
          const profitHeight = Math.max(
            3,
            (Math.max(0, point.grossProfitQuota) / maxValue) * 100
          )

          return (
            <div
              key={point.key}
              className='relative z-10 flex min-w-10 flex-1 flex-col items-center justify-end gap-2'
              title={`${point.key} ${t('Revenue')}: ${formatQuota(point.revenueQuota)} / ${t('Estimated Cost')}: ${formatQuota(point.estimatedCostQuota)} / ${t('Gross Profit')}: ${formatQuota(point.grossProfitQuota)}`}
            >
              <div className='flex h-44 w-full items-end justify-center gap-1.5'>
                <div
                  className='w-3 rounded-t-sm bg-blue-500/75'
                  style={{ height: `${revenueHeight}%` }}
                />
                <div
                  className='w-3 rounded-t-sm bg-slate-400/80 dark:bg-slate-500/80'
                  style={{ height: `${costHeight}%` }}
                />
                <div
                  className={cn(
                    'w-3 rounded-t-sm',
                    point.grossProfitQuota >= 0
                      ? 'bg-emerald-500/80'
                      : 'bg-destructive/80'
                  )}
                  style={{ height: `${profitHeight}%` }}
                />
              </div>
              <div className='text-muted-foreground h-4 text-center text-[11px]'>
                {point.label}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ProfitDateRangePicker({
  value,
  onChange,
}: {
  value: ProfitDateRange
  onChange: (range: ProfitDateRange) => void
}) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [draftRange, setDraftRange] = useState<CalendarDateRange | undefined>(
    () => ({ from: value.start, to: value.end })
  )
  const calendarLocale =
    calendarLocales[i18n.language as keyof typeof calendarLocales] ?? enUS
  const label = `${formatDatePickerLabel(value.start)} - ${formatDatePickerLabel(value.end)}`

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setDraftRange({ from: value.start, to: value.end })
    }
    setOpen(nextOpen)
  }

  const applyRange = (range: ProfitDateRange) => {
    const startTime = range.start.getTime()
    const endTime = range.end.getTime()
    const orderedRange =
      startTime <= endTime
        ? range
        : { start: range.end, end: range.start }

    onChange({
      start: getStartOfDay(orderedRange.start),
      end: getEndOfDay(orderedRange.end),
    })
    setOpen(false)
  }

  const applyDraftRange = () => {
    const start = draftRange?.from
    if (!start) return
    applyRange({ start, end: draftRange?.to ?? start })
  }

  const applyPreset = (days: number) => {
    const range = buildDefaultDateRange(days)
    setDraftRange({ from: range.start, to: range.end })
    applyRange(range)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type='button'
            variant='outline'
            className='h-8 w-full justify-start gap-2 px-2.5 text-sm leading-5 font-normal tabular-nums sm:w-[13.5rem]'
            aria-label={t('Date Range')}
          />
        }
      >
        <CalendarDays className='text-muted-foreground size-4 shrink-0' />
        <span className='truncate'>{label}</span>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-[min(560px,calc(100vw-2rem))] p-3'
      >
        <div className='space-y-3'>
          <Calendar
            mode='range'
            selected={draftRange}
            onSelect={setDraftRange}
            numberOfMonths={2}
            captionLayout='dropdown'
            locale={calendarLocale}
            disabled={(date: Date) =>
              date > new Date() || date < new Date('1900-01-01')
            }
            className='mx-auto'
          />

          <div className='flex flex-wrap gap-1.5'>
            {TIME_RANGE_PRESETS.map((preset) => (
              <Button
                key={preset.days}
                type='button'
                variant='secondary'
                size='sm'
                className='h-7 flex-1 px-2 text-xs'
                onClick={() => applyPreset(preset.days)}
              >
                {t(preset.label)}
              </Button>
            ))}
          </div>

          <div className='flex justify-end'>
            <Button
              type='button'
              size='sm'
              className='h-8'
              disabled={!draftRange?.from}
              onClick={applyDraftRange}
            >
              {t('Confirm')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ProfitFilterBar({
  selectedDateRange,
  selectedProvider,
  selectedChannel,
  selectedStatus,
  providerOptions,
  channelOptions,
  onDateRangeChange,
  onProviderChange,
  onChannelChange,
  onStatusChange,
}: {
  selectedDateRange: ProfitDateRange
  selectedProvider: string
  selectedChannel: string
  selectedStatus: ProfitStatus
  providerOptions: Array<{ value: string; label: string }>
  channelOptions: Array<{ channelId: number; channelName: string }>
  onDateRangeChange: (range: ProfitDateRange) => void
  onProviderChange: (value: string) => void
  onChannelChange: (value: string) => void
  onStatusChange: (value: ProfitStatus) => void
}) {
  const { t } = useTranslation()

  return (
    <div className='flex flex-wrap items-center gap-2'>
      <ProfitDateRangePicker
        value={selectedDateRange}
        onChange={onDateRangeChange}
      />

      <NativeSelect
        size='sm'
        value={selectedProvider}
        onChange={(event) => onProviderChange(event.target.value)}
        className='w-40'
        aria-label={t('Group')}
      >
        <NativeSelectOption value={ALL_VALUE}>{t('All Groups')}</NativeSelectOption>
        {providerOptions.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>

      <NativeSelect
        size='sm'
        value={selectedChannel}
        onChange={(event) => onChannelChange(event.target.value)}
        className='w-44'
        aria-label={t('Channel')}
      >
        <NativeSelectOption value={ALL_VALUE}>
          {t('All Channels')}
        </NativeSelectOption>
        {channelOptions.map((channel) => (
          <NativeSelectOption
            key={channel.channelId}
            value={String(channel.channelId)}
          >
            {channel.channelName}
          </NativeSelectOption>
        ))}
      </NativeSelect>

      <NativeSelect
        size='sm'
        value={selectedStatus}
        onChange={(event) => onStatusChange(event.target.value as ProfitStatus)}
        className='w-40'
        aria-label={t('Profit Status')}
      >
        <NativeSelectOption value='all'>
          {t('All Profit Statuses')}
        </NativeSelectOption>
        <NativeSelectOption value='profitable'>
          {t('Profitable')}
        </NativeSelectOption>
        <NativeSelectOption value='loss'>{t('Loss')}</NativeSelectOption>
      </NativeSelect>
    </div>
  )
}

function CompactStat(props: {
  label: string
  value: string
  tone?: 'default' | 'success' | 'warning'
}) {
  return (
    <div className='rounded-lg border p-3'>
      <div className='text-muted-foreground text-xs'>{props.label}</div>
      <div
        className={cn(
          'mt-1 font-mono text-lg font-semibold',
          props.tone === 'success' && 'text-emerald-600 dark:text-emerald-400',
          props.tone === 'warning' && 'text-amber-600 dark:text-amber-400'
        )}
      >
        {props.value}
      </div>
    </div>
  )
}

function ProfitOverviewSkeleton() {
  return (
    <div className='space-y-3'>
      <Skeleton className='h-24 w-full rounded-lg' />
      <Skeleton className='h-80 w-full rounded-lg' />
      <Skeleton className='h-44 w-full rounded-lg' />
    </div>
  )
}

export function ProfitOverview() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const multiplierRulesRef = useRef<ProfitChannelMultiplierRule[]>([])
  const [selectedDateRange, setSelectedDateRange] =
    useState<ProfitDateRange>(() =>
      buildDefaultDateRange(DEFAULT_PROFIT_RANGE_DAYS)
    )
  const [timeRange, setTimeRange] = useState(() =>
    buildTimeRangeFromDates(buildDefaultDateRange(DEFAULT_PROFIT_RANGE_DAYS))
  )
  const [trendDateRange, setTrendDateRange] = useState<ProfitDateRange>(() =>
    buildDefaultDateRange(DEFAULT_PROFIT_RANGE_DAYS)
  )
  const [trendTimeRange, setTrendTimeRange] = useState(() =>
    buildTimeRangeFromDates(buildDefaultDateRange(DEFAULT_PROFIT_RANGE_DAYS))
  )
  const [providerMultipliers, setProviderMultipliers] =
    useState<ProviderMultipliers>({})
  const [selectedProvider, setSelectedProvider] = useState(ALL_VALUE)
  const [selectedChannel, setSelectedChannel] = useState(ALL_VALUE)
  const [selectedStatus, setSelectedStatus] = useState<ProfitStatus>('all')
  const [trendProvider, setTrendProvider] = useState(ALL_VALUE)
  const [trendChannel, setTrendChannel] = useState(ALL_VALUE)
  const [trendStatus, setTrendStatus] = useState<ProfitStatus>('all')
  const [draftProvider, setDraftProvider] = useState('')
  const [draftChannel, setDraftChannel] = useState('')
  const [draftMultiplier, setDraftMultiplier] = useState('')
  const [draftNote, setDraftNote] = useState('')
  const [multiplierDialogOpen, setMultiplierDialogOpen] = useState(false)
  const [excludedUserDialogOpen, setExcludedUserDialogOpen] = useState(false)
  const [excludedUsers, setExcludedUsers] = useState<ExcludedUserRow[]>([])
  const [draftExcludedUsername, setDraftExcludedUsername] = useState('')
  const [draftExcludedReason, setDraftExcludedReason] = useState('')

  const detailQuery = useQuery({
    queryKey: [...PROFIT_OVERVIEW_QUERY_KEY, 'detail', timeRange],
    queryFn: () => getProfitOverview(timeRange),
    select: (res) =>
      res.success
        ? res.data
        : EMPTY_PROFIT_DATA,
    staleTime: 60_000,
  })

  const trendQuery = useQuery({
    queryKey: [...PROFIT_OVERVIEW_QUERY_KEY, 'trend', trendTimeRange],
    queryFn: () => getProfitOverview(trendTimeRange),
    select: (res) =>
      res.success
        ? res.data
        : EMPTY_PROFIT_DATA,
    staleTime: 60_000,
  })

  const channelsQuery = useQuery({
    queryKey: ['dashboard', 'profit-overview', 'channels'],
    queryFn: () => getChannels({ p: 1, page_size: 100, id_sort: true }),
    select: (res) => (res.success ? res.data?.items ?? [] : []),
    staleTime: 60_000,
  })

  const updateMultipliersMutation = useMutation({
    mutationFn: (rules: ProfitChannelMultiplierRule[]) =>
      updateProfitProviderMultipliers(rules),
    onSuccess: (res) => {
      if (res.success) {
        const nextRules = normalizeMultiplierRules(
          res.data.rules,
          res.data.multipliers
        )
        const nextMultipliers = latestMultiplierRulesByKey(nextRules)
        multiplierRulesRef.current = nextRules
        setProviderMultipliers(nextMultipliers)
        queryClient.invalidateQueries({ queryKey: PROFIT_OVERVIEW_QUERY_KEY })
      } else if (res.message) {
        toast.error(res.message)
      }
    },
  })

  const updateExcludedUsersMutation = useMutation({
    mutationFn: (users: ExcludedUserRow[]) => updateProfitExcludedUsers(users),
    onSuccess: (res) => {
      if (res.success) {
        setExcludedUsers(normalizeExcludedUsers(res.data))
        queryClient.invalidateQueries({ queryKey: PROFIT_OVERVIEW_QUERY_KEY })
      } else if (res.message) {
        toast.error(res.message)
      }
    },
  })

  const profitData = detailQuery.data ?? EMPTY_PROFIT_DATA
  const trendData = trendQuery.data ?? EMPTY_PROFIT_DATA
  const catalogChannels = channelsQuery.data ?? []
  const multiplierChannelIds = useMemo(() => {
    const ids = new Set<number>()
    Object.values(providerMultipliers).forEach((rule) => {
      const parsed = parseChannelMultiplierKey(rule.key)
      if (parsed) ids.add(parsed.channelId)
    })
    return Array.from(ids).sort((a, b) => a - b)
  }, [providerMultipliers])

  const missingCatalogChannelIds = useMemo(() => {
    const knownIds = new Set(catalogChannels.map((channel) => Number(channel.id)))
    return multiplierChannelIds.filter((channelId) => !knownIds.has(channelId))
  }, [catalogChannels, multiplierChannelIds])

  const missingChannelsQuery = useQuery({
    queryKey: ['dashboard', 'profit-overview', 'missing-channels', missingCatalogChannelIds],
    queryFn: async () => {
      const results = await Promise.all(
        missingCatalogChannelIds.map(async (channelId) => {
          const res = await getChannel(channelId)
          return res.success ? res.data : undefined
        })
      )
      return results.filter((channel): channel is Channel => Boolean(channel))
    },
    enabled: missingCatalogChannelIds.length > 0,
    staleTime: 60_000,
  })

  const resolvedCatalogChannels = useMemo(
    () => [...catalogChannels, ...(missingChannelsQuery.data ?? [])],
    [catalogChannels, missingChannelsQuery.data]
  )

  useEffect(() => {
    const source = detailQuery.data ?? trendQuery.data
    if (!source) return
    const nextRules = normalizeMultiplierRules(
      source.multiplier_rules,
      source.multipliers
    )
    const nextMultipliers = latestMultiplierRulesByKey(nextRules)
    multiplierRulesRef.current = nextRules
    setProviderMultipliers(nextMultipliers)
  }, [detailQuery.data, trendQuery.data])

  useEffect(() => {
    if (!detailQuery.data) return
    setExcludedUsers(normalizeExcludedUsers(detailQuery.data.excluded_users))
  }, [detailQuery.data])

  const handleDateRangeChange = useCallback((range: ProfitDateRange) => {
    setSelectedDateRange(range)
    setTimeRange(buildTimeRangeFromDates(range))
  }, [])

  const handleTrendDateRangeChange = useCallback((range: ProfitDateRange) => {
    setTrendDateRange(range)
    setTrendTimeRange(buildTimeRangeFromDates(range))
  }, [])

  const handleResetMultipliers = useCallback(() => {
    multiplierRulesRef.current = []
    setProviderMultipliers({})
    setDraftMultiplier('')
    updateMultipliersMutation.mutate([])
  }, [updateMultipliersMutation])

  const providerRows = useMemo(
    () => buildProviderRows(profitData),
    [profitData]
  )

  const totalRevenueQuota = useMemo(
    () => providerRows.reduce((sum, item) => sum + item.revenueQuota, 0),
    [providerRows]
  )

  const allRows = useMemo(
    () =>
      buildProfitRows(
        profitData.items,
        totalRevenueQuota
      ),
    [profitData.items, totalRevenueQuota]
  )

  const providerOptions = useMemo(
    () =>
      mergeProviderOptions(
        buildProviderOptions(profitData),
        mergeChannelOptions(
          buildChannelOptions(profitData.items),
          buildChannelsFromCatalog(resolvedCatalogChannels),
          providerMultipliers
        )
      ),
    [profitData, providerMultipliers, resolvedCatalogChannels]
  )

  const trendProviderOptions = useMemo(
    () =>
      mergeProviderOptions(
        buildProviderOptions(trendData),
        mergeChannelOptions(
          buildChannelOptions(trendData.items),
          buildChannelsFromCatalog(resolvedCatalogChannels),
          providerMultipliers
        )
      ),
    [providerMultipliers, resolvedCatalogChannels, trendData]
  )

  const channelOptions = useMemo(
    () =>
      mergeChannelOptions(
        buildChannelOptions(profitData.items),
        buildChannelsFromCatalog(resolvedCatalogChannels),
        providerMultipliers
      ),
    [profitData.items, providerMultipliers, resolvedCatalogChannels]
  )

  const trendChannelOptions = useMemo(
    () =>
      mergeChannelOptions(
        buildChannelOptions(trendData.items),
        buildChannelsFromCatalog(resolvedCatalogChannels),
        providerMultipliers
      ),
    [providerMultipliers, resolvedCatalogChannels, trendData.items]
  )

  const detailChannelSelectOptions = useMemo(
    () => buildChannelSelectOptions(channelOptions, selectedProvider),
    [channelOptions, selectedProvider]
  )

  const trendChannelSelectOptions = useMemo(
    () => buildChannelSelectOptions(trendChannelOptions, trendProvider),
    [trendChannelOptions, trendProvider]
  )

  const multiplierRuleRows = useMemo(
    () => buildMultiplierRuleRows(channelOptions, providerMultipliers),
    [channelOptions, providerMultipliers]
  )

  useEffect(() => {
    if (draftProvider || providerOptions.length === 0) return
    const firstProvider = providerOptions[0]
    setDraftProvider(firstProvider.value)
  }, [draftProvider, providerOptions])

  useEffect(() => {
    if (selectedProvider === ALL_VALUE) return
    const hasProvider = providerOptions.some(
      (option) => option.value === selectedProvider
    )
    if (!hasProvider) setSelectedProvider(ALL_VALUE)
  }, [providerOptions, selectedProvider])

  useEffect(() => {
    if (selectedChannel === ALL_VALUE) return
    const hasChannel = detailChannelSelectOptions.some(
      (channel) => String(channel.channelId) === selectedChannel
    )
    if (!hasChannel) setSelectedChannel(ALL_VALUE)
  }, [detailChannelSelectOptions, selectedChannel])

  useEffect(() => {
    if (trendProvider === ALL_VALUE) return
    const hasProvider = trendProviderOptions.some(
      (option) => option.value === trendProvider
    )
    if (!hasProvider) setTrendProvider(ALL_VALUE)
  }, [trendProvider, trendProviderOptions])

  useEffect(() => {
    if (trendChannel === ALL_VALUE) return
    const hasChannel = trendChannelSelectOptions.some(
      (channel) => String(channel.channelId) === trendChannel
    )
    if (!hasChannel) setTrendChannel(ALL_VALUE)
  }, [trendChannel, trendChannelSelectOptions])

  const handleProviderChange = useCallback((value: string) => {
    setSelectedProvider(value)
    setSelectedChannel(ALL_VALUE)
  }, [])

  const handleTrendProviderChange = useCallback((value: string) => {
    setTrendProvider(value)
    setTrendChannel(ALL_VALUE)
  }, [])

  const filteredRows = useMemo(() => {
    return allRows.filter((row) => {
      if (
        selectedProvider !== ALL_VALUE &&
        providerKey(row.groupName) !== selectedProvider
      ) {
        return false
      }
      if (
        selectedChannel !== ALL_VALUE &&
        String(row.channelId) !== selectedChannel
      ) {
        return false
      }
      if (selectedStatus === 'profitable') return row.grossProfitQuota >= 0
      if (selectedStatus === 'loss') return row.grossProfitQuota < 0
      return true
    })
  }, [allRows, selectedChannel, selectedProvider, selectedStatus])

  const filteredMultiplierRows = useMemo(() => {
    if (selectedProvider === ALL_VALUE) return multiplierRuleRows
    return multiplierRuleRows.filter(
      (row) => providerKey(row.groupName) === selectedProvider
    )
  }, [multiplierRuleRows, selectedProvider])

  const filteredTrends = useMemo(() => {
    return (trendData.trends ?? []).filter((trend) => {
      const channelId = Number(trend.channel_id) || 0
      if (channelId <= 0 || getEffectiveQuota(trend) <= 0) return false
      if (
        trendProvider !== ALL_VALUE &&
        providerKey(trend.group) !== trendProvider
      ) {
        return false
      }
      if (
        trendChannel !== ALL_VALUE &&
        String(trend.channel_id) !== trendChannel
      ) {
        return false
      }
      const revenueQuota = getEffectiveQuota(trend)
      const estimatedCostQuota = getEstimatedCostQuota(trend)
      const grossProfitQuota = revenueQuota - estimatedCostQuota
      if (trendStatus === 'profitable') return grossProfitQuota >= 0
      if (trendStatus === 'loss') return grossProfitQuota < 0
      return true
    })
  }, [
    trendChannel,
    trendData.trends,
    trendProvider,
    trendStatus,
  ])

  const trendPoints = useMemo(
    () =>
      buildTrendPoints(
        filteredTrends,
        trendTimeRange.start_timestamp,
        trendTimeRange.end_timestamp
      ),
    [filteredTrends, trendTimeRange]
  )

  const summary = useMemo(() => {
    const totalEstimatedCostQuota = filteredRows.reduce(
      (sum, item) => sum + item.estimatedCostQuota,
      0
    )
    const filteredRevenueQuota = filteredRows.reduce(
      (sum, item) => sum + item.revenueQuota,
      0
    )
    const totalGrossProfitQuota = filteredRevenueQuota - totalEstimatedCostQuota
    const totalRequests = filteredRows.reduce(
      (sum, item) => sum + item.requestCount,
      0
    )
    const profitMargin =
      filteredRevenueQuota > 0
        ? (totalGrossProfitQuota / filteredRevenueQuota) * 100
        : 0

    return {
      totalRevenueQuota: filteredRevenueQuota,
      totalEstimatedCostQuota,
      totalGrossProfitQuota,
      totalRequests,
      profitMargin,
    }
  }, [filteredRows])

  const coverage = useMemo(() => {
    const configuredProviders = providerRows.filter((row) => row.saved).length
    const configuredChannels = multiplierRuleRows.filter((row) => row.saved).length
    const missingChannels = Math.max(
      0,
      multiplierRuleRows.length - configuredChannels
    )
    const complete = multiplierRuleRows.length > 0 && missingChannels === 0

    return {
      configuredProviders,
      configuredChannels,
      missingChannels,
      excludedUsers: excludedUsers.length,
      complete,
    }
  }, [excludedUsers.length, multiplierRuleRows, providerRows])

  const visibleRows = filteredRows.slice(0, PROFIT_ROW_LIMIT)
  const activeDraftProvider = providerOptions.find(
    (option) => option.value === draftProvider
  )
  const activeDraftChannel = channelOptions.find(
    (channel) =>
      String(channel.channelId) === draftChannel &&
      (!activeDraftProvider || channel.groupName === activeDraftProvider.type)
  )

  const openMultiplierDialog = useCallback(
    (groupName?: string, channelId?: number, multiplier?: number | null) => {
      const targetGroup = groupName ?? draftProvider ?? providerOptions[0]?.value
      const targetProvider = providerOptions.find(
        (option) => option.value === targetGroup || option.type === targetGroup
      )
      const normalizedGroup = targetProvider?.type ?? targetGroup ?? ''
      const firstChannel = channelOptions.find(
        (channel) => channel.groupName === normalizedGroup
      )
      const selectedChannelId = channelId ?? firstChannel?.channelId ?? 0
      const savedMultiplier =
        selectedChannelId > 0
          ? getChannelMultiplier(
              providerMultipliers,
              normalizedGroup,
              selectedChannelId
            )
          : undefined

      setDraftProvider(providerKey(normalizedGroup))
      setDraftChannel(selectedChannelId > 0 ? String(selectedChannelId) : '')
      setDraftMultiplier(
        multiplier !== undefined && multiplier !== null
          ? String(multiplier)
          : savedMultiplier !== undefined
            ? String(savedMultiplier)
            : ''
      )
      setDraftNote('')
      setMultiplierDialogOpen(true)
    },
    [channelOptions, draftProvider, providerMultipliers, providerOptions]
  )

  const handleDraftProviderChange = useCallback(
    (value: string) => {
      setDraftProvider(value)
      const provider = providerOptions.find((option) => option.value === value)
      const firstChannel = channelOptions.find(
        (channel) => channel.groupName === provider?.type
      )
      if (!provider || !firstChannel) {
        setDraftChannel('')
        setDraftMultiplier('')
        return
      }
      const multiplier = getChannelMultiplier(
        providerMultipliers,
        provider.type,
        firstChannel.channelId
      )
      setDraftChannel(String(firstChannel.channelId))
      setDraftMultiplier(multiplier !== undefined ? String(multiplier) : '')
    },
    [channelOptions, providerMultipliers, providerOptions]
  )

  const handleDraftChannelChange = useCallback(
    (value: string) => {
      setDraftChannel(value)
      const channel = channelOptions.find(
        (item) =>
          String(item.channelId) === value &&
          (!activeDraftProvider || item.groupName === activeDraftProvider.type)
      )
      if (!channel || !activeDraftProvider) {
        setDraftMultiplier('')
        return
      }
      const multiplier = getChannelMultiplier(
        providerMultipliers,
        activeDraftProvider.type,
        channel.channelId
      )
      setDraftMultiplier(multiplier !== undefined ? String(multiplier) : '')
    },
    [activeDraftProvider, channelOptions, providerMultipliers]
  )

  const handleDraftMultiplierChange = useCallback(
    (value: string) => {
      setDraftMultiplier(value)
    },
    []
  )

  const handleSaveDraftMultiplier = useCallback(() => {
    if (!activeDraftProvider || !activeDraftChannel) {
      toast.error(t('Please select a channel'))
      return
    }
    const numericValue = Number(draftMultiplier)
    if (!Number.isFinite(numericValue)) {
      toast.error(t('Please enter a valid number'))
      return
    }
    const rule = {
      key: channelMultiplierKey(
        activeDraftProvider.type,
        activeDraftChannel.channelId
      ),
      multiplier: clampProviderMultiplier(numericValue),
      effective_at: Math.floor(Date.now() / 1000),
      note: draftNote.trim() || undefined,
    } satisfies ProfitChannelMultiplierRule
    const nextRules = normalizeMultiplierRules([
      ...multiplierRulesRef.current,
      rule,
    ])
    const nextMultipliers = latestMultiplierRulesByKey(nextRules)
    multiplierRulesRef.current = nextRules
    setProviderMultipliers(nextMultipliers)
    updateMultipliersMutation.mutate(nextRules)
    setMultiplierDialogOpen(false)
    toast.success(t('Updated successfully'))
  }, [
    activeDraftChannel,
    activeDraftProvider,
    draftMultiplier,
    draftNote,
    t,
    updateMultipliersMutation,
  ])

  const handleSaveExcludedUser = useCallback(() => {
    const username = draftExcludedUsername.trim()
    if (!username) {
      toast.error(t('Please enter a username'))
      return
    }
    if (
      excludedUsers.some(
        (item) => item.username.toLowerCase() === username.toLowerCase()
      )
    ) {
      toast.error(t('User already exists'))
      return
    }

    const next = [
      ...excludedUsers,
      {
        username,
        reason: draftExcludedReason.trim() || '-',
        effective_time: formatDateTimeStr(new Date()),
        affected_requests: 0,
      },
    ]
    setExcludedUsers(next)
    updateExcludedUsersMutation.mutate(next)
    setDraftExcludedUsername('')
    setDraftExcludedReason('')
    setExcludedUserDialogOpen(false)
    toast.success(t('Added successfully'))
  }, [
    draftExcludedReason,
    draftExcludedUsername,
    excludedUsers,
    t,
    updateExcludedUsersMutation,
  ])

  const loading = detailQuery.isLoading && trendQuery.isLoading
  const fetching = detailQuery.isFetching || trendQuery.isFetching
  const hasError = detailQuery.isError || trendQuery.isError
  const hasDetailDataset = profitData.items.length > 0
  const hasTrendDataset = filteredTrends.length > 0

  return (
    <div className='space-y-4'>
      {fetching && (
        <div className='flex justify-end'>
          <Loader2 className='text-muted-foreground size-4 animate-spin' />
        </div>
      )}

      {hasError ? (
        <EmptyState
          bordered
          icon={ReceiptText}
          title={t('Failed to load profit data')}
          description={t('Please refresh and try again.')}
        />
      ) : loading ? (
        <ProfitOverviewSkeleton />
      ) : (
        <>
          <div
            className={cn(
              'grid gap-4',
              hasDetailDataset && 'xl:grid-cols-[minmax(0,1fr)_300px]'
            )}
          >
            <div className='space-y-4'>
              {hasDetailDataset && (
                <div className='grid gap-3 md:grid-cols-2 2xl:grid-cols-4'>
                  <ProfitMetricCard
                    title={t('Current Period Revenue')}
                    value={formatQuota(summary.totalRevenueQuota)}
                    description={t('Consumed quota revenue')}
                  />
                  <ProfitMetricCard
                    title={t('Current Period Upstream Cost')}
                    value={formatQuota(summary.totalEstimatedCostQuota)}
                    description={t('Estimated upstream spend')}
                  />
                  <ProfitMetricCard
                    title={t('Current Period Gross Profit')}
                    value={formatQuota(summary.totalGrossProfitQuota)}
                    description={t('Revenue after estimated cost')}
                    valueClassName={getProfitTone(summary.totalGrossProfitQuota)}
                  />
                  <ProfitMetricCard
                    title={t('Current Period Profit Margin')}
                    value={`${formatNumber(summary.profitMargin)}%`}
                    description={t('Gross profit divided by revenue')}
                    valueClassName={getCostTone(summary.profitMargin)}
                  />
                </div>
              )}

              <Card className='rounded-lg py-0'>
                <CardHeader className='flex-row items-center justify-between border-b px-3 py-2'>
                  <CardTitle className='text-sm'>
                    {t('Revenue / Cost / Profit Trend')}
                  </CardTitle>
                  <div className='flex flex-wrap items-center gap-3 text-xs'>
                    <span className='flex items-center gap-1.5'>
                      <span className='size-2 rounded-full bg-blue-500' />
                      {t('Revenue')}
                    </span>
                    <span className='flex items-center gap-1.5'>
                      <span className='size-2 rounded-full bg-slate-400' />
                      {t('Estimated Cost')}
                    </span>
                    <span className='flex items-center gap-1.5'>
                      <span className='size-2 rounded-full bg-emerald-500' />
                      {t('Gross Profit')}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className='overflow-x-auto px-0'>
                  <div className='px-3 pt-3'>
                    <ProfitFilterBar
                      selectedDateRange={trendDateRange}
                      selectedProvider={trendProvider}
                      selectedChannel={trendChannel}
                      selectedStatus={trendStatus}
                      providerOptions={trendProviderOptions}
                      channelOptions={trendChannelSelectOptions}
                      onDateRangeChange={handleTrendDateRangeChange}
                      onProviderChange={handleTrendProviderChange}
                      onChannelChange={setTrendChannel}
                      onStatusChange={setTrendStatus}
                    />
                  </div>
                  {trendQuery.isLoading ? (
                    <Skeleton className='mx-3 my-4 h-72 rounded-lg' />
                  ) : hasTrendDataset ? (
                    <ProfitTrendChart points={trendPoints} loading={false} />
                  ) : (
                    <EmptyState
                      icon={ReceiptText}
                      title={t('No profit data')}
                      description={t(
                        'No billing statistics found for the current range.'
                      )}
                      className='min-h-72 rounded-none'
                    />
                  )}
                </CardContent>
              </Card>

              <Card className='rounded-lg py-0'>
                <CardHeader className='border-b px-3 py-2'>
                  <div className='flex flex-wrap items-center justify-between gap-2'>
                    <CardTitle className='text-sm'>{t('Profit Details')}</CardTitle>
                    <Badge variant='outline'>
                      {t('Grouped by group and channel')}
                    </Badge>
                  </div>
                  <ProfitFilterBar
                    selectedDateRange={selectedDateRange}
                    selectedProvider={selectedProvider}
                    selectedChannel={selectedChannel}
                    selectedStatus={selectedStatus}
                    providerOptions={providerOptions}
                    channelOptions={detailChannelSelectOptions}
                    onDateRangeChange={handleDateRangeChange}
                    onProviderChange={handleProviderChange}
                    onChannelChange={setSelectedChannel}
                    onStatusChange={setSelectedStatus}
                  />
                </CardHeader>
                <CardContent className='px-0'>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('Group')}</TableHead>
                        <TableHead>{t('Channel')}</TableHead>
                        <TableHead>{t('Multiplier Status')}</TableHead>
                        <TableHead className='text-right'>{t('Revenue')}</TableHead>
                        <TableHead className='text-right'>
                          {t('Estimated Cost')}
                        </TableHead>
                        <TableHead className='text-right'>
                          {t('Gross Profit')}
                        </TableHead>
                        <TableHead className='text-right'>
                          {t('Profit Margin')}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleRows.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={7}
                            className='text-muted-foreground h-16 text-center'
                          >
                            {t(
                              'No channel and model combinations match the current filters.'
                            )}
                          </TableCell>
                        </TableRow>
                      ) : (
                        visibleRows.map((row) => (
                          <TableRow
                            key={`${row.groupName}:${row.channelId}:${row.modelName}`}
                          >
                            <TableCell>
                              <div className='max-w-40 truncate font-mono text-xs font-medium'>
                                {row.providerName}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className='max-w-44 truncate font-mono text-xs'>
                                {row.channelName}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant='secondary'
                                className='bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                              >
                                {t('Active')}
                              </Badge>
                            </TableCell>
                            <TableCell className='text-right font-mono'>
                              {formatQuota(row.revenueQuota)}
                            </TableCell>
                            <TableCell className='text-muted-foreground text-right font-mono'>
                              {formatQuota(row.estimatedCostQuota)}
                            </TableCell>
                            <TableCell
                              className={cn(
                                'text-right font-mono font-semibold',
                                getProfitTone(row.grossProfitQuota)
                              )}
                            >
                              {formatQuota(row.grossProfitQuota)}
                            </TableCell>
                            <TableCell
                              className={cn(
                                'text-right font-mono',
                                getCostTone(row.profitMargin)
                              )}
                            >
                              {formatNumber(row.profitMargin)}%
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>

            {hasDetailDataset && (
              <div className='space-y-4'>
                <Card className='rounded-lg py-0'>
                  <CardHeader className='flex-row items-center justify-between border-b px-3 py-2'>
                    <CardTitle className='text-sm'>
                      {t('Configuration Coverage')}
                    </CardTitle>
                    <Badge
                      variant='outline'
                      className={cn(
                        coverage.complete
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                      )}
                    >
                      {coverage.complete ? t('Complete') : t('Incomplete')}
                    </Badge>
                  </CardHeader>
                  <CardContent className='space-y-3'>
                    <div className='grid grid-cols-2 gap-2'>
                      <CompactStat
                        label={t('Configured Groups')}
                        value={`${coverage.configuredProviders}/${providerRows.length}`}
                        tone='success'
                      />
                      <CompactStat
                        label={t('Configured Channels')}
                        value={`${coverage.configuredChannels}/${multiplierRuleRows.length}`}
                        tone='success'
                      />
                      <CompactStat
                        label={t('Missing Channels')}
                        value={formatNumber(coverage.missingChannels)}
                        tone={
                          coverage.missingChannels > 0 ? 'warning' : 'success'
                        }
                      />
                      <CompactStat
                        label={t('Excluded Users')}
                        value={formatNumber(coverage.excludedUsers)}
                      />
                      <CompactStat
                        label={t('Logged Requests')}
                        value={formatCompactNumber(summary.totalRequests)}
                      />
                    </div>
                    <div className='text-muted-foreground rounded-lg border border-dashed p-3 text-xs leading-relaxed'>
                      {t(
                        'Channels without a configured multiplier are excluded from profit calculations.'
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
            </div>

          <Card className='rounded-lg py-0'>
            <CardHeader className='flex-row items-center justify-between border-b px-3 py-2'>
              <div>
                <CardTitle className='text-sm'>
                  {t('Group / Channel Multiplier Rules')}
                </CardTitle>
                <div className='text-muted-foreground mt-1 text-xs'>
                  {t(
                    'Multiplier changes only apply to requests after their effective time.'
                  )}
                </div>
              </div>
              <div className='flex items-center gap-2'>
                <NativeSelect
                  size='sm'
                  value={selectedProvider}
                  onChange={(event) => setSelectedProvider(event.target.value)}
                  className='w-36'
                  aria-label={t('Group')}
                >
                  <NativeSelectOption value={ALL_VALUE}>
                    {t('All Groups')}
                  </NativeSelectOption>
                  {providerOptions.map((option) => (
                    <NativeSelectOption key={option.value} value={option.value}>
                      {option.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <Button
                  type='button'
                  size='sm'
                  onClick={() => openMultiplierDialog()}
                >
                  <Plus className='size-4' />
                  {t('New Multiplier')}
                </Button>
              </div>
            </CardHeader>
            <CardContent className='px-0'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Group')}</TableHead>
                    <TableHead>{t('Channel')}</TableHead>
                    <TableHead className='text-right'>{t('Multiplier')}</TableHead>
                    <TableHead>{t('Effective Start')}</TableHead>
                    <TableHead>{t('Effective End')}</TableHead>
                    <TableHead>{t('Status')}</TableHead>
                    <TableHead>{t('Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredMultiplierRows.map((row) => (
                    <TableRow key={channelMultiplierKey(row.groupName, row.channelId)}>
                      <TableCell className='font-mono text-xs font-medium'>
                        {row.groupName}
                      </TableCell>
                      <TableCell className='text-muted-foreground font-mono text-xs'>
                        {row.channelName}
                      </TableCell>
                      <TableCell className='text-right font-mono'>
                        {row.saved ? (
                          <Badge
                            variant='outline'
                            className='bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          >
                            {formatMultiplier(row.multiplier ?? 0)}
                          </Badge>
                        ) : (
                          <span className='text-muted-foreground'>-</span>
                        )}
                      </TableCell>
                      <TableCell className='font-mono text-xs'>
                        {row.effectiveAt
                          ? formatDateTimeStr(new Date(row.effectiveAt * 1000))
                          : row.saved
                            ? t('Legacy')
                            : '-'}
                      </TableCell>
                      <TableCell className='font-mono text-xs'>-</TableCell>
                      <TableCell>
                        <Badge variant={row.saved ? 'secondary' : 'outline'}>
                          {row.saved ? t('Active') : t('Not configured')}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          type='button'
                          variant='link'
                          size='sm'
                          className='h-auto p-0'
                          onClick={() => {
                            openMultiplierDialog(
                              providerKey(row.groupName),
                              row.channelId,
                              row.multiplier
                            )
                          }}
                        >
                          {row.saved ? t('Edit') : t('Input')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredMultiplierRows.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className='text-muted-foreground h-16 text-center'
                      >
                        {t('No channels match the current filters.')}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className='rounded-lg py-0'>
            <CardHeader className='flex-row items-center justify-between border-b px-3 py-2'>
              <div>
                <CardTitle className='text-sm'>
                  {t('Excluded User Management')}
                </CardTitle>
                <div className='text-muted-foreground mt-1 text-xs'>
                  {t(
                    'Users excluded from profit statistics will be listed here.'
                  )}
                </div>
              </div>
              <Button
                type='button'
                size='sm'
                onClick={() => setExcludedUserDialogOpen(true)}
              >
                <Plus className='size-4' />
                {t('Add Excluded User')}
              </Button>
            </CardHeader>
            <CardContent className='px-0'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Username')}</TableHead>
                    <TableHead>{t('Reason')}</TableHead>
                    <TableHead>{t('Effective Time')}</TableHead>
                    <TableHead className='text-right'>
                      {t('Affected Requests')}
                    </TableHead>
                    <TableHead>{t('Status')}</TableHead>
                    <TableHead>{t('Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {excludedUsers.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className='text-muted-foreground h-16 text-center'
                      >
                        {t('No excluded users configured.')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    excludedUsers.map((item) => (
                      <TableRow key={item.username}>
                        <TableCell className='font-mono text-xs font-medium'>
                          {item.username}
                        </TableCell>
                        <TableCell className='text-muted-foreground text-xs'>
                          {item.reason}
                        </TableCell>
                        <TableCell className='font-mono text-xs'>
                          {item.effective_time || '-'}
                        </TableCell>
                        <TableCell className='text-right font-mono'>
                          {formatNumber(item.affected_requests)}
                        </TableCell>
                        <TableCell>
                          <Badge variant='secondary'>{t('Active')}</Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            type='button'
                            variant='link'
                            size='sm'
                            className='h-auto p-0'
                            onClick={() => {
                              const next = excludedUsers.filter(
                                (row) => row.username !== item.username
                              )
                              setExcludedUsers(next)
                              updateExcludedUsersMutation.mutate(next)
                            }}
                          >
                            {t('Remove')}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Dialog
            open={multiplierDialogOpen}
            onOpenChange={setMultiplierDialogOpen}
            title={t('Input Multiplier')}
            description={t(
              'Multiplier changes only apply to requests after their effective time.'
            )}
            contentClassName='sm:max-w-lg'
            footer={
              <>
                <Button
                  type='button'
                  variant='outline'
                  onClick={() => setMultiplierDialogOpen(false)}
                >
                  {t('Cancel')}
                </Button>
                <Button
                  type='button'
                  onClick={handleSaveDraftMultiplier}
                  disabled={
                    !activeDraftProvider ||
                    !activeDraftChannel ||
                    updateMultipliersMutation.isPending
                  }
                >
                  <Save className='size-4' />
                  {t('Save Multiplier')}
                </Button>
              </>
            }
          >
            <div className='space-y-4'>
              <div className='space-y-1.5'>
                <Label htmlFor='profit-provider'>{t('Group')}</Label>
                <NativeSelect
                  id='profit-provider'
                  value={draftProvider}
                  onChange={(event) =>
                    handleDraftProviderChange(event.target.value)
                  }
                  className='w-full'
                >
                  {providerOptions.map((option) => (
                    <NativeSelectOption key={option.value} value={option.value}>
                      {option.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>

              <div className='space-y-1.5'>
                <Label htmlFor='profit-channel'>{t('Channel')}</Label>
                <NativeSelect
                  id='profit-channel'
                  value={draftChannel}
                  onChange={(event) =>
                    handleDraftChannelChange(event.target.value)
                  }
                  className='w-full'
                >
                  {channelOptions
                    .filter(
                      (channel) =>
                        !activeDraftProvider ||
                        channel.groupName === activeDraftProvider.type
                    )
                    .map((channel) => (
                      <NativeSelectOption
                        key={channel.channelId}
                        value={String(channel.channelId)}
                      >
                        {channel.channelName}
                      </NativeSelectOption>
                    ))}
                </NativeSelect>
              </div>

              <div className='space-y-1.5'>
                <Label htmlFor='profit-multiplier'>{t('Multiplier')}</Label>
                <Input
                  id='profit-multiplier'
                  type='number'
                  min={0}
                  max={MAX_PROVIDER_MULTIPLIER}
                  step={0.01}
                  value={draftMultiplier}
                  onChange={(event) =>
                    handleDraftMultiplierChange(event.target.value)
                  }
                />
              </div>

              <div className='space-y-1.5'>
                <Label htmlFor='profit-effective-time'>
                  {t('Effective Time')}
                </Label>
                <Input
                  id='profit-effective-time'
                  readOnly
                  value={formatDateTimeStr(new Date())}
                />
              </div>

              <div className='space-y-1.5'>
                <Label htmlFor='profit-note'>{t('Note')}</Label>
                <Input
                  id='profit-note'
                  value={draftNote}
                  onChange={(event) => setDraftNote(event.target.value)}
                  placeholder={t('Channel cost price adjustment')}
                />
              </div>

              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={handleResetMultipliers}
              >
                <RotateCcw className='size-4' />
                {t('Reset')}
              </Button>
            </div>
          </Dialog>

          <Dialog
            open={excludedUserDialogOpen}
            onOpenChange={setExcludedUserDialogOpen}
            title={t('Add Excluded User')}
            description={t(
              'Users excluded from profit statistics will be listed here.'
            )}
            contentClassName='sm:max-w-lg'
            footer={
              <>
                <Button
                  type='button'
                  variant='outline'
                  onClick={() => setExcludedUserDialogOpen(false)}
                >
                  {t('Cancel')}
                </Button>
                <Button
                  type='button'
                  onClick={handleSaveExcludedUser}
                  disabled={updateExcludedUsersMutation.isPending}
                >
                  <Save className='size-4' />
                  {t('Save')}
                </Button>
              </>
            }
          >
            <div className='space-y-4'>
              <div className='space-y-1.5'>
                <Label htmlFor='profit-excluded-user'>{t('Username')}</Label>
                <Input
                  id='profit-excluded-user'
                  value={draftExcludedUsername}
                  onChange={(event) =>
                    setDraftExcludedUsername(event.target.value)
                  }
                  placeholder={t('Username')}
                />
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='profit-excluded-reason'>{t('Reason')}</Label>
                <Textarea
                  id='profit-excluded-reason'
                  value={draftExcludedReason}
                  onChange={(event) => setDraftExcludedReason(event.target.value)}
                  placeholder={t('Internal testing or gift traffic')}
                />
              </div>
            </div>
          </Dialog>
        </>
      )}
    </div>
  )
}
