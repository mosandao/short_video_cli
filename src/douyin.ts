/**
 * 抖音路由辅助
 *
 * yt-dlp 的抖音 extractor 未实现 a_bogus 签名（上游 TODO，登录 cookie 也无效），
 * 因此抖音链接一律自动路由到浏览器模式（专属登录实例 + CDP 拦截），
 * 用户无需手动加 --browser。
 */

/** 是否为抖音系链接（含分享短链） */
export function isDouyinUrl(url: string): boolean {
    try {
        const host = new URL(url).hostname.toLowerCase()
        return /(^|\.)(douyin\.com|iesdouyin\.com)$/.test(host)
    } catch {
        return false
    }
}

/** 抖音分享短链（v.douyin.com/xxx、iesdouyin.com/share/...） */
export function isDouyinShareLink(url: string): boolean {
    try {
        const host = new URL(url).hostname.toLowerCase()
        const path = new URL(url).pathname
        return host === 'v.douyin.com'
            || (host.endsWith('.iesdouyin.com') && path.startsWith('/share/'))
            || (host === 'www.douyin.com' && path.startsWith('/share/'))
    } catch {
        return false
    }
}

/** 抖音用户主页（含 modal_id 的视频弹层除外——那是单视频） */
export function isDouyinProfileUrl(url: string): boolean {
    return /douyin\.com\/user\//.test(url) && !url.includes('modal_id=')
}

/**
 * 主页链接清洗：去掉 ?from_tab_name=main&vid=xxx 之类跳转参数。
 * vid 会让浏览器打开视频弹层、盖住主页网格，干扰滚动枚举——一律剥掉，
 * 只保留 sec_uid 路径。（vid 对应的单视频请用 douyin.com/video/<vid> 链接）
 */
export function cleanDouyinUserUrl(url: string): string {
    if (!isDouyinProfileUrl(url)) return url
    try {
        const u = new URL(url)
        return `https://www.douyin.com${u.pathname}`
    } catch {
        return url
    }
}

/**
 * 解析分享短链得到最终 URL（HEAD 跟随重定向；抖音对 HEAD 不友好时回退 GET）。
 * 失败时原样返回，由浏览器导航时自然完成跳转。
 */
export async function resolveDouyinShareLink(url: string): Promise<string> {
    if (!isDouyinShareLink(url)) return url
    for (const method of ['HEAD', 'GET'] as const) {
        try {
            const res = await fetch(url, {
                method,
                redirect: 'follow',
                headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
                signal: AbortSignal.timeout(10_000),
            })
            // GET 时不读 body，直接断开
            if (res.url && !isDouyinShareLink(res.url)) {
                return res.url
            }
        } catch {
            // 尝试下一种方法
        }
    }
    return url
}
