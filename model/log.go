package model

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/types"

	"github.com/gin-gonic/gin"

	"github.com/bytedance/gopkg/util/gopool"
	"gorm.io/gorm"
)

func applyExplicitLogTextFilter(tx *gorm.DB, column string, value string) (*gorm.DB, error) {
	if value == "" {
		return tx, nil
	}
	if strings.Contains(value, "%") {
		pattern, err := sanitizeLikePattern(value)
		if err != nil {
			return nil, err
		}
		return tx.Where(column+" LIKE ? ESCAPE '!'", pattern), nil
	}
	return tx.Where(column+" = ?", value), nil
}

type Log struct {
	Id                int    `json:"id" gorm:"index:idx_created_at_id,priority:2;index:idx_user_id_id,priority:2"`
	UserId            int    `json:"user_id" gorm:"index;index:idx_user_id_id,priority:1"`
	CreatedAt         int64  `json:"created_at" gorm:"bigint;index:idx_created_at_id,priority:1;index:idx_created_at_type"`
	Type              int    `json:"type" gorm:"index:idx_created_at_type"`
	Content           string `json:"content"`
	Username          string `json:"username" gorm:"index;index:index_username_model_name,priority:2;default:''"`
	TokenName         string `json:"token_name" gorm:"index;default:''"`
	ModelName         string `json:"model_name" gorm:"index;index:index_username_model_name,priority:1;default:''"`
	Quota             int    `json:"quota" gorm:"default:0"`
	PromptTokens      int    `json:"prompt_tokens" gorm:"default:0"`
	CompletionTokens  int    `json:"completion_tokens" gorm:"default:0"`
	UseTime           int    `json:"use_time" gorm:"default:0"`
	IsStream          bool   `json:"is_stream"`
	ChannelId         int    `json:"channel" gorm:"index"`
	ChannelName       string `json:"channel_name" gorm:"->"`
	TokenId           int    `json:"token_id" gorm:"default:0;index"`
	Group             string `json:"group" gorm:"index"`
	Ip                string `json:"ip" gorm:"index;default:''"`
	RequestId         string `json:"request_id,omitempty" gorm:"type:varchar(64);index:idx_logs_request_id;default:''"`
	UpstreamRequestId string `json:"upstream_request_id,omitempty" gorm:"type:varchar(128);index:idx_logs_upstream_request_id;default:''"`
	Other             string `json:"other"`
}

// don't use iota, avoid change log type value
const (
	LogTypeUnknown = 0
	LogTypeTopup   = 1
	LogTypeConsume = 2
	LogTypeManage  = 3
	LogTypeSystem  = 4
	LogTypeError   = 5
	LogTypeRefund  = 6
)

func formatUserLogs(logs []*Log, startIdx int) {
	for i := range logs {
		logs[i].ChannelName = ""
		var otherMap map[string]interface{}
		otherMap, _ = common.StrToMap(logs[i].Other)
		if otherMap != nil {
			// Remove admin-only debug fields.
			delete(otherMap, "admin_info")
			// delete(otherMap, "reject_reason")
			delete(otherMap, "stream_status")
		}
		logs[i].Other = common.MapToJsonStr(otherMap)
		logs[i].Id = startIdx + i + 1
	}
}

func GetLogByTokenId(tokenId int) (logs []*Log, err error) {
	err = LOG_DB.Model(&Log{}).Where("token_id = ?", tokenId).Order("id desc").Limit(common.MaxRecentItems).Find(&logs).Error
	formatUserLogs(logs, 0)
	return logs, err
}

func RecordLog(userId int, logType int, content string) {
	if logType == LogTypeConsume && !common.LogConsumeEnabled {
		return
	}
	username, _ := GetUsernameById(userId, false)
	log := &Log{
		UserId:    userId,
		Username:  username,
		CreatedAt: common.GetTimestamp(),
		Type:      logType,
		Content:   content,
	}
	err := LOG_DB.Create(log).Error
	if err != nil {
		common.SysLog("failed to record log: " + err.Error())
	}
}

// RecordLogWithAdminInfo 记录操作日志，并将管理员相关信息存入 Other.admin_info，
func RecordLogWithAdminInfo(userId int, logType int, content string, adminInfo map[string]interface{}) {
	if logType == LogTypeConsume && !common.LogConsumeEnabled {
		return
	}
	username, _ := GetUsernameById(userId, false)
	log := &Log{
		UserId:    userId,
		Username:  username,
		CreatedAt: common.GetTimestamp(),
		Type:      logType,
		Content:   content,
	}
	if len(adminInfo) > 0 {
		other := map[string]interface{}{
			"admin_info": adminInfo,
		}
		log.Other = common.MapToJsonStr(other)
	}
	if err := LOG_DB.Create(log).Error; err != nil {
		common.SysLog("failed to record log: " + err.Error())
	}
}

func RecordTopupLog(userId int, content string, callerIp string, paymentMethod string, callbackPaymentMethod string) {
	username, _ := GetUsernameById(userId, false)
	adminInfo := map[string]interface{}{
		"server_ip":               common.GetIp(),
		"node_name":               common.NodeName,
		"caller_ip":               callerIp,
		"payment_method":          paymentMethod,
		"callback_payment_method": callbackPaymentMethod,
		"version":                 common.Version,
	}
	other := map[string]interface{}{
		"admin_info": adminInfo,
	}
	log := &Log{
		UserId:    userId,
		Username:  username,
		CreatedAt: common.GetTimestamp(),
		Type:      LogTypeTopup,
		Content:   content,
		Ip:        callerIp,
		Other:     common.MapToJsonStr(other),
	}
	err := LOG_DB.Create(log).Error
	if err != nil {
		common.SysLog("failed to record topup log: " + err.Error())
	}
}

