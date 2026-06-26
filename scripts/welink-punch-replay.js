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
const REPLAY_HEADER_NAME = "X-Surge-Welink-Replay";

const CONFIG = {
    debug: true,

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
     * 请求超时时间，单位秒。
     */
    timeout: 20,

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

function nowText() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

function todayLocalDate() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function currentTargetCardType() {
    const hour = new Date().getHours();

    /*
     * 6:24 - 6:30 检查上午卡。
     * 18:05 - 18:30 检查下午卡。
     */
    if (hour < 12) return "1";
    return "2";
}

function cardTypeLabel(cardType) {
    return String(cardType) === "1" ? "上午" : "下午";
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
    const today = todayLocalDate();
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
        : [];

    const todayRecords = records.filter(item => String(item.date) === today);

    const morningRecord = todayRecords.find(item => String(item.cardType) === "1");
    const eveningRecord = todayRecords.find(item => String(item.cardType) === "2");

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
        targetTime: targetRecord ? String(targetRecord.time || "") : "",
        hasMorning,
        hasEvening,
        morningTime: morningRecord ? String(morningRecord.time || "") : "",
        eveningTime: eveningRecord ? String(eveningRecord.time || "") : "",
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
        notify(
            `Welink ${targetLabel}打卡状态无法确认`,
            `当前时间：${currentTime}`,
            `请求失败。按规则视为可能未打卡，请打开 Welink 确认。错误：${error}`
        );
        $done();
        return;
    }

    const statusCode = response && response.status ? String(response.status) : "unknown";

    if (!statusCode.startsWith("2")) {
        notify(
            `Welink ${targetLabel}打卡状态无法确认`,
            `当前时间：${currentTime}`,
            `HTTP 状态码：${statusCode}。按规则视为可能未打卡，请打开 Welink 确认。`
        );
        $done();
        return;
    }

    const result = parsePunchStatus(data);

    if (!result.apiSuccess) {
        notify(
            `Welink ${targetLabel}打卡状态无法确认`,
            `当前时间：${currentTime}`,
            `${result.reason}。按规则视为可能未打卡，请打开 Welink 确认。${result.detail || ""}`
        );
        $done();
        return;
    }

    if (!result.targetExists) {
        if (CONFIG.notifyWhenMissingPunch) {
            notify(
                `Welink ${result.targetLabel}还没有打卡记录`,
                `当前时间：${currentTime}`,
                `日期：${result.today}。上午：${result.hasMorning ? "已打卡 " + result.morningTime : "缺失"}；下午：${result.hasEvening ? "已打卡 " + result.eveningTime : "缺失"}。`
            );
        }

        $done();
        return;
    }

    if (CONFIG.notifyWhenAlreadyPunched) {
        notify(
            `Welink ${result.targetLabel}已检测到打卡记录`,
            `当前时间：${currentTime}`,
            `日期：${result.today}；打卡时间：${result.targetTime || "未知"}。`
        );
    }

    $done();
}

function main() {
    try {
        const raw = $persistentStore.read(STORE_KEY);

        if (!raw) {
            notify(
                "Welink 打卡检查失败",
                `当前时间：${nowText()}`,
                "尚未捕获到可重放请求。请先正常打开 Welink 并访问一次打卡记录页面。"
            );
            $done();
            return;
        }

        const record = JSON.parse(raw);
        const built = buildOptions(record);

        log("Replay method=" + built.method + ", url=" + built.requestOptions.url);

        requestWithMethod(built.method, built.requestOptions, handleReplayResult);
    } catch (e) {
        notify(
            "Welink 打卡检查脚本异常",
            `当前时间：${nowText()}`,
            String(e)
        );
        $done();
    }
}

main();