# Surge Welink Punch Check

这是一个 Surge iOS 模块，用于捕获 Welink 打卡记录查询 API 的成功请求，并在指定时间重放查询请求，判断当天上午/下午是否已有打卡记录。

## 功能

- 捕获 API：
  `https://api.welink.huaweicloud.com/mcloud/mag/ProxyForText/attendance_report_api/v1/user/statistics/dailyPunchCardRecords`
- API 成功返回时，保存本次请求的 URL、method、headers、body
- 每天 06:24 - 06:30 每分钟检查一次上午打卡
- 每天 18:05 - 18:30 每 3 分钟检查一次下午打卡
- 根据返回 JSON 中的 `data.records[].date` 和 `data.records[].cardType` 判断打卡状态
- `cardType = 1` 表示上午
- `cardType = 2` 表示下午
- 如果 API 请求失败或 API 返回失败，按“状态无法确认/可能未打卡”提醒

## 文件结构

```text
modules/welink-punch-check.sgmodule
scripts/welink-punch-capture.js
scripts/welink-punch-replay.js