func RecordErrorLog(c *gin.Context, userId int, channelId int, modelName string, tokenName string, content string, tokenId int, useTimeSeconds int,
	isStream bool, group string, other map[string]interface{}) {
	logger.LogInfo(c, fmt.Sprintf("record error log: userId=%d, channelId=%d, modelName=%s, tokenName=%s, content=%s", userId, channelId, modelName, tokenName, common.LocalLogPreview(content)))
	username := c.GetString("username")
	requestId := c.GetString(common.RequestIdKey)
	upstreamRequestId := c.GetString(common.UpstreamRequestIdKey)
	otherStr := common.MapToJsonStr(other)
	// 判断是否需要记录 IP
	needRecordIp := false
	if settingMap, err := GetUserSetting(userId, false); err == nil {
		if settingMap.RecordIpLog {
			needRecordIp = true
		}
	}
	log := &Log{
		UserId:           userId,
		Username:         username,
		CreatedAt:        common.GetTimestamp(),
		Type:             LogTypeError,
		Content:          content,
		PromptTokens:     0,
		CompletionTokens: 0,
		TokenName:        tokenName,
		ModelName:        modelName,
		Quota:            0,
		ChannelId:        channelId,
		TokenId:          tokenId,
		UseTime:          useTimeSeconds,
		IsStream:         isStream,
		Group:            group,
		Ip: func() string {
			if needRecordIp {
				return c.ClientIP()
			}
			return ""
		}(),
		RequestId:         requestId,
		UpstreamRequestId: upstreamRequestId,
		Other:             otherStr,
	}
	err := LOG_DB.Create(log).Error
	if err != nil {
		logger.LogError(c, "failed to record log: "+err.Error())
	}
}

type RecordConsumeLogParams struct {
	ChannelId        int                    `json:"channel_id"`
	PromptTokens     int                    `json:"prompt_tokens"`
	CompletionTokens int                    `json:"completion_tokens"`
	ModelName        string                 `json:"model_name"`
	TokenName        string                 `json:"token_name"`
	Quota            int                    `json:"quota"`
	Content          string                 `json:"content"`
	TokenId          int                    `json:"token_id"`
	UseTimeSeconds   int                    `json:"use_time_seconds"`
	IsStream         bool                   `json:"is_stream"`
	Group            string                 `json:"group"`
	Other            map[string]interface{} `json:"other"`
}

func RecordConsumeLog(c *gin.Context, userId int, params RecordConsumeLogParams) {
	if !common.LogConsumeEnabled {
		return
	}
	logger.LogInfo(c, fmt.Sprintf("record consume log: userId=%d, params=%s", userId, common.GetJsonString(params)))
	username := c.GetString("username")
	requestId := c.GetString(common.RequestIdKey)
	upstreamRequestId := c.GetString(common.UpstreamRequestIdKey)
	otherStr := common.MapToJsonStr(params.Other)
	// 判断是否需要记录 IP
	needRecordIp := false
	if settingMap, err := GetUserSetting(userId, false); err == nil {
		if settingMap.RecordIpLog {
			needRecordIp = true
		}
	}
	log := &Log{
		UserId:           userId,
		Username:         username,
		CreatedAt:        common.GetTimestamp(),
		Type:             LogTypeConsume,
		Content:          params.Content,
		PromptTokens:     params.PromptTokens,
		CompletionTokens: params.CompletionTokens,
		TokenName:        params.TokenName,
		ModelName:        params.ModelName,
		Quota:            params.Quota,
		ChannelId:        params.ChannelId,
		TokenId:          params.TokenId,
		UseTime:          params.UseTimeSeconds,
		IsStream:         params.IsStream,
		Group:            params.Group,
		Ip: func() string {
			if needRecordIp {
				return c.ClientIP()
			}
			return ""
		}(),
		RequestId:         requestId,
		UpstreamRequestId: upstreamRequestId,
		Other:             otherStr,
	}
	err := LOG_DB.Create(log).Error
	if err != nil {
		logger.LogError(c, "failed to record log: "+err.Error())
	}
	if common.DataExportEnabled {
		gopool.Go(func() {
			LogQuotaData(userId, username, params.ModelName, params.Quota, common.GetTimestamp(), params.PromptTokens+params.CompletionTokens)
		})
	}
}

type RecordTaskBillingLogParams struct {
	UserId    int
	LogType   int
	Content   string
	ChannelId int
	ModelName string
	Quota     int
	TokenId   int
	Group     string
	Other     map[string]interface{}
}

func RecordTaskBillingLog(params RecordTaskBillingLogParams) {
	if params.LogType == LogTypeConsume && !common.LogConsumeEnabled {
		return
	}
	username, _ := GetUsernameById(params.UserId, false)
	tokenName := ""
	if params.TokenId > 0 {
		if token, err := GetTokenById(params.TokenId); err == nil {
			tokenName = token.Name
		}
	}
	log := &Log{
		UserId:    params.UserId,
		Username:  username,
		CreatedAt: common.GetTimestamp(),
		Type:      params.LogType,
		Content:   params.Content,
		TokenName: tokenName,
		ModelName: params.ModelName,
		Quota:     params.Quota,
		ChannelId: params.ChannelId,
		TokenId:   params.TokenId,
		Group:     params.Group,
		Other:     common.MapToJsonStr(params.Other),
	}
	err := LOG_DB.Create(log).Error
	if err != nil {
		common.SysLog("failed to record task billing log: " + err.Error())
	}
}

