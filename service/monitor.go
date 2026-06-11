package service

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
)

const (
	MonitorStatusNormal   = "normal"
	MonitorStatusDegraded = "degraded"
	MonitorStatusAbnormal = "abnormal"
	MonitorStatusDisabled = "disabled"
	MonitorStatusNoData   = "no_data"

	monitorWindow3hSeconds  = int64(3 * 60 * 60)
	monitorWindow15mSeconds = int64(15 * 60)
	monitorBucketCount      = 10
)

type MonitorAvailabilityParams struct {
	Query       string
	Group       string
	ChannelType int
	Status      string
}

type MonitorAvailabilitySummary struct {
	Channels            int     `json:"channels"`
	Models              int     `json:"models"`
	Normal              int     `json:"normal"`
	Abnormal            int     `json:"abnormal"`
	Disabled            int     `json:"disabled"`
	NoData              int     `json:"no_data"`
	Availability3h      float64 `json:"availability_3h"`
	TotalRequests3h     int     `json:"total_requests_3h"`
	SuccessRequests3h   int     `json:"success_requests_3h"`
	ErrorRequests3h     int     `json:"error_requests_3h"`
	RecentWindowMinutes int     `json:"recent_window_minutes"`
	UpdatedAt           int64   `json:"updated_at"`
}

type MonitorAvailabilityOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

type MonitorAvailabilityBucket struct {
	StartAt int64  `json:"start_at"`
	Total   int    `json:"total"`
	Success int    `json:"success"`
	Error   int    `json:"error"`
	Status  string `json:"status"`
}

type MonitorAvailabilityItem struct {
	ChannelId               int                         `json:"channel_id"`
	ChannelName             string                      `json:"channel_name"`
	ChannelType             int                         `json:"channel_type"`
	ChannelTypeName         string                      `json:"channel_type_name"`
	ChannelStatus           int                         `json:"channel_status"`
	ChannelResponseTimeMs   int                         `json:"channel_response_time_ms"`
	ChannelTestTime         int64                       `json:"channel_test_time"`
	ModelName               string                      `json:"model_name"`
	Groups                  []string                    `json:"groups"`
	AbilityEnabled          bool                        `json:"ability_enabled"`
	Status                  string                      `json:"status"`
	Availability3h          float64                     `json:"availability_3h"`
	Availability15m         float64                     `json:"availability_15m"`
	TotalRequests3h         int                         `json:"total_requests_3h"`
	SuccessRequests3h       int                         `json:"success_requests_3h"`
	ErrorRequests3h         int                         `json:"error_requests_3h"`
	TotalRequests15m        int                         `json:"total_requests_15m"`
	SuccessRequests15m      int                         `json:"success_requests_15m"`
	ErrorRequests15m        int                         `json:"error_requests_15m"`
	AverageLatencySeconds   *float64                    `json:"average_latency_seconds"`
	AverageFirstByteSeconds *float64                    `json:"average_first_byte_seconds"`
	LastCheckedAt           int64                       `json:"last_checked_at"`
	RecentBuckets           []MonitorAvailabilityBucket `json:"recent_buckets"`
}

type MonitorAvailabilityResponse struct {
	Summary      MonitorAvailabilitySummary  `json:"summary"`
	Items        []MonitorAvailabilityItem   `json:"items"`
	Groups       []MonitorAvailabilityOption `json:"groups"`
	ChannelTypes []MonitorAvailabilityOption `json:"channel_types"`
	Statuses     []MonitorAvailabilityOption `json:"statuses"`
}

type monitorItemAccumulator struct {
	item           MonitorAvailabilityItem
	groupSet       map[string]struct{}
	success3h      int
	error3h        int
	success15m     int
	error15m       int
	useTimeTotal   int
	useTimeCount   int
	firstByteTotal float64
	firstByteCount int
	buckets        []MonitorAvailabilityBucket
}

