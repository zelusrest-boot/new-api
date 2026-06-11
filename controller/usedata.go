package controller

import (
	"net/http"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/gin-gonic/gin"
)

func GetAllQuotaDates(c *gin.Context) {
	startTimestamp, _ := strconv.ParseInt(c.Query("start_timestamp"), 10, 64)
	endTimestamp, _ := strconv.ParseInt(c.Query("end_timestamp"), 10, 64)
	username := c.Query("username")
	dates, err := model.GetAllQuotaDates(startTimestamp, endTimestamp, username)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    dates,
	})
	return
}

func GetQuotaDatesByUser(c *gin.Context) {
	startTimestamp, _ := strconv.ParseInt(c.Query("start_timestamp"), 10, 64)
	endTimestamp, _ := strconv.ParseInt(c.Query("end_timestamp"), 10, 64)
	dates, err := model.GetQuotaDataGroupByUser(startTimestamp, endTimestamp)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    dates,
	})
}

func GetProfitOverview(c *gin.Context) {
	startTimestamp, _ := strconv.ParseInt(c.Query("start_timestamp"), 10, 64)
	endTimestamp, _ := strconv.ParseInt(c.Query("end_timestamp"), 10, 64)
	data, err := model.GetProfitOverview(startTimestamp, endTimestamp)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    data,
	})
}

type ProfitProviderMultipliersRequest struct {
	Multipliers map[string]float64                  `json:"multipliers"`
	Rules       []model.ProfitChannelMultiplierRule `json:"rules"`
}

func UpdateProfitProviderMultipliers(c *gin.Context) {
	var req ProfitProviderMultipliersRequest
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"success": false,
			"message": "无效的参数",
		})
		return
	}
	rules := req.Rules
	if rules == nil {
		now := time.Now().Unix()
		rules = make([]model.ProfitChannelMultiplierRule, 0, len(req.Multipliers))
		for key, value := range req.Multipliers {
			rules = append(rules, model.ProfitChannelMultiplierRule{
				Key:         key,
				Multiplier:  value,
				EffectiveAt: now,
			})
		}
	}
	rules = model.NormalizeProfitChannelMultiplierRules(rules)

	bytes, err := common.Marshal(rules)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	raw := string(bytes)
	if err := model.ValidateProfitChannelMultiplierRules(raw); err != nil {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"message": err.Error(),
		})
		return
	}
	if err := model.UpdateOption(model.ProfitChannelMultiplierRulesOptionKey, raw); err != nil {
		common.ApiError(c, err)
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data": gin.H{
			"multipliers": model.GetProfitProviderMultipliers(),
			"rules":       model.GetProfitChannelMultiplierRules(),
		},
	})
}

type ProfitExcludedUsersRequest struct {
	Users []model.ProfitExcludedUser `json:"users"`
}

func UpdateProfitExcludedUsers(c *gin.Context) {
	var req ProfitExcludedUsersRequest
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"success": false,
			"message": "无效的参数",
		})
		return
	}
	if req.Users == nil {
		req.Users = []model.ProfitExcludedUser{}
	}

	bytes, err := common.Marshal(req.Users)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	raw := string(bytes)
	if err := model.ValidateProfitExcludedUsers(raw); err != nil {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"message": err.Error(),
		})
		return
	}
	if err := model.UpdateOption(model.ProfitExcludedUsersOptionKey, raw); err != nil {
		common.ApiError(c, err)
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    model.GetProfitExcludedUsers(),
	})
}

func GetUserQuotaDates(c *gin.Context) {
	userId := c.GetInt("id")
	startTimestamp, _ := strconv.ParseInt(c.Query("start_timestamp"), 10, 64)
	endTimestamp, _ := strconv.ParseInt(c.Query("end_timestamp"), 10, 64)
	// 判断时间跨度是否超过 1 个月
	if endTimestamp-startTimestamp > 2592000 {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"message": "时间跨度不能超过 1 个月",
		})
		return
	}
	dates, err := model.GetQuotaDataByUserId(userId, startTimestamp, endTimestamp)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    dates,
	})
	return
}