func GetAllLogs(logType int, startTimestamp int64, endTimestamp int64, modelName string, username string, tokenName string, startIdx int, num int, channel int, group string, requestId string, upstreamRequestId string) (logs []*Log, total int64, err error) {
	var tx *gorm.DB
	if logType == LogTypeUnknown {
		tx = LOG_DB
	} else {
		tx = LOG_DB.Where("logs.type = ?", logType)
	}

	if tx, err = applyExplicitLogTextFilter(tx, "logs.model_name", modelName); err != nil {
		return nil, 0, err
	}
	if tx, err = applyExplicitLogTextFilter(tx, "logs.username", username); err != nil {
		return nil, 0, err
	}
	if tokenName != "" {
		tx = tx.Where("logs.token_name = ?", tokenName)
	}
	if requestId != "" {
		tx = tx.Where("logs.request_id = ?", requestId)
	}
	if upstreamRequestId != "" {
		tx = tx.Where("logs.upstream_request_id = ?", upstreamRequestId)
	}
	if startTimestamp != 0 {
		tx = tx.Where("logs.created_at >= ?", startTimestamp)
	}
	if endTimestamp != 0 {
		tx = tx.Where("logs.created_at <= ?", endTimestamp)
	}
	if channel != 0 {
		tx = tx.Where("logs.channel_id = ?", channel)
	}
	if group != "" {
		tx = tx.Where("logs."+logGroupCol+" = ?", group)
	}
	err = tx.Model(&Log{}).Count(&total).Error
	if err != nil {
		return nil, 0, err
	}
	err = tx.Order("logs.created_at desc, logs.id desc").Limit(num).Offset(startIdx).Find(&logs).Error
	if err != nil {
		return nil, 0, err
	}

	channelIds := types.NewSet[int]()
	for _, log := range logs {
		if log.ChannelId != 0 {
			channelIds.Add(log.ChannelId)
		}
	}

	if channelIds.Len() > 0 {
		var channels []struct {
			Id   int    `gorm:"column:id"`
			Name string `gorm:"column:name"`
		}
		if common.MemoryCacheEnabled {
			// Cache get channel
			for _, channelId := range channelIds.Items() {
				if cacheChannel, err := CacheGetChannel(channelId); err == nil {
					channels = append(channels, struct {
						Id   int    `gorm:"column:id"`
						Name string `gorm:"column:name"`
					}{
						Id:   channelId,
						Name: cacheChannel.Name,
					})
				}
			}
		} else {
			// Bulk query channels from DB
			if err = DB.Table("channels").Select("id, name").Where("id IN ?", channelIds.Items()).Find(&channels).Error; err != nil {
				return logs, total, err
			}
		}
		channelMap := make(map[int]string, len(channels))
		for _, channel := range channels {
			channelMap[channel.Id] = channel.Name
		}
		for i := range logs {
			logs[i].ChannelName = channelMap[logs[i].ChannelId]
		}
	}

	return logs, total, err
}

const logSearchCountLimit = 10000

func GetUserLogs(userId int, logType int, startTimestamp int64, endTimestamp int64, modelName string, tokenName string, startIdx int, num int, group string, requestId string, upstreamRequestId string) (logs []*Log, total int64, err error) {
	var tx *gorm.DB
	if logType == LogTypeUnknown {
		tx = LOG_DB.Where("logs.user_id = ?", userId)
	} else {
		tx = LOG_DB.Where("logs.user_id = ? and logs.type = ?", userId, logType)
	}

	if tx, err = applyExplicitLogTextFilter(tx, "logs.model_name", modelName); err != nil {
		return nil, 0, err
	}
	if tokenName != "" {
		tx = tx.Where("logs.token_name = ?", tokenName)
	}
	if requestId != "" {
		tx = tx.Where("logs.request_id = ?", requestId)
	}
	if upstreamRequestId != "" {
		tx = tx.Where("logs.upstream_request_id = ?", upstreamRequestId)
	}
	if startTimestamp != 0 {
		tx = tx.Where("logs.created_at >= ?", startTimestamp)
	}
	if endTimestamp != 0 {
		tx = tx.Where("logs.created_at <= ?", endTimestamp)
	}
	if group != "" {
		tx = tx.Where("logs."+logGroupCol+" = ?", group)
	}
	err = tx.Model(&Log{}).Limit(logSearchCountLimit).Count(&total).Error
	if err != nil {
		common.SysError("failed to count user logs: " + err.Error())
		return nil, 0, errors.New("查询日志失败")
	}
	err = tx.Order("logs.id desc").Limit(num).Offset(startIdx).Find(&logs).Error
	if err != nil {
		common.SysError("failed to search user logs: " + err.Error())
		return nil, 0, errors.New("查询日志失败")
	}

	formatUserLogs(logs, startIdx)
	return logs, total, err
}

type Stat struct {
	Quota int `json:"quota"`
	Rpm   int `json:"rpm"`
	Tpm   int `json:"tpm"`
}

