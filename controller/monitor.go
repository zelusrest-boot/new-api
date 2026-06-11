package controller

import (
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

func GetMonitorAvailability(c *gin.Context) {
	channelType, _ := strconv.Atoi(c.Query("channel_type"))
	data, err := service.GetMonitorAvailability(service.MonitorAvailabilityParams{
		Query:       c.Query("q"),
		Group:       c.Query("group"),
		ChannelType: channelType,
		Status:      c.Query("status"),
	})
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, data)
}
