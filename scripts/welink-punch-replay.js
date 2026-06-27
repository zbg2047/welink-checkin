/*
 * Welink Punch Replay
 *
 * 用途：
 * 从 Surge persistentStore 读取已保存的 Welink 请求参数，
 * 在指定 cron 时间重放查询请求，并根据返回 JSON 判断当天上午/下午是否已打卡。
 *
 * 逻辑：
 * - cardType = "1"：上午打卡
 * - cardType = "2"：下午打卡
 * - 只使用 date 等于今天的记录，避免误判前一天记录
 * - API 请求失败或返回失败时，按“打卡状态无法确认/可能未打卡”通知
 */

const STORE_KEY = "welink_punch_daily_request_v1";
const STATUS_STORE_KEY = "welink_punch_daily_status_v1";
const REPLAY_HEADER_NAME = "X-Surge-Welink-Replay";

const CONFIG = {
    debug: true,

    /*
     * 开启后，每次重放 API 调用时会推送额外的 debug 通知：
     * - 脚本启动时：显示目标类型、日期、已存凭据的保存时间
     * - HTTP 响应后：显示状态码、响应体前 300 字符
     * - 解析完成后：显示今日所有打卡记录的详细信息
     */
    debugNotify: false,

    /*
     * auto/today：使用本地今天；也可以手动填 2026-06-26。
     */
    targetDate: "auto",

    /*
     * 已打卡时是否也通知。
     * true：每次检查都会通知结果。
     * false：只有缺卡/失败时通知。
     */
    notifyWhenAlreadyPunched: true,

    /*
     * 如果当天记录里缺少目标 cardType，就通知提醒打卡。
     */
    notifyWhenMissingPunch: true,

    /*
     * API 失败时是否按“未打卡/需要确认”通知。
     */
    treatApiFailureAsMissing: true,

    /*
     * 请求超时时间，单位秒。
     */
    timeout: 2,

    /*
     * 允许你覆盖部分 headers。
     *
     * 示例：
     * overrideHeaders: {
     *   "User-Agent": "xxx"
     * }
     */
    overrideHeaders: {},

    /*
     * 允许你覆盖 URL query 参数。
     *
     * 示例：
     * overrideQuery: {
     *   "lang": "zh"
     * }
     */
    overrideQuery: {},

    /*
     * 如果请求 body 是 JSON，允许覆盖 JSON 字段。
     *
     * 示例：
     * overrideJsonBody: {
     *   "date": "2026-06-26"
     * }
     */
    overrideJsonBody: {},

    /*
     * 如果请求 body 是 application/x-www-form-urlencoded，
     * 允许覆盖 form 字段。
     *
     * 示例：
     * overrideFormBody: {
     *   "date": "2026-06-26"
     * }
     */
    overrideFormBody: {}
};

function parseArguments() {
    let raw = typeof $argument === "string" ? $argument : "";
    
    // 去除可能存在的首尾双引号或单引号
    raw = raw.replace(/^"|"$/g, "").replace(/^'|'$/g, "").trim();
    if (!raw) return {};

    const result = {};
    
    // 支持 &、逗号、分号作为参数分隔符
    const segments = raw.split(/[&,;]/).map(s => s.trim()).filter(Boolean);

    segments.forEach(pair => {
        // 支持 = 或 : 作为键值对的分隔符
        const eqIndex = pair.indexOf("=");
        const colonIndex = pair.indexOf(":");
        let splitIndex = -1;

        if (eqIndex >= 0 && colonIndex >= 0) {
            splitIndex = Math.min(eqIndex, colonIndex);
        } else {
            splitIndex = Math.max(eqIndex, colonIndex);
        }

        const rawKey = splitIndex >= 0 ? pair.slice(0, splitIndex) : pair;
        const rawValue = splitIndex >= 0 ? pair.slice(splitIndex + 1) : "true";

        /*
         * 如果模块变量未能正确替换，rawKey 或 rawValue 可能是
         * 形如 %date% 的原始占位符。decodeURIComponent 会对其中的
         * %XX 字节序列解码，遇到非法序列时抛出 URIError。
         * 这里用 try-catch 兜底：解码失败时跳过该键，
         * 让 applyArguments 中对应的 CONFIG 字段保持默认值。
         */
        let key;
        try {
            key = decodeURIComponent(rawKey || "").trim();
        } catch (e) {
            return;
        }

        if (!key) return;

        /* 跳过未替换的占位符值（形如 %someKey% 或 {{{someKey}}}） */
        if (/^%\w+%$/.test(rawValue.trim())) return;
        if (/^\{\{\{[\w.-]+\}\}\}$/.test(rawValue.trim())) return;

        let value;
        try {
            value = decodeURIComponent(rawValue || "").trim();
        } catch (e) {
            return;
        }

        // 去除值里可能存在的首尾引号
        value = value.replace(/^"|"$/g, "").replace(/^'|'$/g, "").trim();

        result[key] = value;
    });

    return result;
}