type ProfitOverviewItem struct {
	Group             string  `json:"group"`
	ProviderType      int     `json:"provider_type"`
	ProviderName      string  `json:"provider_name"`
	ChannelId         int     `json:"channel_id"`
	ChannelName       string  `json:"channel_name"`
	ModelName         string  `json:"model_name"`
	Quota             int     `json:"quota"`
	EffectiveQuota    int     `json:"effective_quota"`
	EstimatedCost     float64 `json:"estimated_cost_quota"`
	RequestCount      int     `json:"request_count"`
	EffectiveRequests int     `json:"effective_request_count"`
	PromptTokens      int     `json:"prompt_tokens"`
	CompletionTokens  int     `json:"completion_tokens"`
	TotalTokens       int     `json:"total_tokens"`
	FirstRequestAt    int64   `json:"first_request_at"`
	LastRequestAt     int64   `json:"last_request_at"`
}

type ProfitOverviewTrendItem struct {
	Time              string  `json:"time"`
	Group             string  `json:"group"`
	ProviderType      int     `json:"provider_type"`
	ProviderName      string  `json:"provider_name"`
	ChannelId         int     `json:"channel_id"`
	ChannelName       string  `json:"channel_name"`
	Quota             int     `json:"quota"`
	EffectiveQuota    int     `json:"effective_quota"`
	EstimatedCost     float64 `json:"estimated_cost_quota"`
	RequestCount      int     `json:"request_count"`
	EffectiveRequests int     `json:"effective_request_count"`
	PromptTokens      int     `json:"prompt_tokens"`
	CompletionTokens  int     `json:"completion_tokens"`
	TotalTokens       int     `json:"total_tokens"`
}

type ProfitChannelMultiplierRule struct {
	Key         string  `json:"key"`
	Multiplier  float64 `json:"multiplier"`
	EffectiveAt int64   `json:"effective_at"`
	Note        string  `json:"note,omitempty"`
}

type ProfitExcludedUser struct {
	Username         string `json:"username"`
	Reason           string `json:"reason"`
	EffectiveTime    string `json:"effective_time"`
	AffectedRequests int    `json:"affected_requests"`
}

type ProfitOverviewData struct {
	Items           []ProfitOverviewItem          `json:"items"`
	Groups          []ProfitOverviewItem          `json:"groups"`
	Providers       []ProfitOverviewItem          `json:"providers"`
	Trends          []ProfitOverviewTrendItem     `json:"trends"`
	Multipliers     map[string]float64            `json:"multipliers"`
	MultiplierRules []ProfitChannelMultiplierRule `json:"multiplier_rules"`
	ExcludedUsers   []ProfitExcludedUser          `json:"excluded_users"`
}

type profitOverviewLogRow struct {
	LogGroup         string
	ChannelId        int
	ModelName        string
	Quota            int
	PromptTokens     int
	CompletionTokens int
	CreatedAt        int64
}

const (
	ProfitProviderMultipliersOptionKey    = "ProfitProviderMultipliers"
	ProfitChannelMultiplierRulesOptionKey = "ProfitChannelMultiplierRules"
	ProfitExcludedUsersOptionKey          = "ProfitExcludedUsers"
	profitChannelMultiplierKeySeparator   = "::"
)