func GetMonitorAvailability(params MonitorAvailabilityParams) (MonitorAvailabilityResponse, error) {
	group := normalizeMonitorFilter(params.Group)
	statusFilter := normalizeMonitorFilter(params.Status)
	query := strings.ToLower(strings.TrimSpace(params.Query))

	now := time.Now().Unix()
	since3h := now - monitorWindow3hSeconds
	since15m := now - monitorWindow15mSeconds
	bucketSeconds := int64(math.Ceil(float64(monitorWindow15mSeconds) / float64(monitorBucketCount)))

	abilityRows, err := model.GetMonitorAbilityRows(group)
	if err != nil {
		return MonitorAvailabilityResponse{}, err
	}
	logRows, err := model.GetMonitorLogsSince(since3h)
	if err != nil {
		return MonitorAvailabilityResponse{}, err
	}

	accs := make(map[string]*monitorItemAccumulator)
	allGroups := make(map[string]struct{})
	channelTypes := make(map[int]string)

	for _, row := range abilityRows {
		if row.ChannelId == 0 || row.ModelName == "" {
			continue
		}
		key := monitorItemKey(row.ChannelId, row.ModelName)
		acc := accs[key]
		if acc == nil {
			buckets := make([]MonitorAvailabilityBucket, monitorBucketCount)
			for i := range buckets {
				buckets[i].StartAt = since15m + int64(i)*bucketSeconds
				buckets[i].Status = "empty"
			}
			channelTypeName := constant.GetChannelTypeName(row.ChannelType)
			acc = &monitorItemAccumulator{
				groupSet: make(map[string]struct{}),
				buckets:  buckets,
				item: MonitorAvailabilityItem{
					ChannelId:             row.ChannelId,
					ChannelName:           row.ChannelName,
					ChannelType:           row.ChannelType,
					ChannelTypeName:       channelTypeName,
					ChannelStatus:         row.ChannelStatus,
					ChannelResponseTimeMs: row.ChannelResponseTimeMs,
					ChannelTestTime:       row.ChannelTestTime,
					ModelName:             row.ModelName,
				},
			}
			accs[key] = acc
			channelTypes[row.ChannelType] = channelTypeName
		}
		if row.Group != "" {
			acc.groupSet[row.Group] = struct{}{}
			allGroups[row.Group] = struct{}{}
		}
		if row.AbilityEnabled {
			acc.item.AbilityEnabled = true
		}
	}

	for _, row := range logRows {
		if group != "" && row.Group != group {
			continue
		}
		if row.ChannelId == 0 || row.ModelName == "" {
			continue
		}
		acc := accs[monitorItemKey(row.ChannelId, row.ModelName)]
		if acc == nil {
			continue
		}
		isSuccess := row.Type == model.LogTypeConsume
		if isSuccess {
			acc.success3h++
		} else {
			acc.error3h++
		}
		if row.UseTime > 0 {
			acc.useTimeTotal += row.UseTime
			acc.useTimeCount++
		}
		if firstByteMs, ok := monitorFirstByteMs(row.Other); ok {
			acc.firstByteTotal += firstByteMs
			acc.firstByteCount++
		}
		if row.CreatedAt > acc.item.LastCheckedAt {
			acc.item.LastCheckedAt = row.CreatedAt
		}
		if row.CreatedAt >= since15m {
			if isSuccess {
				acc.success15m++
			} else {
				acc.error15m++
			}
			bucketIndex := int((row.CreatedAt - since15m) / bucketSeconds)
			if bucketIndex < 0 {
				bucketIndex = 0
			}
			if bucketIndex >= monitorBucketCount {
				bucketIndex = monitorBucketCount - 1
			}
			acc.buckets[bucketIndex].Total++
			if isSuccess {
				acc.buckets[bucketIndex].Success++
			} else {
				acc.buckets[bucketIndex].Error++
			}
		}
	}

	items := make([]MonitorAvailabilityItem, 0, len(accs))
	for _, acc := range accs {
		acc.item.Groups = sortedMonitorSet(acc.groupSet)
		acc.item.SuccessRequests3h = acc.success3h
		acc.item.ErrorRequests3h = acc.error3h
		acc.item.TotalRequests3h = acc.success3h + acc.error3h
		acc.item.SuccessRequests15m = acc.success15m
		acc.item.ErrorRequests15m = acc.error15m
		acc.item.TotalRequests15m = acc.success15m + acc.error15m
		acc.item.Availability3h = monitorAvailability(acc.success3h, acc.error3h)
		acc.item.Availability15m = monitorAvailability(acc.success15m, acc.error15m)
		acc.item.Status = monitorStatus(acc.item)
		acc.item.RecentBuckets = finalizeMonitorBuckets(acc.buckets)
		if acc.useTimeCount > 0 {
			avg := float64(acc.useTimeTotal) / float64(acc.useTimeCount)
			acc.item.AverageLatencySeconds = &avg
		} else if acc.item.ChannelResponseTimeMs > 0 {
			avg := float64(acc.item.ChannelResponseTimeMs) / 1000
			acc.item.AverageLatencySeconds = &avg
		}
		if acc.firstByteCount > 0 {
			avg := acc.firstByteTotal / float64(acc.firstByteCount) / 1000
			acc.item.AverageFirstByteSeconds = &avg
		}

		if params.ChannelType > 0 && acc.item.ChannelType != params.ChannelType {
			continue
		}
		if statusFilter != "" && acc.item.Status != statusFilter {
			continue
		}
		if query != "" && !monitorMatchesQuery(acc.item, query) {
			continue
		}
		items = append(items, acc.item)
	}

	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Status != items[j].Status {
			return monitorStatusRank(items[i].Status) < monitorStatusRank(items[j].Status)
		}
		if items[i].Availability3h != items[j].Availability3h {
			return items[i].Availability3h < items[j].Availability3h
		}
		if items[i].ChannelTypeName != items[j].ChannelTypeName {
			return items[i].ChannelTypeName < items[j].ChannelTypeName
		}
		if items[i].ChannelName != items[j].ChannelName {
			return items[i].ChannelName < items[j].ChannelName
		}
		return items[i].ModelName < items[j].ModelName
	})

	return MonitorAvailabilityResponse{
		Summary:      buildMonitorSummary(items, now),
		Items:        items,
		Groups:       monitorGroupOptions(allGroups),
		ChannelTypes: monitorChannelTypeOptions(channelTypes),
		Statuses: []MonitorAvailabilityOption{
			{Value: MonitorStatusNormal, Label: "Normal"},
			{Value: MonitorStatusDegraded, Label: "Degraded"},
			{Value: MonitorStatusAbnormal, Label: "Abnormal"},
			{Value: MonitorStatusDisabled, Label: "Disabled"},
			{Value: MonitorStatusNoData, Label: "No data"},
		},
	}, nil
}

