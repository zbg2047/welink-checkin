# Surge Welink Punch Check

这是一个 Surge iOS 模块，用于捕获 Welink 打卡记录查询 API 的成功请求，并在指定时间重放查询请求，判断当天上午/下午是否已有打卡记录。

它只做“查询状态 + 通知提醒”，不会伪造或代替实际打卡。

## 功能

- 捕获 API：
  `https://api.welink.huaweicloud.com/mcloud/mag/ProxyForText/attendance_report_api/v1/user/statistics/dailyPunchCardRecords`
- API 成功返回时，保存本次请求的 URL、method、headers、body
- 每天 06:24 - 06:30 每分钟检查一次上午打卡
- 每天 18:05 - 18:30 每 3 分钟检查一次下午打卡
- 模块内保留 `type=generic` 重放脚本条目；是否能在 Surge 脚本页手动运行取决于 Surge 是否展示模块注入的脚本
- 根据返回 JSON 中的 `data.records[].date` 和 `cardType` / `cardtype` / `card_type` 判断打卡状态
- `cardType = 1` 表示上午
- `cardType = 2` 表示下午
- 如果 API 请求失败或 API 返回失败，按配置视为“可能未打卡”提醒

## 文件结构

```text
modules/welink-punch-check.sgmodule
scripts/welink-punch-capture.js
scripts/welink-punch-replay.js
```

## 使用方式

1. 在 Surge 中安装 `modules/welink-punch-check.sgmodule`。
2. 打开 MITM，并确认证书已信任，域名包含 `api.welink.huaweicloud.com`。
3. 正常打开 Welink，并进入一次打卡记录页面，让模块捕获到这个 API 的成功请求。
4. 后续定时任务会重放已保存的查询请求，并按当天 `date` 判断上午/下午是否缺少记录。

## 模块和脚本的区别

- `.sgmodule` 是模块：它是对当前 Profile 的配置补丁。模块可以包含 `[Script]`，但这表示“把脚本规则插入最终配置”，不等于这些脚本一定会出现在 Surge 的脚本列表 UI。
- `[Script]` 是脚本配置：官方脚本文档里的“长按脚本手动触发”，前提是该脚本在 Surge 的脚本列表里可见。
- 如果你的 Surge 脚本页为空，并且安装的其他模块也都没有显示脚本，那么模块注入的脚本在你的 UI 中不可手动长按运行。这种情况下，本模块只能可靠完成捕获和定时 cron 检查，不能依赖 `welink_punch_check_manual` 做手动入口。
- 可靠的手动运行方式是把 `welink_punch_check_manual` 这类 `type=generic` 脚本条目放到当前 Profile 的 `[Script]` 中，或在 iOS 快捷指令里能直接选到该脚本时触发。

## Surge 可编辑参数

模块头部使用官方 `#!arguments=...` 声明可编辑参数，脚本行再用 `%参数名%` 占位传给 `$argument`。

注意：在当前 Surge iOS UI 上，模块参数编辑页可能只显示一个原始 query-string 输入框，不会拆成多行表单。为了避免长参数不可编辑，本模块只暴露三个常用参数：

```text
date=auto&manual=auto&timeout=2
```

- `date=auto`：`auto` 或 `today` 表示今天；也可以手动填 `2026-06-26`。
- `manual=auto`：手动 generic 脚本的目标卡类型；`auto` 按当前时间判断，也可以填 `1` 或 `2`。定时任务上午固定 `1`，下午固定 `2`。
- `timeout=2`：重放查询请求超时时间，单位秒。

捕获脚本固定为只保存成功响应并保存请求 headers；重放脚本固定为缺卡、请求失败、已打卡都会通知。如需高级覆盖 headers/query/body，请直接编辑模块中对应脚本行的 `argument="..."`。

### 覆盖请求参数

如果你直接编辑脚本行的 `argument`，可以传 URL 编码后的 JSON 覆盖已保存请求中的对应内容。

```text
override_headers=%7B%22User-Agent%22%3A%22xxx%22%7D
override_query=%7B%22lang%22%3A%22zh%22%7D
override_json_body=%7B%22date%22%3A%222026-06-26%22%7D
override_form_body=%7B%22date%22%3A%222026-06-26%22%7D
```

如果你是直接编辑脚本行的 `argument`，也可以使用简写参数：

```text
header.User-Agent=xxx
query.lang=zh
json.date=2026-06-26
form.date=2026-06-26
```