func GetProfitOverview(startTimestamp int64, endTimestamp int64) (ProfitOverviewData, error) {
	excludedUsers := GetProfitExcludedUsers()
	multiplierRules := GetProfitChannelMultiplierRules()
	multiplierRulesByKey := buildProfitChannelMultiplierRulesByKey(multiplierRules)
	query := applyProfitOverviewExcludedUsers(
		applyProfitOverviewTimeRange(LOG_DB.Model(&Log{}), startTimestamp, endTimestamp),
		excludedUsers,
	).
		Select(fmt.Sprintf("%s AS log_group, channel_id, model_name, quota, prompt_tokens, completion_tokens, created_at", logGroupCol)).
		Where("type = ?", LogTypeConsume)

	var logs []profitOverviewLogRow
	if err := query.Find(&logs).Error; err != nil {
		common.SysError("failed to query profit overview logs: " + err.Error())
		return ProfitOverviewData{}, errors.New("查询盈利总览数据失败")
	}

	channelIds := types.NewSet[int]()
	for _, row := range logs {
		if row.ChannelId > 0 {
			channelIds.Add(row.ChannelId)
		}
	}

	channelMap := make(map[int]Channel, channelIds.Len())
	if channelIds.Len() > 0 {
		var channels []Channel
		if err := DB.Select("id, type, name").Where("id IN ?", channelIds.Items()).Find(&channels).Error; err != nil {
			common.SysError("failed to query channels for profit overview: " + err.Error())
			return ProfitOverviewData{}, errors.New("查询盈利总览渠道数据失败")
		}
		for _, channel := range channels {
			channelMap[channel.Id] = channel
		}
	}

	itemMap := make(map[string]*ProfitOverviewItem)
	groupMap := make(map[string]*ProfitOverviewItem)
	trendMap := make(map[string]*ProfitOverviewTrendItem)
	for _, row := range logs {
		channel := channelMap[row.ChannelId]
		providerType := channel.Type
		providerName := constant.GetChannelTypeName(providerType)
		channelName := channel.Name
		groupName := normalizeProfitOverviewGroup(row.LogGroup)
		if providerType == 0 {
			providerName = constant.GetChannelTypeName(constant.ChannelTypeUnknown)
		}
		if channelName == "" && row.ChannelId > 0 {
			channelName = fmt.Sprintf("#%d", row.ChannelId)
		}
		modelName := row.ModelName
		if modelName == "" {
			modelName = "Unknown"
		}

		itemKey := fmt.Sprintf("%s:%d:%d:%s", groupName, providerType, row.ChannelId, modelName)
		item := itemMap[itemKey]
		if item == nil {
			item = &ProfitOverviewItem{
				Group:          groupName,
				ProviderType:   providerType,
				ProviderName:   providerName,
				ChannelId:      row.ChannelId,
				ChannelName:    channelName,
				ModelName:      modelName,
				FirstRequestAt: row.CreatedAt,
				LastRequestAt:  row.CreatedAt,
			}
			itemMap[itemKey] = item
		}
		accumulateProfitOverviewItem(item, row)

		group := groupMap[groupName]
		if group == nil {
			group = &ProfitOverviewItem{
				Group:          groupName,
				ProviderType:   providerType,
				ProviderName:   "",
				ModelName:      "",
				FirstRequestAt: row.CreatedAt,
				LastRequestAt:  row.CreatedAt,
			}
			groupMap[groupName] = group
		}
		accumulateProfitOverviewItem(group, row)

		dateBucket := profitOverviewDateBucket(row.CreatedAt)
		trendKey := fmt.Sprintf("%s:%s:%d", dateBucket, groupName, row.ChannelId)
		trend := trendMap[trendKey]
		if trend == nil {
			trend = &ProfitOverviewTrendItem{
				Time:         dateBucket,
				Group:        groupName,
				ProviderType: providerType,
				ProviderName: providerName,
				ChannelId:    row.ChannelId,
				ChannelName:  channelName,
			}
			trendMap[trendKey] = trend
		}
		accumulateProfitOverviewTrend(trend, row)

		multiplier, ok := findProfitChannelMultiplier(
			multiplierRulesByKey[profitChannelMultiplierKey(groupName, row.ChannelId)],
			row.CreatedAt,
		)
		if !ok {
			continue
		}
		accumulateEffectiveProfitOverviewItem(item, row, multiplier)
		accumulateEffectiveProfitOverviewItem(group, row, multiplier)
		accumulateEffectiveProfitOverviewTrend(trend, row, multiplier)
	}

	data := ProfitOverviewData{
		Items:           make([]ProfitOverviewItem, 0, len(itemMap)),
		Groups:          make([]ProfitOverviewItem, 0, len(groupMap)),
		Providers:       make([]ProfitOverviewItem, 0, len(groupMap)),
		Trends:          make([]ProfitOverviewTrendItem, 0, len(trendMap)),
		Multipliers:     GetProfitProviderMultipliers(),
		MultiplierRules: multiplierRules,
		ExcludedUsers:   hydrateProfitExcludedUserStats(excludedUsers, startTimestamp, endTimestamp),
	}
	for _, item := range itemMap {
		data.Items = append(data.Items, *item)
	}
	for _, group := range groupMap {
		data.Groups = append(data.Groups, *group)
		data.Providers = append(data.Providers, *group)
	}
	for _, trend := range trendMap {
		data.Trends = append(data.Trends, *trend)
	}
	sortProfitOverviewData(&data)
	return data, nil
}

func GetProfitProviderMultipliers() map[string]float64 {
	common.OptionMapRWMutex.RLock()
	rulesRaw := common.OptionMap[ProfitChannelMultiplierRulesOptionKey]
	common.OptionMapRWMutex.RUnlock()

	rules := GetProfitChannelMultiplierRules()
	if strings.TrimSpace(rulesRaw) != "" {
		multipliers := make(map[string]float64)
		for _, rule := range rules {
			multipliers[rule.Key] = rule.Multiplier
		}
		return multipliers
	}

	common.OptionMapRWMutex.RLock()
	raw := common.OptionMap[ProfitProviderMultipliersOptionKey]
	common.OptionMapRWMutex.RUnlock()

	if strings.TrimSpace(raw) == "" {
		return map[string]float64{}
	}

	var stored map[string]float64
	if err := common.UnmarshalJsonStr(raw, &stored); err != nil {
		common.SysError("failed to parse profit provider multipliers: " + err.Error())
		return map[string]float64{}
	}

	multipliers := make(map[string]float64, len(stored))
	for key, value := range stored {
		if !isValidProfitProviderMultiplier(value) {
			continue
		}
		trimmedKey := strings.TrimSpace(key)
		if trimmedKey == "" {
			continue
		}
		multipliers[trimmedKey] = value
	}
	return multipliers
}

func GetProfitChannelMultiplierRules() []ProfitChannelMultiplierRule {
	common.OptionMapRWMutex.RLock()
	raw := common.OptionMap[ProfitChannelMultiplierRulesOptionKey]
	common.OptionMapRWMutex.RUnlock()

	if strings.TrimSpace(raw) == "" {
		return profitChannelMultiplierRulesFromLegacyMap()
	}

	var stored []ProfitChannelMultiplierRule
	if err := common.UnmarshalJsonStr(raw, &stored); err != nil {
		common.SysError("failed to parse profit channel multiplier rules: " + err.Error())
		return profitChannelMultiplierRulesFromLegacyMap()
	}

	rules := normalizeProfitChannelMultiplierRules(stored)
	return rules
}

func ValidateProfitChannelMultiplierRules(raw string) error {
	if strings.TrimSpace(raw) == "" {
		return nil
	}

	var rules []ProfitChannelMultiplierRule
	if err := common.UnmarshalJsonStr(raw, &rules); err != nil {
		return errors.New("profit channel multiplier rules must be valid JSON")
	}

	for _, rule := range rules {
		if strings.TrimSpace(rule.Key) == "" {
			return errors.New("profit channel multiplier key cannot be empty")
		}
		if parseProfitChannelMultiplierKey(rule.Key) == nil {
			return errors.New("profit channel multiplier key must include group and channel")
		}
		if !isValidProfitProviderMultiplier(rule.Multiplier) {
			return errors.New("profit channel multiplier must be between 0 and 10")
		}
		if rule.EffectiveAt < 0 {
			return errors.New("profit channel multiplier effective time is invalid")
		}
	}
	return nil
}

