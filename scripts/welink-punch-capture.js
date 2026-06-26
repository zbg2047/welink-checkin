/*
 * Welink Punch Capture
 *
 * 用途：
 * 监听 Welink 打卡记录查询 API 的成功响应。
 * 如果 API 返回成功，则保存本次请求的 URL、method、headers、body，
 * 供定时脚本重放查询当天打卡状态。
 *
 * 注意：
 * 本脚本会在 Surge 的 persistentStore 中保存 Cookie / Authorization 等请求头。
 * 不会保存到 Git 仓库，但请注意设备安全。
 */

const STORE_KEY = "welink_punch_daily_request_v1";
const REPLAY_HEADER_NAME = "X-Surge-Welink-Replay";

const CONFIG = {
    debug: true,

    /*
     * 开启后，每当 Welink App 调用打卡记录 API 时推送通知，
     * 显示捕获是否成功、保存时间、URL 等信息。
     * 用于调试：确认 App 是否真的访问了该接口，以及保存是否正常。
     */
    debugNotify: false,

    /*
     * 是否只保存成功响应。
     * 建议保持 true，避免保存无效 cookie 或失败请求。
     */
    saveOnlyWhenApiSuccess: true,

    /*
     * 是否保存所有请求头。
     * 你的需求是“保存请求的所有参数”，所以这里默认 true。
     * 如果想更安全，可以改成 false，并在 keepHeaderNames 中设置白名单。
     */
    saveAllHeaders: true,

    /*
     * saveAllHeaders = false 时才生效。
     */
    keepHeaderNames: [
        "cookie",
        "authorization",
        "user-agent",
        "content-type",
        "accept",
        "origin",
        "referer",
        "x-requested-with",
        "x-csrf-token"
    ],

    /*
     * 不建议保存或重放的 headers。
     */
    dropHeaderNames: [
        "host",
        "content-length",
        "accept-encoding",
        "connection"
    ]
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

        /* 跳过未替换的占位符值（形如 %someKey%） */
        if (/^%\w+%$/.test(rawValue.trim())) return;

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

function applyArguments() {
    const args = parseArguments();

    // 同时支持 snake_case 和 camelCase
    CONFIG.debug = readBool(args.debug, CONFIG.debug);
    CONFIG.debugNotify = readBool(args.debug_notify || args.debugNotify, CONFIG.debugNotify);
    CONFIG.saveOnlyWhenApiSuccess = readBool(
        args.save_only_success || args.saveOnlyWhenApiSuccess,
        CONFIG.saveOnlyWhenApiSuccess
    );
    CONFIG.saveAllHeaders = readBool(
        args.save_all_headers || args.saveAllHeaders,
        CONFIG.saveAllHeaders
    );
}

function log(message) {
    if (CONFIG.debug) {
        console.log("[WelinkPunchCapture] " + message);
    }
}

function debugNotify(title, subtitle, body) {
    if (CONFIG.debugNotify) {
        $notification.post("[Capture] " + title, subtitle || "", body || "");
    }
}

function lower(value) {
    return String(value || "").toLowerCase();
}

function nowISO() {
    return new Date().toISOString();
}

function todayLocalDate() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
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

function isReplayRequest() {
    return Boolean(getHeader($request.headers || {}, REPLAY_HEADER_NAME));
}

function shouldDropHeader(name) {
    return CONFIG.dropHeaderNames.map(lower).includes(lower(name));
}

function shouldKeepHeader(name) {
    if (shouldDropHeader(name)) return false;
    if (CONFIG.saveAllHeaders) return true;
    return CONFIG.keepHeaderNames.map(lower).includes(lower(name));
}

function cleanHeaders(headers) {
    const result = {};

    for (const key in headers || {}) {
        if (shouldKeepHeader(key)) {
            result[key] = headers[key];
        }
    }

    return result;
}

function apiResponseSuccess(body) {
    try {
        const json = JSON.parse(body || "{}");

        /*
         * 根据你给的附件：
         * {
         *   "code": "0",
         *   "message": "success",
         *   "data": {...}
         * }
         */
        if (String(json.code) === "0") return true;
        if (lower(json.message) === "success") return true;

        return false;
    } catch (e) {
        log("Response JSON parse failed: " + e);
        return false;
    }
}

function main() {
    try {
        applyArguments();

        if (isReplayRequest()) {
            log("Skip replay request.");
            $done({});
            return;
        }

        const captureTime = nowISO();
        const body = $response && $response.body ? $response.body : "";
        const apiOk = apiResponseSuccess(body);

        if (CONFIG.saveOnlyWhenApiSuccess && !apiOk) {
            log("API response is not success. Skip saving request.");
            debugNotify(
                "[Capture] API 已拦截·未保存",
                captureTime,
                "API 响应判定为失败，凭据跳过保存"
            );
            $done({});
            return;
        }

        const record = {
            version: 1,
            savedAt: captureTime,
            savedDate: todayLocalDate(),
            method: $request.method || "GET",
            url: $request.url,
            headers: cleanHeaders($request.headers || {}),
            body: $request.body || ""
        };

        const ok = $persistentStore.write(JSON.stringify(record), STORE_KEY);

        if (ok) {
            log("Saved request at " + record.savedAt);
            debugNotify(
                "[Capture] API 已捕获并保存 ✓",
                record.savedDate + " · " + captureTime.slice(11, 19),
                "凭据已更新 · " + record.method
            );
        } else {
            log("Failed to save request.");
            debugNotify(
                "[Capture] 保存失败 ✗",
                captureTime.slice(11, 19),
                "persistentStore 写入失败，请检查 Surge 存储权限"
            );
        }

        $done({});
    } catch (e) {
        log("Capture error: " + e);
        debugNotify(
            "[Capture] 脚本异常 ✗",
            nowISO().slice(11, 19),
            String(e).slice(0, 100)
        );
        $done({});
    }
}

main();