function readBool(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;

    const text = lower(value);
    if (["1", "true", "yes", "y", "on"].includes(text)) return true;
    if (["0", "false", "no", "n", "off"].includes(text)) return false;

    return fallback;
}

function readNumber(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;

    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function parseJsonObject(value, fallback) {
    if (!value) return fallback;

    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : fallback;
    } catch (e) {
        log("Argument JSON parse failed, keep fallback: " + e);
        return fallback;
    }
}

function collectPrefixedArguments(args, prefix) {
    const result = {};
    const fullPrefix = prefix + ".";

    for (const key in args) {
        if (key.indexOf(fullPrefix) !== 0) continue;

        const targetKey = key.slice(fullPrefix.length);
        if (targetKey) result[targetKey] = args[key];
    }

    return result;
}

function mergeObjects(base, extra) {
    const result = {};

    for (const key in base || {}) {
        result[key] = base[key];
    }

    for (const key in extra || {}) {
        result[key] = extra[key];
    }

    return result;
}

function applyArguments() {
    const args = parseArguments();

    // 同时支持 snake_case 和 camelCase
    CONFIG.debug = readBool(args.debug, CONFIG.debug);
    CONFIG.debugNotify = readBool(args.debug_notify || args.debugNotify, CONFIG.debugNotify);
    CONFIG.targetDate = args.target_date || args.targetDate || CONFIG.targetDate;
    CONFIG.notifyWhenAlreadyPunched = readBool(
        args.notify_when_already_punched || args.notifyWhenAlreadyPunched,
        CONFIG.notifyWhenAlreadyPunched
    );
    CONFIG.notifyWhenMissingPunch = readBool(
        args.notify_when_missing_punch || args.notifyWhenMissingPunch,
        CONFIG.notifyWhenMissingPunch
    );
    CONFIG.treatApiFailureAsMissing = readBool(
        args.treat_api_failure_as_missing || args.treatApiFailureAsMissing,
        CONFIG.treatApiFailureAsMissing
    );
    CONFIG.timeout = readNumber(
        args.request_timeout || args.timeout || args.requestTimeout,
        CONFIG.timeout
    );

    CONFIG.overrideHeaders = mergeObjects(
        CONFIG.overrideHeaders,
        parseJsonObject(args.override_headers || args.overrideHeaders, {})
    );
    CONFIG.overrideQuery = mergeObjects(
        CONFIG.overrideQuery,
        parseJsonObject(args.override_query || args.overrideQuery, {})
    );
    CONFIG.overrideJsonBody = mergeObjects(
        CONFIG.overrideJsonBody,
        parseJsonObject(args.override_json_body || args.overrideJsonBody, {})
    );
    CONFIG.overrideFormBody = mergeObjects(
        CONFIG.overrideFormBody,
        parseJsonObject(args.override_form_body || args.overrideFormBody, {})
    );

    CONFIG.overrideHeaders = mergeObjects(
        CONFIG.overrideHeaders,
        collectPrefixedArguments(args, "header")
    );
    CONFIG.overrideQuery = mergeObjects(
        CONFIG.overrideQuery,
        collectPrefixedArguments(args, "query")
    );
    CONFIG.overrideJsonBody = mergeObjects(
        CONFIG.overrideJsonBody,
        collectPrefixedArguments(args, "json")
    );
    CONFIG.overrideFormBody = mergeObjects(
        CONFIG.overrideFormBody,
        collectPrefixedArguments(args, "form")
    );
}

function log(message) {
    if (CONFIG.debug) {
        console.log("[WelinkPunchReplay] " + message);
    }
}

function lower(value) {
    return String(value || "").toLowerCase();
}

function notify(title, subtitle, body) {
    $notification.post(title, subtitle || "", body || "");
}

function debugNotify(title, subtitle, body) {
    if (CONFIG.debugNotify) {
        $notification.post(title, subtitle || "", body || "");
    }
}