func ValidateProfitProviderMultipliers(raw string) error {
	if strings.TrimSpace(raw) == "" {
		return nil
	}

	var multipliers map[string]float64
	if err := common.UnmarshalJsonStr(raw, &multipliers); err != nil {
		return errors.New("profit channel multipliers must be valid JSON")
	}

	for key, value := range multipliers {
		if strings.TrimSpace(key) == "" {
			return errors.New("profit channel multiplier key cannot be empty")
		}
		if !isValidProfitProviderMultiplier(value) {
			return errors.New("profit channel multiplier must be between 0 and 10")
		}
	}
	return nil
}

func NormalizeProfitChannelMultiplierRules(rules []ProfitChannelMultiplierRule) []ProfitChannelMultiplierRule {
	return normalizeProfitChannelMultiplierRules(rules)
}

func isValidProfitProviderMultiplier(value float64) bool {
	return value >= 0 && value <= 10
}

func GetProfitExcludedUsers() []ProfitExcludedUser {
	common.OptionMapRWMutex.RLock()
	raw := common.OptionMap[ProfitExcludedUsersOptionKey]
	common.OptionMapRWMutex.RUnlock()

	if strings.TrimSpace(raw) == "" {
		return []ProfitExcludedUser{}
	}

	var stored []ProfitExcludedUser
	if err := common.UnmarshalJsonStr(raw, &stored); err != nil {
		common.SysError("failed to parse profit excluded users: " + err.Error())
		return []ProfitExcludedUser{}
	}

	return normalizeProfitExcludedUsers(stored)
}

func ValidateProfitExcludedUsers(raw string) error {
	if strings.TrimSpace(raw) == "" {
		return nil
	}

	var users []ProfitExcludedUser
	if err := common.UnmarshalJsonStr(raw, &users); err != nil {
		return errors.New("profit excluded users must be valid JSON")
	}

	normalized := normalizeProfitExcludedUsers(users)
	if len(normalized) != len(users) {
		return errors.New("profit excluded username cannot be empty or duplicated")
	}
	return nil
}

func normalizeProfitExcludedUsers(users []ProfitExcludedUser) []ProfitExcludedUser {
	seen := make(map[string]bool, len(users))
	normalized := make([]ProfitExcludedUser, 0, len(users))
	for _, user := range users {
		username := strings.TrimSpace(user.Username)
		if username == "" {
			continue
		}
		key := strings.ToLower(username)
		if seen[key] {
			continue
		}
		seen[key] = true
		reason := strings.TrimSpace(user.Reason)
		if reason == "" {
			reason = "-"
		}
		normalized = append(normalized, ProfitExcludedUser{
			Username:         username,
			Reason:           reason,
			EffectiveTime:    strings.TrimSpace(user.EffectiveTime),
			AffectedRequests: user.AffectedRequests,
		})
	}
	return normalized
}

func applyProfitOverviewExcludedUsers(tx *gorm.DB, excludedUsers []ProfitExcludedUser) *gorm.DB {
	usernames := make([]string, 0, len(excludedUsers))
	for _, user := range excludedUsers {
		username := strings.TrimSpace(user.Username)
		if username != "" {
			usernames = append(usernames, username)
		}
	}
	if len(usernames) == 0 {
		return tx
	}
	return tx.Where("username NOT IN ?", usernames)
}

func hydrateProfitExcludedUserStats(users []ProfitExcludedUser, startTimestamp int64, endTimestamp int64) []ProfitExcludedUser {
	if len(users) == 0 {
		return users
	}

	type excludedUserStatRow struct {
		Username string
		Count    int
	}

	usernames := make([]string, 0, len(users))
	for _, user := range users {
		usernames = append(usernames, user.Username)
	}

	query := applyProfitOverviewTimeRange(LOG_DB.Model(&Log{}), startTimestamp, endTimestamp).
		Select("username, COUNT(*) AS count").
		Where("type = ?", LogTypeConsume).
		Where("username IN ?", usernames).
		Group("username")

	var rows []excludedUserStatRow
	if err := query.Find(&rows).Error; err != nil {
		common.SysError("failed to query profit excluded user stats: " + err.Error())
		return users
	}

	countByUsername := make(map[string]int, len(rows))
	for _, row := range rows {
		countByUsername[row.Username] = row.Count
	}

	withStats := make([]ProfitExcludedUser, 0, len(users))
	for _, user := range users {
		user.AffectedRequests = countByUsername[user.Username]
		withStats = append(withStats, user)
	}
	return withStats
}

func normalizeProfitOverviewGroup(group string) string {
	group = strings.TrimSpace(group)
	if group == "" {
		return "default"
	}
	return group
}

func applyProfitOverviewTimeRange(tx *gorm.DB, startTimestamp int64, endTimestamp int64) *gorm.DB {
	if startTimestamp != 0 {
		tx = tx.Where("created_at >= ?", startTimestamp)
	}
	if endTimestamp != 0 {
		tx = tx.Where("created_at <= ?", endTimestamp)
	}
	return tx
}

func profitOverviewDateBucketExpr() string {
	if common.UsingPostgreSQL {
		return "TO_CHAR(TO_TIMESTAMP(created_at), 'YYYY-MM-DD')"
	}
	if common.UsingMySQL {
		return "DATE_FORMAT(FROM_UNIXTIME(created_at), '%Y-%m-%d')"
	}
	return "strftime('%Y-%m-%d', datetime(created_at, 'unixepoch', 'localtime'))"
}

