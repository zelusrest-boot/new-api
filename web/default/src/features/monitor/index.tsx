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
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Gauge,
  Loader2,
  RefreshCw,
  Search,
  Signal,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import dayjs from '@/lib/dayjs'
import { cn } from '@/lib/utils'
import { formatCompactNumber, formatTimeStr } from '@/lib/format'
import { SectionPageLayout } from '@/components/layout'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getMonitorAvailability } from './api'
import {
  formatMonitorPercent,
  formatMonitorSeconds,
  MONITOR_QUERY_KEY,
  MONITOR_STATUS_META,
  monitorStatusLabel,
} from './lib'
import type {
  MonitorAvailabilityBucket,
  MonitorAvailabilityData,
  MonitorAvailabilityItem,
  MonitorStatus,
} from './types'

const ALL_VALUE = 'all'

export function Monitor() {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState(ALL_VALUE)
  const [channelType, setChannelType] = useState(ALL_VALUE)
  const [status, setStatus] = useState<MonitorStatus | typeof ALL_VALUE>(
    ALL_VALUE
  )

  const params = useMemo(
    () => ({
      q: search.trim() || undefined,
      group: group === ALL_VALUE ? undefined : group,
      channel_type:
        channelType === ALL_VALUE ? undefined : Number(channelType),
      status: status === ALL_VALUE ? undefined : status,
    }),
    [channelType, group, search, status]
  )

  const query = useQuery({
    queryKey: [...MONITOR_QUERY_KEY, params],
    queryFn: () => getMonitorAvailability(params),
    refetchInterval: 30_000,
    placeholderData: (previousData) => previousData,
  })

  const data = query.data?.data

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('Monitor')}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button
          variant='outline'
          size='sm'
          onClick={() => query.refetch()}
          disabled={query.isFetching}
        >
          {query.isFetching ? (
            <Loader2 className='size-4 animate-spin' />
          ) : (
            <RefreshCw className='size-4' />
          )}
          {t('Refresh')}
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <div className='space-y-3'>
          <MonitorSummary data={data} loading={query.isLoading} />
          <MonitorFilters
            data={data}
            search={search}
            group={group}
            channelType={channelType}
            status={status}
            onSearchChange={setSearch}
            onGroupChange={setGroup}
            onChannelTypeChange={setChannelType}
            onStatusChange={(value) =>
              setStatus(value as MonitorStatus | typeof ALL_VALUE)
            }
          />
          {query.isError ? (
            <ErrorState
              title={t('Failed to load monitor data')}
              description={t('Please refresh and try again.')}
              onRetry={() => query.refetch()}
            />
          ) : (
            <MonitorTable
              data={data}
              loading={query.isLoading}
              fetching={query.isFetching}
            />
          )}
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}