func monitorItemKey(channelId int, modelName string) string {
	return fmt.Sprintf("%d\x00%s", channelId, modelName)
}

func normalizeMonitorFilter(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || strings.EqualFold(value, "all") {
		return ""
	}
	return value
}

func monitorAvailability(success int, failure int) float64 {
	total := success + failure
	if total <= 0 {
		return 0
	}
	return float64(success) / float64(total)
}

func monitorStatus(item MonitorAvailabilityItem) string {
	if item.ChannelStatus != common.ChannelStatusEnabled || !item.AbilityEnabled {
		return MonitorStatusDisabled
	}
	total := item.TotalRequests15m
	availability := item.Availability15m
	if total == 0 {
		total = item.TotalRequests3h
		availability = item.Availability3h
	}
	if total == 0 {
		return MonitorStatusNoData
	}
	if availability < 0.80 {
		return MonitorStatusAbnormal
	}
	if availability < 0.95 {
		return MonitorStatusDegraded
	}
	return MonitorStatusNormal
}

func monitorStatusRank(status string) int {
	switch status {
	case MonitorStatusAbnormal:
		return 0
	case MonitorStatusDisabled:
		return 1
	case MonitorStatusDegraded:
		return 2
	case MonitorStatusNoData:
		return 3
	default:
		return 4
	}
}