func profitOverviewDateBucket(createdAt int64) string {
	return time.Unix(createdAt, 0).In(time.Local).Format("2006-01-02")
}

func accumulateProfitOverviewItem(item *ProfitOverviewItem, row profitOverviewLogRow) {
	item.Quota += row.Quota
	item.RequestCount++
	item.PromptTokens += row.PromptTokens
	item.CompletionTokens += row.CompletionTokens
	item.TotalTokens += row.PromptTokens + row.CompletionTokens
	if item.FirstRequestAt == 0 || row.CreatedAt < item.FirstRequestAt {
		item.FirstRequestAt = row.CreatedAt
	}
	if row.CreatedAt > item.LastRequestAt {
		item.LastRequestAt = row.CreatedAt
	}
}

func accumulateEffectiveProfitOverviewItem(item *ProfitOverviewItem, row profitOverviewLogRow, multiplier float64) {
	item.EffectiveQuota += row.Quota
	item.EstimatedCost += float64(row.Quota) * multiplier
	item.EffectiveRequests++
}

func accumulateProfitOverviewTrend(item *ProfitOverviewTrendItem, row profitOverviewLogRow) {
	item.Quota += row.Quota
	item.RequestCount++
	item.PromptTokens += row.PromptTokens
	item.CompletionTokens += row.CompletionTokens
	item.TotalTokens += row.PromptTokens + row.CompletionTokens
}

func accumulateEffectiveProfitOverviewTrend(item *ProfitOverviewTrendItem, row profitOverviewLogRow, multiplier float64) {
	item.EffectiveQuota += row.Quota
	item.EstimatedCost += float64(row.Quota) * multiplier
	item.EffectiveRequests++
}

func profitChannelMultiplierKey(groupName string, channelId int) string {
	return normalizeProfitOverviewGroup(groupName) + profitChannelMultiplierKeySeparator + strconv.Itoa(channelId)
}

func parseProfitChannelMultiplierKey(key string) *struct {
	GroupName string
	ChannelId int
} {
	trimmed := strings.TrimSpace(key)
	separatorIndex := strings.LastIndex(trimmed, profitChannelMultiplierKeySeparator)
	if separatorIndex <= 0 {
		return nil
	}
	groupName := strings.TrimSpace(trimmed[:separatorIndex])
	channelText := strings.TrimSpace(trimmed[separatorIndex+len(profitChannelMultiplierKeySeparator):])
	channelId, err := strconv.Atoi(channelText)
	if err != nil || groupName == "" || channelId <= 0 {
		return nil
	}
	return &struct {
		GroupName string
		ChannelId int
	}{
		GroupName: normalizeProfitOverviewGroup(groupName),
		ChannelId: channelId,
	}
}

func normalizeProfitChannelMultiplierRules(rules []ProfitChannelMultiplierRule) []ProfitChannelMultiplierRule {
	normalized := make([]ProfitChannelMultiplierRule, 0, len(rules))
	for _, rule := range rules {
		parsed := parseProfitChannelMultiplierKey(rule.Key)
		if parsed == nil || !isValidProfitProviderMultiplier(rule.Multiplier) || rule.EffectiveAt < 0 {
			continue
		}
		normalized = append(normalized, ProfitChannelMultiplierRule{
			Key:         profitChannelMultiplierKey(parsed.GroupName, parsed.ChannelId),
			Multiplier:  rule.Multiplier,
			EffectiveAt: rule.EffectiveAt,
			Note:        strings.TrimSpace(rule.Note),
		})
	}
	sort.SliceStable(normalized, func(i, j int) bool {
		if normalized[i].Key == normalized[j].Key {
			return normalized[i].EffectiveAt < normalized[j].EffectiveAt
		}
		return normalized[i].Key < normalized[j].Key
	})
	return normalized
}

func profitChannelMultiplierRulesFromLegacyMap() []ProfitChannelMultiplierRule {
	common.OptionMapRWMutex.RLock()
	raw := common.OptionMap[ProfitProviderMultipliersOptionKey]
	common.OptionMapRWMutex.RUnlock()

	if strings.TrimSpace(raw) == "" {
		return []ProfitChannelMultiplierRule{}
	}

	var stored map[string]float64
	if err := common.UnmarshalJsonStr(raw, &stored); err != nil {
		return []ProfitChannelMultiplierRule{}
	}

	rules := make([]ProfitChannelMultiplierRule, 0, len(stored))
	for key, value := range stored {
		parsed := parseProfitChannelMultiplierKey(key)
		if parsed == nil || !isValidProfitProviderMultiplier(value) {
			continue
		}
		rules = append(rules, ProfitChannelMultiplierRule{
			Key:         profitChannelMultiplierKey(parsed.GroupName, parsed.ChannelId),
			Multiplier:  value,
			EffectiveAt: 0,
		})
	}
	return normalizeProfitChannelMultiplierRules(rules)
}

func buildProfitChannelMultiplierRulesByKey(rules []ProfitChannelMultiplierRule) map[string][]ProfitChannelMultiplierRule {
	byKey := make(map[string][]ProfitChannelMultiplierRule)
	for _, rule := range rules {
		byKey[rule.Key] = append(byKey[rule.Key], rule)
	}
	for key := range byKey {
		sort.SliceStable(byKey[key], func(i, j int) bool {
			return byKey[key][i].EffectiveAt < byKey[key][j].EffectiveAt
		})
	}
	return byKey
}