function MonitorSummary(props: {
  data?: MonitorAvailabilityData
  loading: boolean
}) {
  const { t } = useTranslation()
  const summary = props.data?.summary
  const cards = [
    {
      label: t('Channels'),
      value: summary?.channels,
      icon: Signal,
    },
    {
      label: t('Models'),
      value: summary?.models,
      icon: Gauge,
    },
    {
      label: t('Normal'),
      value: summary?.normal,
      icon: CheckCircle2,
    },
    {
      label: t('Abnormal'),
      value: summary?.abnormal,
      icon: AlertTriangle,
    },
    {
      label: t('3h availability'),
      value:
        summary != null ? formatMonitorPercent(summary.availability_3h) : '-',
      icon: Activity,
    },
  ]

  return (
    <div className='grid gap-2 sm:grid-cols-2 lg:grid-cols-5'>
      {cards.map((card) => {
        const Icon = card.icon
        return (
          <Card key={card.label} size='sm' className='rounded-lg'>
            <CardContent className='flex items-center justify-between gap-3'>
              <div className='min-w-0'>
                <p className='text-muted-foreground text-xs'>{card.label}</p>
                {props.loading ? (
                  <Skeleton className='mt-2 h-5 w-16' />
                ) : (
                  <p className='mt-1 truncate text-lg font-semibold'>
                    {typeof card.value === 'number'
                      ? formatCompactNumber(card.value)
                      : (card.value ?? '-')}
                  </p>
                )}
              </div>
              <Icon className='text-muted-foreground size-4 shrink-0' />
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function MonitorFilters(props: {
  data?: MonitorAvailabilityData
  search: string
  group: string
  channelType: string
  status: string
  onSearchChange: (value: string) => void
  onGroupChange: (value: string) => void
  onChannelTypeChange: (value: string) => void
  onStatusChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const selectedGroupLabel =
    props.group === ALL_VALUE
      ? t('All Groups')
      : (props.data?.groups.find((item) => item.value === props.group)
          ?.label ?? props.group)
  const selectedChannelTypeLabel =
    props.channelType === ALL_VALUE
      ? t('All Providers')
      : (props.data?.channel_types.find(
          (item) => String(item.value) === props.channelType
        )?.label ?? props.channelType)
  const selectedStatusLabel =
    props.status === ALL_VALUE
      ? t('All Statuses')
      : monitorStatusLabel(props.status as MonitorStatus, t)

  return (
    <Card size='sm' className='rounded-lg'>
      <CardContent className='flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between'>
        <div className='grid flex-1 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(220px,320px)_160px_180px_160px]'>
          <div className='relative'>
            <Search className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
            <Input
              value={props.search}
              onChange={(event) => props.onSearchChange(event.target.value)}
              placeholder={t('Search channel, provider, or model')}
              className='pl-8'
            />
          </div>
          <Select
            value={props.group}
            onValueChange={(value) =>
              value !== null && props.onGroupChange(value)
            }
          >
            <SelectTrigger className='w-full'>
              <SelectValue placeholder={t('All Groups')}>
                {selectedGroupLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                <SelectItem value={ALL_VALUE}>{t('All Groups')}</SelectItem>
                {(props.data?.groups ?? []).map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            value={props.channelType}
            onValueChange={(value) =>
              value !== null && props.onChannelTypeChange(value)
            }
          >
            <SelectTrigger className='w-full'>
              <SelectValue placeholder={t('All Providers')}>
                {selectedChannelTypeLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                <SelectItem value={ALL_VALUE}>{t('All Providers')}</SelectItem>
                {(props.data?.channel_types ?? []).map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            value={props.status}
            onValueChange={(value) =>
              value !== null && props.onStatusChange(value)
            }
          >
            <SelectTrigger className='w-full'>
              <SelectValue placeholder={t('All Statuses')}>
                {selectedStatusLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                <SelectItem value={ALL_VALUE}>{t('All Statuses')}</SelectItem>
                {(props.data?.statuses ?? []).map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {t(item.label)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className='text-muted-foreground shrink-0 text-xs'>
          {props.data?.summary.updated_at
            ? t('Updated {{time}}', {
                time: formatTimeStr(
                  new Date(props.data.summary.updated_at * 1000)
                ),
              })
            : t('Updated -')}
        </div>
      </CardContent>
    </Card>
  )
}

function MonitorTable(props: {
  data?: MonitorAvailabilityData
  loading: boolean
  fetching: boolean
}) {
  const { t } = useTranslation()
  const items = props.data?.items ?? []

  if (props.loading) {
    return <MonitorTableSkeleton />
  }

  if (items.length === 0) {
    return (
      <EmptyState
        bordered
        icon={Activity}
        title={t('No monitor rows found')}
        description={t(
          'No channel and model combinations match the current filters.'
        )}
      />
    )
  }

  return (
    <Card className='rounded-lg py-0'>
      <CardHeader className='flex-row items-center justify-between border-b px-3 py-2'>
        <CardTitle className='text-sm'>{t('Channel Model Availability')}</CardTitle>
        {props.fetching && (
          <Loader2 className='text-muted-foreground size-4 animate-spin' />
        )}
      </CardHeader>
      <CardContent className='px-0'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className='w-[180px]'>{t('Provider')}</TableHead>
              <TableHead className='min-w-[260px]'>{t('Model')}</TableHead>
              <TableHead>{t('Status')}</TableHead>
              <TableHead className='text-right'>{t('Total time')}</TableHead>
              <TableHead className='text-right'>{t('First byte')}</TableHead>
              <TableHead>{t('Recent 15 minutes')}</TableHead>
              <TableHead>{t('Last checked')}</TableHead>
              <TableHead className='text-right'>{t('3h availability')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <MonitorTableRow
                key={`${item.channel_id}-${item.model_name}`}
                item={item}
              />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function MonitorTableRow(props: { item: MonitorAvailabilityItem }) {
  const { t } = useTranslation()
  const item = props.item
  const meta = MONITOR_STATUS_META[item.status]
  const isBad = item.status === 'abnormal' || item.status === 'disabled'

  return (
    <TableRow className={cn(isBad && 'bg-red-500/[0.025]')}>
      <TableCell>
        <div className='flex min-w-0 flex-col gap-0.5'>
          <span className='truncate font-medium'>{item.channel_type_name}</span>
          <span className='text-muted-foreground truncate text-xs'>
            #{item.channel_id} {item.channel_name}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <div className='flex min-w-0 flex-col gap-1'>
          <span className='truncate font-mono text-xs font-semibold'>
            {item.model_name}
          </span>
          <div className='flex flex-wrap gap-1'>
            {item.groups.slice(0, 3).map((group) => (
              <Badge key={group} variant='outline' className='h-4 px-1.5 text-[10px]'>
                {group}
              </Badge>
            ))}
            {item.groups.length > 3 && (
              <Badge variant='outline' className='h-4 px-1.5 text-[10px]'>
                +{item.groups.length - 3}
              </Badge>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell>
        <Badge className={cn('gap-1.5', meta.className)}>
          <span className={cn('size-1.5 rounded-full', meta.dotClassName)} />
          {monitorStatusLabel(item.status, t)}
        </Badge>
      </TableCell>
      <TableCell className='text-right font-mono text-xs'>
        {formatMonitorSeconds(item.average_latency_seconds)}
      </TableCell>
      <TableCell className='text-right font-mono text-xs'>
        {formatMonitorSeconds(item.average_first_byte_seconds)}
      </TableCell>
      <TableCell>
        <RecentBuckets buckets={item.recent_buckets} />
      </TableCell>
      <TableCell className='font-mono text-xs'>
        {item.last_checked_at > 0
          ? dayjs(item.last_checked_at * 1000).format('HH:mm:ss')
          : '-'}
      </TableCell>
      <TableCell className='text-right font-mono text-xs'>
        {item.total_requests_3h > 0
          ? formatMonitorPercent(item.availability_3h)
          : '-'}
      </TableCell>
    </TableRow>
  )
}

function RecentBuckets(props: { buckets: MonitorAvailabilityBucket[] }) {
  const { t } = useTranslation()

  return (
    <div className='flex h-5 items-center gap-1'>
      {props.buckets.map((bucket) => {
        const className =
          bucket.status === 'normal'
            ? 'bg-emerald-500'
            : bucket.status === 'degraded'
              ? 'bg-amber-500'
              : bucket.status === 'abnormal'
                ? 'bg-red-500'
                : 'bg-muted'
        return (
          <span
            key={`${bucket.start_at}-${bucket.total}-${bucket.error}`}
            title={t('{{success}} normal / {{error}} abnormal', {
              success: bucket.success,
              error: bucket.error,
            })}
            className={cn('h-4 w-1.5 rounded-full', className)}
          />
        )
      })}
    </div>
  )
}

function MonitorTableSkeleton() {
  return (
    <Card className='rounded-lg py-0'>
      <CardContent className='space-y-2 p-3'>
        {Array.from({ length: 10 }, (_, index) => (
          <Skeleton key={index} className='h-10 w-full' />
        ))}
      </CardContent>
    </Card>
  )
}
