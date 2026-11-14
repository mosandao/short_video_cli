/**
 * 时间范围解析（--since / --until）
 *
 * 支持格式（本地时区）：
 *   2026-11-13                     → 当天 00:00
 *   2026-11-13 09:30               → 指定时刻
 *   yesterday / yesterday 09:00    → 昨天 00:00 / 昨天指定时刻
 *   today     / today 09:00        → 今天 00:00 / 今天指定时刻
 *   7d / 7天前                     → 7 天前的 00:00
 *   now                            → 当前时刻（仅适合 --until）
 */

export interface TimeRange {
    /** Unix 秒（含） */
    sinceTs: number
    /** Unix 秒（含） */
    untilTs: number
}

function startOfDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** 解析单个时间参数 → Unix 秒；无效返回 null */
export function parseTimePoint(input: string): number | null {
    const raw = input.trim()
    if (!raw) return null

    const parts = raw.split(/\s+/)
    const dateToken = parts[0]
    const timeToken = parts[1]

    // HH:mm 校验
    let hh = 0, mm = 0
    if (timeToken) {
        const m = timeToken.match(/^(\d{1,2}):(\d{2})$/)
        if (!m) return null
        hh = parseInt(m[1], 10)
        mm = parseInt(m[2], 10)
        if (hh > 23 || mm > 59) return null
    }

    let base: Date | null = null

    if (dateToken === 'now' && !timeToken) {
        return Math.floor(Date.now() / 1000)
    }
    if (dateToken === 'today') {
        base = startOfDay(new Date())
    } else if (dateToken === 'yesterday') {
        base = startOfDay(new Date())
        base.setDate(base.getDate() - 1)
    } else if (/^\d+d$/.test(dateToken)) {
        base = startOfDay(new Date())
        base.setDate(base.getDate() - parseInt(dateToken, 10))
    } else if (/^\d+天前$/.test(dateToken)) {
        base = startOfDay(new Date())
        base.setDate(base.getDate() - parseInt(dateToken, 10))
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(dateToken)) {
        // 本地时区解析（new Date('YYYY-MM-DD') 会按 UTC，必须手动拆）
        const [y, mo, dd] = dateToken.split('-').map(Number)
        if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null
        base = new Date(y, mo - 1, dd)
        // 防 JS 日期滚动（如 2026-02-31 → 3月3日）
        if (base.getMonth() !== mo - 1 || base.getDate() !== dd) return null
    } else {
        return null
    }

    base.setHours(hh, mm, 0, 0)
    return Math.floor(base.getTime() / 1000)
}

/**
 * 解析 --since/--until 为范围。
 * since 缺省 = 0；until 缺省 = 当前时刻。
 * 任一参数格式非法 → 返回 { error } 交由调用方报错。
 */
export function parseTimeRange(since?: string, until?: string): TimeRange | { error: string } {
    let sinceTs = 0
    let untilTs = Math.floor(Date.now() / 1000)

    if (since) {
        const ts = parseTimePoint(since)
        if (ts === null) return { error: `--since "${since}" 无法解析。支持: YYYY-MM-DD [HH:mm] / yesterday [HH:mm] / today [HH:mm] / Nd / now` }
        sinceTs = ts
    }
    if (until) {
        const ts = parseTimePoint(until)
        if (ts === null) return { error: `--until "${until}" 无法解析。支持: YYYY-MM-DD [HH:mm] / yesterday [HH:mm] / today [HH:mm] / Nd / now` }
        untilTs = ts
    }
    if (sinceTs > untilTs) {
        return { error: `时间范围无效：--since 晚于 --until` }
    }
    return { sinceTs, untilTs }
}

/** Unix 秒 → 本地 "MM-DD HH:mm" 显示 */
export function formatTimePoint(ts: number): string {
    const d = new Date(ts * 1000)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