func findProfitChannelMultiplier(rules []ProfitChannelMultiplierRule, timestamp int64) (float64, bool) {
	if len(rules) == 0 {
		return 0, false
	}
	index := sort.Search(len(rules), func(i int) bool {
		return rules[i].EffectiveAt > timestamp
	})
	if index == 0 {
		return 0, false
	}
	return rules[index-1].Multiplier, true
}

func sortProfitOverviewData(data *ProfitOverviewData) {
	sort.SliceStable(data.Items, func(i, j int) bool {
		if data.Items[i].Group == data.Items[j].Group {
			if data.Items[i].ChannelId == data.Items[j].ChannelId {
				return data.Items[i].ModelName < data.Items[j].ModelName
			}
			return data.Items[i].ChannelId < data.Items[j].ChannelId
		}
		return data.Items[i].Group < data.Items[j].Group
	})
	sort.SliceStable(data.Groups, func(i, j int) bool {
		return data.Groups[i].Group < data.Groups[j].Group
	})
	sort.SliceStable(data.Providers, func(i, j int) bool {
		return data.Providers[i].Group < data.Providers[j].Group
	})
	sort.SliceStable(data.Trends, func(i, j int) bool {
		if data.Trends[i].Time == data.Trends[j].Time {
			if data.Trends[i].Group == data.Trends[j].Group {
				return data.Trends[i].ChannelId < data.Trends[j].ChannelId
			}
			return data.Trends[i].Group < data.Trends[j].Group
		}
		return data.Trends[i].Time < data.Trends[j].Time
	})
}

func SumUsedQuota(logType int, startTimestamp int64, endTimestamp int64, modelName string, username string, tokenName string, channel int, group string) (stat Stat, err error) {
	tx := LOG_DB.Table("logs").Select("sum(quota) quota")

	// 为rpm和tpm创建单独的查询
	rpmTpmQuery := LOG_DB.Table("logs").Select("count(*) rpm, sum(prompt_tokens) + sum(completion_tokens) tpm")

	if tx, err = applyExplicitLogTextFilter(tx, "username", username); err != nil {
		return stat, err
	}
	if rpmTpmQuery, err = applyExplicitLogTextFilter(rpmTpmQuery, "username", username); err != nil {
		return stat, err
	}
	if tokenName != "" {
		tx = tx.Where("token_name = ?", tokenName)
		rpmTpmQuery = rpmTpmQuery.Where("token_name = ?", tokenName)
	}
	if startTimestamp != 0 {
		tx = tx.Where("created_at >= ?", startTimestamp)
	}
	if endTimestamp != 0 {
		tx = tx.Where("created_at <= ?", endTimestamp)
	}
	if tx, err = applyExplicitLogTextFilter(tx, "model_name", modelName); err != nil {
		return stat, err
	}
	if rpmTpmQuery, err = applyExplicitLogTextFilter(rpmTpmQuery, "model_name", modelName); err != nil {
		return stat, err
	}
	if channel != 0 {
		tx = tx.Where("channel_id = ?", channel)
		rpmTpmQuery = rpmTpmQuery.Where("channel_id = ?", channel)
	}
	if group != "" {
		tx = tx.Where(logGroupCol+" = ?", group)
		rpmTpmQuery = rpmTpmQuery.Where(logGroupCol+" = ?", group)
	}

	tx = tx.Where("type = ?", LogTypeConsume)
	rpmTpmQuery = rpmTpmQuery.Where("type = ?", LogTypeConsume)

	// 只统计最近60秒的rpm和tpm
	rpmTpmQuery = rpmTpmQuery.Where("created_at >= ?", time.Now().Add(-60*time.Second).Unix())

	// 执行查询
	if err := tx.Scan(&stat).Error; err != nil {
		common.SysError("failed to query log stat: " + err.Error())
		return stat, errors.New("查询统计数据失败")
	}
	if err := rpmTpmQuery.Scan(&stat).Error; err != nil {
		common.SysError("failed to query rpm/tpm stat: " + err.Error())
		return stat, errors.New("查询统计数据失败")
	}

	return stat, nil
}

func SumUsedToken(logType int, startTimestamp int64, endTimestamp int64, modelName string, username string, tokenName string) (token int) {
	tx := LOG_DB.Table("logs").Select("ifnull(sum(prompt_tokens),0) + ifnull(sum(completion_tokens),0)")
	if username != "" {
		tx = tx.Where("username = ?", username)
	}
	if tokenName != "" {
		tx = tx.Where("token_name = ?", tokenName)
	}
	if startTimestamp != 0 {
		tx = tx.Where("created_at >= ?", startTimestamp)
	}
	if endTimestamp != 0 {
		tx = tx.Where("created_at <= ?", endTimestamp)
	}
	if modelName != "" {
		tx = tx.Where("model_name = ?", modelName)
	}
	tx.Where("type = ?", LogTypeConsume).Scan(&token)
	return token
}

func DeleteOldLog(ctx context.Context, targetTimestamp int64, limit int) (int64, error) {
	var total int64 = 0

	for {
		if nil != ctx.Err() {
			return total, ctx.Err()
		}

		result := LOG_DB.Where("created_at < ?", targetTimestamp).Limit(limit).Delete(&Log{})
		if nil != result.Error {
			return total, result.Error
		}

		total += result.RowsAffected

		if result.RowsAffected < int64(limit) {
			break
		}
	}

	return total, nil
}
