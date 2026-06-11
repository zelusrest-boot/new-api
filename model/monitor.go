package model

import "gorm.io/gorm"

type MonitorAbilityRow struct {
	ChannelId             int    `gorm:"column:channel_id"`
	ChannelName           string `gorm:"column:channel_name"`
	ChannelType           int    `gorm:"column:channel_type"`
	ChannelStatus         int    `gorm:"column:channel_status"`
	ChannelResponseTimeMs int    `gorm:"column:channel_response_time_ms"`
	ChannelTestTime       int64  `gorm:"column:channel_test_time"`
	ModelName             string `gorm:"column:model_name"`
	Group                 string `gorm:"column:ability_group"`
	AbilityEnabled        bool   `gorm:"column:ability_enabled"`
}

type MonitorLogRow struct {
	ChannelId int    `gorm:"column:channel_id"`
	ModelName string `gorm:"column:model_name"`
	Group     string `gorm:"column:group"`
	Type      int    `gorm:"column:type"`
	CreatedAt int64  `gorm:"column:created_at"`
	UseTime   int    `gorm:"column:use_time"`
	Other     string `gorm:"column:other"`
}

func GetMonitorAbilityRows(group string) ([]MonitorAbilityRow, error) {
	query := DB.Table("abilities").
		Select(
			"abilities.channel_id, abilities.model AS model_name, abilities." + commonGroupCol + " AS ability_group, " +
				"abilities.enabled AS ability_enabled, channels.name AS channel_name, channels.type AS channel_type, " +
				"channels.status AS channel_status, channels.response_time AS channel_response_time_ms, " +
				"channels.test_time AS channel_test_time",
		).
		Joins("LEFT JOIN channels ON channels.id = abilities.channel_id")

	if group != "" {
		query = query.Where("abilities."+commonGroupCol+" = ?", group)
	}

	var rows []MonitorAbilityRow
	err := query.
		Order("channels.type ASC").
		Order("channels.name ASC").
		Order("abilities.model ASC").
		Find(&rows).Error
	return rows, err
}

func GetMonitorLogsSince(since int64) ([]MonitorLogRow, error) {
	var rows []MonitorLogRow
	err := LOG_DB.Model(&Log{}).
		Select("channel_id, model_name, "+logGroupCol+", type, created_at, use_time, other").
		Where("created_at >= ? AND type IN ?", since, []int{LogTypeConsume, LogTypeError}).
		Find(&rows).Error
	if err == gorm.ErrRecordNotFound {
		return []MonitorLogRow{}, nil
	}
	return rows, err
}
