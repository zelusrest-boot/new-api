# 盈利总览 README

## 功能定位

盈利总览是管理员 Dashboard 下的经营分析页面，用于查看不同分组和渠道在指定时间范围内的收入、预估上游成本、毛利和毛利率。

该页面只面向管理员开放，不在 Dashboard 顶部 Tabbar 中展示，入口位于管理员菜单的「盈利总览」。

## 页面能力

- 查看当前周期收入、预估上游成本、毛利、毛利率。
- 使用独立筛选器查看「收入 / 成本 / 毛利趋势」。
- 使用独立筛选器查看「盈利明细」。
- 按分组、渠道和盈利状态筛选数据。
- 为指定「分组 + 渠道」录入价格倍率。
- 维护不参与盈利统计的用户名单。
- 查看倍率规则覆盖情况，识别未配置倍率的渠道。

## 统计口径

### 收入

收入使用消费日志中的 `quota` 汇总。

后端数据来源为消费日志：

- 日志类型：`LogTypeConsume`
- 时间字段：`created_at`
- 分组字段：日志中的 `group`
- 渠道字段：`channel_id`
- 模型字段：`model_name`

空分组会统一归并为 `default`。

### 预估上游成本

预估上游成本按「分组 + 渠道」倍率计算：

```text
estimated_cost_quota = quota * multiplier
```

只有命中有效倍率规则的请求才参与成本和毛利计算。

如果某个渠道没有设置对应分组下的倍率，该渠道请求仍会出现在原始日志汇总中，但不会参与盈利计算：

- 不计入有效收入 `effective_quota`
- 不计入预估成本 `estimated_cost_quota`
- 不计入有效请求数 `effective_request_count`
- 不参与毛利和毛利率统计

### 毛利

```text
gross_profit = effective_quota - estimated_cost_quota
```

### 毛利率

```text
profit_margin = gross_profit / effective_quota
```

当有效收入为 0 时，毛利率按 0 展示。

## 倍率规则

倍率规则以「分组 + 渠道」作为唯一匹配维度，不再使用供应商维度。

规则 key 格式：

```text
{group}::{channel_id}
```

示例：

```json
{
  "key": "default::2",
  "multiplier": 0.8,
  "effective_at": 1781116800,
  "note": "渠道成本价格调整"
}
```

倍率合法范围为 `0` 到 `10`。

### 生效时间

倍率变更只对生效时间之后的请求生效，不回算历史请求。

例如：

- 10:00 录入 `default::2 = 0.8`
- 10:00 之前的请求不使用该倍率
- 10:00 之后的请求使用该倍率

同一个「分组 + 渠道」可以存在多条历史规则，后端会按请求时间选择当时已经生效的最后一条规则。

## 非统计用户

非统计用户按用户名维护，不按用户组维护。

被加入非统计名单的用户：

- 不参与盈利总览主统计
- 不参与趋势和明细汇总
- 会在非统计用户管理中显示影响请求数

当前排除逻辑按 `username NOT IN (...)` 过滤消费日志。

## 前端结构

主要文件：

- `web/default/src/features/dashboard/components/profit/profit-overview.tsx`
- `web/default/src/features/dashboard/api.ts`
- `web/default/src/features/dashboard/types.ts`
- `web/default/src/features/dashboard/section-registry.tsx`
- `web/default/src/features/dashboard/index.tsx`

页面中的两个时间筛选器互相独立：

- 趋势图筛选器只影响趋势图请求和展示。
- 明细筛选器只影响明细表、指标卡和配置覆盖展示。

当某个时间范围没有数据时，对应面板仍保留筛选器，方便重新选择日期。

## 后端结构

主要文件：

- `router/api-router.go`
- `controller/usedata.go`
- `model/log.go`
- `model/option.go`
- `controller/option.go`

接口：

| Method | Path | 用途 |
| --- | --- | --- |
| `GET` | `/api/data/profit` | 获取盈利总览数据 |
| `PUT` | `/api/data/profit/multipliers` | 更新分组 / 渠道倍率规则 |
| `PUT` | `/api/data/profit/excluded-users` | 更新非统计用户 |

所有接口均需要管理员权限。

## 配置存储

盈利总览配置存储在系统 Option 中：

| Option Key | 说明 |
| --- | --- |
| `ProfitChannelMultiplierRules` | 当前使用的分组 / 渠道倍率规则 |
| `ProfitProviderMultipliers` | 旧版倍率配置，仅作为兼容回退 |
| `ProfitExcludedUsers` | 非统计用户名单 |

新增或更新 JSON 时应使用项目封装的 `common.Marshal`、`common.UnmarshalJsonStr`、`common.DecodeJson`，不要直接调用 `encoding/json` 的编解码函数。

## 测试建议

后端：

```bash
go test ./controller ./model ./router
```

前端：

```bash
cd web/default
bun run typecheck
bun run build:check
```

手工验证建议：

- 管理员菜单下可以进入盈利总览。
- 没有倍率的渠道不会参与毛利计算。
- 新增倍率后，只影响新增倍率时间之后的请求。
- 趋势图和明细表的日期筛选互不影响。
- 没有数据时仍可以重新选择日期。
- 改变分组后，渠道下拉只展示该分组下的渠道且不重复。
- 非统计用户按用户名添加和移除后，主统计结果实时刷新。