func monitorFirstByteMs(other string) (float64, bool) {
	if strings.TrimSpace(other) == "" {
		return 0, false
	}
	var fields map[string]interface{}
	if err := common.Unmarshal([]byte(other), &fields); err != nil {
		return 0, false
	}
	value, ok := fields["frt"]
	if !ok {
		return 0, false
	}
	return monitorFloat(value)
}

func monitorFloat(value interface{}) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case string:
		if typed == "" {
			return 0, false
		}
		var parsed float64
		if _, err := fmt.Sscanf(typed, "%f", &parsed); err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func finalizeMonitorBuckets(buckets []MonitorAvailabilityBucket) []MonitorAvailabilityBucket {
	result := make([]MonitorAvailabilityBucket, len(buckets))
	for i, bucket := range buckets {
		if bucket.Total == 0 {
			bucket.Status = "empty"
		} else if bucket.Error == 0 {
			bucket.Status = MonitorStatusNormal
		} else if bucket.Success == 0 {
			bucket.Status = MonitorStatusAbnormal
		} else {
			bucket.Status = MonitorStatusDegraded
		}
		result[i] = bucket
	}
	return result
}

func sortedMonitorSet(set map[string]struct{}) []string {
	values := make([]string, 0, len(set))
	for value := range set {
		values = append(values, value)
	}
	sort.Strings(values)
	return values
}

func monitorMatchesQuery(item MonitorAvailabilityItem, query string) bool {
	values := []string{
		item.ChannelName,
		item.ChannelTypeName,
		item.ModelName,
		fmt.Sprintf("%d", item.ChannelId),
	}
	values = append(values, item.Groups...)
	for _, value := range values {
		if strings.Contains(strings.ToLower(value), query) {
			return true
		}
	}
	return false
}

func buildMonitorSummary(items []MonitorAvailabilityItem, now int64) MonitorAvailabilitySummary {
	channels := make(map[int]struct{})
	models := make(map[string]struct{})
	summary := MonitorAvailabilitySummary{
		RecentWindowMinutes: int(monitorWindow15mSeconds / 60),
		UpdatedAt:           now,
	}
	for _, item := range items {
		channels[item.ChannelId] = struct{}{}
		models[item.ModelName] = struct{}{}
		switch item.Status {
		case MonitorStatusNormal, MonitorStatusDegraded:
			summary.Normal++
		case MonitorStatusAbnormal:
			summary.Abnormal++
		case MonitorStatusDisabled:
			summary.Disabled++
			summary.Abnormal++
		case MonitorStatusNoData:
			summary.NoData++
		}
		summary.SuccessRequests3h += item.SuccessRequests3h
		summary.ErrorRequests3h += item.ErrorRequests3h
	}
	summary.Channels = len(channels)
	summary.Models = len(models)
	summary.TotalRequests3h = summary.SuccessRequests3h + summary.ErrorRequests3h
	summary.Availability3h = monitorAvailability(summary.SuccessRequests3h, summary.ErrorRequests3h)
	return summary
}

func monitorGroupOptions(groups map[string]struct{}) []MonitorAvailabilityOption {
	values := sortedMonitorSet(groups)
	options := make([]MonitorAvailabilityOption, 0, len(values))
	for _, value := range values {
		options = append(options, MonitorAvailabilityOption{Value: value, Label: value})
	}
	return options
}

func monitorChannelTypeOptions(channelTypes map[int]string) []MonitorAvailabilityOption {
	ids := make([]int, 0, len(channelTypes))
	for id := range channelTypes {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	options := make([]MonitorAvailabilityOption, 0, len(ids))
	for _, id := range ids {
		options = append(options, MonitorAvailabilityOption{
			Value: fmt.Sprintf("%d", id),
			Label: channelTypes[id],
		})
	}
	return options
}