function nowText() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${day} ${hh}:${mm}`;
}

function readStatusState() {
    const fallback = {
        version: 1,
        confirmed: {}
    };
    const raw = $persistentStore.read(STATUS_STORE_KEY);

    if (!raw) return fallback;

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return fallback;
        if (!parsed.confirmed || typeof parsed.confirmed !== "object") parsed.confirmed = {};
        return parsed;
    } catch (e) {
        log("Failed to parse status store: " + e);
        return fallback;
    }
}

function wasPunchAlreadyConfirmed(state, date, cardType) {
    const dateState = state && state.confirmed && state.confirmed[date];
    return Boolean(dateState && dateState[String(cardType)]);
}

function markPunchConfirmed(state, date, cardType, punchTime) {
    const existingDateState = state && state.confirmed && state.confirmed[date]
        ? state.confirmed[date]
        : {};

    const nextState = {
        version: 1,
        updatedAt: nowText(),
        confirmed: {}
    };

    nextState.confirmed[date] = existingDateState;
    nextState.confirmed[date][String(cardType)] = {
        label: cardTypeLabel(cardType),
        punchTime: punchTime || "",
        confirmedAt: nowText()
    };

    const ok = $persistentStore.write(JSON.stringify(nextState), STATUS_STORE_KEY);
    if (!ok) log("Failed to write status store.");
}

function todayLocalDate() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function targetLocalDate() {
    const value = lower(CONFIG.targetDate);

    if (!value || value === "auto" || value === "today") {
        return todayLocalDate();
    }

    return String(CONFIG.targetDate);
}

function currentTargetCardType() {
    const hour = new Date().getHours();

    /*
     * 按脚本实际运行时刻判断上午/下午，避免模块参数替换失败或手动参数导致标题偏移。
     */
    if (hour < 12) return "1";
    return "2";
}

function cardTypeLabel(cardType) {
    return String(cardType) === "1" ? "上午" : "下午";
}

function firstDefined(object, names) {
    for (let i = 0; i < names.length; i++) {
        const name = names[i];

        if (
            object &&
            Object.prototype.hasOwnProperty.call(object, name) &&
            object[name] !== null &&
            object[name] !== undefined
        ) {
            return object[name];
        }
    }

    return "";
}

function recordDate(record) {
    const value = firstDefined(record, ["date", "punchDate", "workDate"]);
    return String(value || "").slice(0, 10);
}

function recordCardType(record) {
    return String(firstDefined(record, ["cardType", "cardtype", "card_type"]));
}

function minutePunchTime(value) {
    const text = String(value || "");
    const match = text.match(/\b(\d{1,2}):(\d{2})/);
    if (!match) return text;

    return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function getHeader(headers, name) {
    const target = lower(name);
    for (const key in headers || {}) {
        if (lower(key) === target) {
            return headers[key];
        }
    }
    return "";
}

function mergeHeaders(base, override) {
    const result = {};

    for (const key in base || {}) {
        result[key] = base[key];
    }

    for (const key in override || {}) {
        result[key] = override[key];
    }

    result[REPLAY_HEADER_NAME] = "1";

    return result;
}

function applyQueryOverrides(url, overrides) {
    if (!overrides || Object.keys(overrides).length === 0) {
        return url;
    }

    const hashIndex = url.indexOf("#");
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
    const urlWithoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;

    const queryIndex = urlWithoutHash.indexOf("?");
    const base = queryIndex >= 0 ? urlWithoutHash.slice(0, queryIndex) : urlWithoutHash;
    const query = queryIndex >= 0 ? urlWithoutHash.slice(queryIndex + 1) : "";

    const params = {};

    if (query) {
        query.split("&").forEach(pair => {
            if (!pair) return;

            const eqIndex = pair.indexOf("=");
            if (eqIndex >= 0) {
                const key = decodeURIComponent(pair.slice(0, eqIndex));
                const value = decodeURIComponent(pair.slice(eqIndex + 1));
                params[key] = value;
            } else {
                params[decodeURIComponent(pair)] = "";
            }
        });
    }

    for (const key in overrides) {
        params[key] = String(overrides[key]);
    }

    const newQuery = Object.keys(params)
        .map(key => encodeURIComponent(key) + "=" + encodeURIComponent(params[key]))
        .join("&");

    return base + (newQuery ? "?" + newQuery : "") + hash;
}

function contentType(headers) {
    return lower(getHeader(headers || {}, "content-type"));
}

function parseFormBody(body) {
    const result = {};

    String(body || "").split("&").forEach(pair => {
        if (!pair) return;

        const eqIndex = pair.indexOf("=");
        if (eqIndex >= 0) {
            const key = decodeURIComponent(pair.slice(0, eqIndex));
            const value = decodeURIComponent(pair.slice(eqIndex + 1));
            result[key] = value;
        } else {
            result[decodeURIComponent(pair)] = "";
        }
    });

    return result;
}

function stringifyFormBody(params) {
    return Object.keys(params)
        .map(key => encodeURIComponent(key) + "=" + encodeURIComponent(params[key]))
        .join("&");
}

function applyBodyOverrides(body, headers) {
    const ct = contentType(headers);
    const rawBody = body || "";

    if (
        ct.includes("application/json") &&
        Object.keys(CONFIG.overrideJsonBody || {}).length > 0
    ) {
        try {
            const json = JSON.parse(rawBody || "{}");

            for (const key in CONFIG.overrideJsonBody) {
                json[key] = CONFIG.overrideJsonBody[key];
            }

            return JSON.stringify(json);
        } catch (e) {
            log("Failed to parse JSON body, keep original body: " + e);
            return rawBody;
        }
    }

    if (
        ct.includes("application/x-www-form-urlencoded") &&
        Object.keys(CONFIG.overrideFormBody || {}).length > 0
    ) {
        const form = parseFormBody(rawBody);

        for (const key in CONFIG.overrideFormBody) {
            form[key] = String(CONFIG.overrideFormBody[key]);
        }

        return stringifyFormBody(form);
    }

    return rawBody;
}

function parsePunchStatus(responseBody) {
    const today = targetLocalDate();
    const targetCardType = currentTargetCardType();
    const targetLabel = cardTypeLabel(targetCardType);

    let json;

    try {
        json = JSON.parse(responseBody || "{}");
    } catch (e) {
        return {
            apiSuccess: false,
            reason: "返回内容不是 JSON",
            detail: String(responseBody || "").slice(0, 500)
        };
    }

    if (String(json.code) !== "0") {
        return {
            apiSuccess: false,
            reason: "API 返回失败",
            detail: JSON.stringify({
                code: json.code,
                message: json.message
            }).slice(0, 500)
        };
    }

    const records = json && json.data && Array.isArray(json.data.records)
        ? json.data.records
        : (Array.isArray(json.records) ? json.records : []);

    const todayRecords = records.filter(item => recordDate(item) === today);

    const morningRecord = todayRecords.find(item => recordCardType(item) === "1");
    const eveningRecord = todayRecords.find(item => recordCardType(item) === "2");

    const hasMorning = Boolean(morningRecord);
    const hasEvening = Boolean(eveningRecord);

    const targetRecord = targetCardType === "1" ? morningRecord : eveningRecord;
    const targetExists = Boolean(targetRecord);

    return {
        apiSuccess: true,
        today,
        targetCardType,
        targetLabel,
        targetExists,
        targetTime: targetRecord ? minutePunchTime(targetRecord.time) : "",
        hasMorning,
        hasEvening,
        morningTime: morningRecord ? minutePunchTime(morningRecord.time) : "",
        eveningTime: eveningRecord ? minutePunchTime(eveningRecord.time) : "",
        todayRecordCount: todayRecords.length,
        allRecordCount: records.length
    };
}

function buildOptions(record) {
    const method = String(record.method || "GET").toUpperCase();
    const headers = mergeHeaders(record.headers || {}, CONFIG.overrideHeaders || {});
    const url = applyQueryOverrides(record.url, CONFIG.overrideQuery || {});
    const body = applyBodyOverrides(record.body || "", headers);

    return {
        method,
        requestOptions: {
            url,
            headers,
            body,
            timeout: CONFIG.timeout,
            "auto-cookie": false
        }
    };
}

function requestWithMethod(method, options, callback) {
    if (method === "POST") {
        $httpClient.post(options, callback);
    } else if (method === "PUT") {
        $httpClient.put(options, callback);
    } else if (method === "PATCH") {
        $httpClient.patch(options, callback);
    } else if (method === "DELETE") {
        $httpClient.delete(options, callback);
    } else {
        $httpClient.get(options, callback);
    }
}

function handleReplayResult(error, response, data) {
    const currentTime = nowText();
    const targetCardType = currentTargetCardType();
    const targetLabel = cardTypeLabel(targetCardType);

    if (error) {
        log("Replay request failed: " + String(error));
        notify(
            CONFIG.treatApiFailureAsMissing
                ? `⚠️ ${targetLabel}可能还没打卡`
                : `⚠️ ${targetLabel}状态无法确认`,
            currentTime,
            "请求失败"
        );
        $done();
        return;
    }

    const statusCode = response && response.status ? String(response.status) : "unknown";

    debugNotify(
        "接口有响应",
        `HTTP ${statusCode} · ${currentTime.slice(11)}`,
        "已收到返回"
    );

    if (!statusCode.startsWith("2")) {
        log("Replay HTTP status is not 2xx: " + statusCode + ", response=" + String(data || "").slice(0, 500));
        notify(
            CONFIG.treatApiFailureAsMissing
                ? `⚠️ ${targetLabel}可能还没打卡`
                : `⚠️ ${targetLabel}状态无法确认`,
            currentTime,
            `HTTP ${statusCode}`
        );
        $done();
        return;
    }

    const result = parsePunchStatus(data);

    if (!result.apiSuccess) {
        log("Replay API parse/status failed: " + result.reason + ", detail=" + (result.detail || ""));
        notify(
            CONFIG.treatApiFailureAsMissing
                ? `⚠️ ${targetLabel}可能还没打卡`
                : `⚠️ ${targetLabel}状态无法确认`,
            currentTime,
            result.reason
        );
        $done();
        return;
    }

    debugNotify(
        "今日打卡详情",
        `${result.today} · ${result.allRecordCount} 条`,
        `上午 ${result.hasMorning ? "✓ " + result.morningTime : "✗"} · 下午 ${result.hasEvening ? "✓ " + result.eveningTime : "✗"}\n目标 ${result.targetLabel}：${result.targetExists ? "✓ " + result.targetTime : "✗ 未找到"}`
    );

    if (!result.targetExists) {
        if (CONFIG.notifyWhenMissingPunch) {
            notify(
                `⏰ ${result.targetLabel}还没有打卡，快点打卡`,
                `${result.today} · ${currentTime.slice(11)}`,
                `上午 ${result.hasMorning ? "✓ " + result.morningTime : "✗ 缺失"} · 下午 ${result.hasEvening ? "✓ " + result.eveningTime : "✗ 缺失"}`
            );
        }

        $done();
        return;
    }

    if (CONFIG.notifyWhenAlreadyPunched) {
        const statusState = readStatusState();

        if (wasPunchAlreadyConfirmed(statusState, result.today, result.targetCardType)) {
            log(`Skip duplicate punched notification: ${result.today} ${result.targetLabel}`);
            $done();
            return;
        }

        markPunchConfirmed(statusState, result.today, result.targetCardType, result.targetTime);

        notify(
            `✅ 已成功打卡，${result.targetLabel}不再提醒`,
            `${result.today} · 打卡时间 ${result.targetTime || "未知"}`,
            `上午 ${result.hasMorning ? "✓ " + result.morningTime : "✗ 缺失"} · 下午 ${result.hasEvening ? "✓ " + result.eveningTime : "✗ 缺失"}`
        );
    } else {
        const statusState = readStatusState();
        if (!wasPunchAlreadyConfirmed(statusState, result.today, result.targetCardType)) {
            markPunchConfirmed(statusState, result.today, result.targetCardType, result.targetTime);
        }
    }

    $done();
}

function main() {
    try {
        applyArguments();

        const plannedDate = targetLocalDate();
        const plannedCardType = currentTargetCardType();
        const plannedLabel = cardTypeLabel(plannedCardType);
        const statusState = readStatusState();

        if (wasPunchAlreadyConfirmed(statusState, plannedDate, plannedCardType)) {
            log(`Skip check, punch already confirmed: ${plannedDate} ${plannedLabel}`);
            $done();
            return;
        }

        const raw = $persistentStore.read(STORE_KEY);

        if (!raw) {
            notify(
                "⚠️ 打卡检查失败",
                nowText(),
                "尚未捕获凭据，请先打开打卡记录页面"
            );
            $done();
            return;
        }

        const record = JSON.parse(raw);

        debugNotify(
            "检查已启动",
            `${plannedLabel} · ${plannedDate} · ${nowText().slice(11)}`,
            `凭据日期：${record.savedDate || "未知"} · timeout ${CONFIG.timeout}s`
        );

        const built = buildOptions(record);

        log("Replay method=" + built.method + ", url=" + built.requestOptions.url);

        requestWithMethod(built.method, built.requestOptions, handleReplayResult);
    } catch (e) {
        log("Replay script error: " + e);
        notify(
            "⚠️ 打卡检查脚本异常",
            nowText(),
            "脚本异常"
        );
        $done();
    }
}

main();
