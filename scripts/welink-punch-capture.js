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
    const raw = typeof $argument === "string" ? $argument : "";
    const result = {};

    raw.split("&").forEach(pair => {
        if (!pair) return;

        const eqIndex = pair.indexOf("=");
        const rawKey = eqIndex >= 0 ? pair.slice(0, eqIndex) : pair;
        const rawValue = eqIndex >= 0 ? pair.slice(eqIndex + 1) : "true";

        const key = decodeURIComponent(rawKey || "").trim();
        if (!key) return;

        result[key] = decodeURIComponent(rawValue || "").trim();
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

    CONFIG.debug = readBool(args.debug, CONFIG.debug);
    CONFIG.debugNotify = readBool(args.debug_notify, CONFIG.debugNotify);
    CONFIG.saveOnlyWhenApiSuccess = readBool(
        args.save_only_success,
        CONFIG.saveOnlyWhenApiSuccess
    );
    CONFIG.saveAllHeaders = readBool(args.save_all_headers, CONFIG.saveAllHeaders);
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
                "API 调用已拦截（未保存）",
                "时间：" + captureTime,
                "save_only_success=true，但本次 API 响应判定为失败，跳过保存。\n" +
                "响应前 200 字符：" + body.slice(0, 200)
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
                "API 调用已捕获并保存 ✓",
                "保存时间：" + captureTime,
                "日期：" + record.savedDate +
                "\nMethod：" + record.method +
                "\nAPI 响应：" + (apiOk ? "成功 (code=0)" : "未检查") +
                "\nURL（前 80 字符）：" + record.url.slice(0, 80)
            );
        } else {
            log("Failed to save request.");
            debugNotify(
                "API 调用已拦截（保存失败）✗",
                "时间：" + captureTime,
                "persistentStore.write 返回 false，凭据未能保存。请检查 Surge 存储权限。"
            );
        }

        $done({});
    } catch (e) {
        log("Capture error: " + e);
        debugNotify(
            "Capture 脚本异常 ✗",
            nowISO(),
            String(e)
        );
        $done({});
    }
}

main();
