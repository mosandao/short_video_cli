/**
 * cookie 桥：从专属登录浏览器读取 cookie，转换为引擎协议格式
 *
 * 读取走 CDP page.cookies(url)——只读本地 cookie jar，不导航到目标站点，
 * 对平台风控完全无感；凭据仅存内存，经 stdin 管道传给引擎进程。
 */

import { ensureLoginBrowser, loginBrowserAlive, loginBrowserUrl, stopLoginBrowser } from './loginBrowser.js'
import type { EngineCookie } from './engine/types.js'

/** 域名 → 登录页映射（svdl login 用） */
const LOGIN_PAGES: Array<{ match: RegExp; url: string; name: string }> = [
    { match: /douyin\.com$/, url: 'https://www.douyin.com/', name: '抖音' },
    { match: /bilibili\.com$|bilibili\.tv$|b23\.tv$/, url: 'https://www.bilibili.com/', name: 'Bilibili' },
    { match: /youtube\.com$|youtu\.be$/, url: 'https://www.youtube.com/', name: 'YouTube' },
    { match: /xiaohongshu\.com$|xhslink\.com$/, url: 'https://www.xiaohongshu.com/', name: '小红书' },
    { match: /weibo\.com$/, url: 'https://weibo.com/', name: '微博' },
    { match: /tiktok\.com$/, url: 'https://www.tiktok.com/', name: 'TikTok' },
    { match: /instagram\.com$/, url: 'https://www.instagram.com/', name: 'Instagram' },
    { match: /x\.com$|twitter\.com$/, url: 'https://x.com/', name: 'X/Twitter' },
]

/** 常见二级后缀（近似 public suffix 列表，够主流平台用） */
const SECOND_LEVEL_SUFFIXES = new Set([
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
    'co.jp', 'co.uk', 'com.au', 'com.br', 'com.tw', 'com.hk', 'com.sg',
])

/** 解析 URL 的注册域（eTLD+1 近似：space.bilibili.com → bilibili.com） */
function registrableDomain(url: string): string {
    try {
        const host = new URL(url).hostname.replace(/^www\./, '')
        const parts = host.split('.')
        if (parts.length <= 2) return host
        const last2 = parts.slice(-2).join('.')
        return SECOND_LEVEL_SUFFIXES.has(last2) ? parts.slice(-3).join('.') : last2
    } catch {
        return ''
    }
}

export function loginTargetFor(url: string): { url: string; name: string } | null {
    const domain = registrableDomain(url)
    const hit = LOGIN_PAGES.find(p => p.match.test(domain))
    return hit ? { url: hit.url, name: hit.name } : null
}

/** 进程内 cookie 缓存（同域一次会话只读一次） */
const cache = new Map<string, EngineCookie[]>()

export function clearCookieCache(): void {
    cache.clear()
}

/**
 * 读取目标 URL 对应域名的 cookie（专属浏览器 profile 的 cookie jar）
 *
 * - 已登录/访问过 → jar 有 cookie，直接读（不访问站点，零足迹）
 * - 全新 profile / jar 为空 → 匿名访问一次域名根（等同一次正常 pageview），
 *   让站点种下匿名会话 cookie（抖音的 ttwid、B站的 buvid 等——正是
 *   "Fresh cookies (not necessarily logged in)" 要求的东西），再读
 */
export async function fetchCookiesForUrl(url: string): Promise<EngineCookie[]> {
    const domain = registrableDomain(url)
    if (!domain) return []
    if (cache.has(domain)) return cache.get(domain)!

    const handle = await ensureLoginBrowser({ visible: false })
    const puppeteer = await import('puppeteer-core')
    const browser = await puppeteer.default.connect({
        browserURL: handle.url,
        defaultViewport: null,
        protocolTimeout: 15_000,
    })
    try {

        // CDP 读取：复用已有标签页的 session（Edge 157 的 browser 级 target 不支持
        // Storage.getCookies，须挂在 page target 上），不开新页、不导航
        const readJar = async (): Promise<EngineCookie[]> => {
            const pages = await browser.pages()
            let page: any = pages[0]
            let created = false
            if (!page) {
                page = await browser.newPage()
                created = true
            }
            try {
                const session = await page.createCDPSession()
                try {
                    const { cookies } = await session.send('Network.getCookies', {
                        urls: [`https://${domain}/`, `https://www.${domain}/`],
                    })
                    const raw = (cookies as any[]).filter((c: any) => {
                        const d = String(c.domain || '').replace(/^\./, '')
                        return d === domain || d.endsWith(`.${domain}`)
                    })
                    return raw.map((c: any) => ({
                        domain: c.domain,
                        name: c.name,
                        value: c.value,
                        path: c.path || '/',
                        secure: !!c.secure,
                        // 会话 cookie（expires<=0）不传，引擎契约：>0 才作为持久 cookie 注入
                        ...(c.expires && c.expires > 0 ? { expires: Math.floor(c.expires) } : {}),
                    }))
                } finally {
                    await session.detach().catch(() => {})
                }
            } finally {
                if (created) await page.close().catch(() => {})
            }
        }

        let cookies = await readJar()
        if (cookies.length === 0) {
            // cookie store 惰性加载/实例刚启动：短暂等待后复查一次，避免误判为空 jar
            await new Promise(r => setTimeout(r, 1200))
            cookies = await readJar()
        }
        if (cookies.length === 0) {
            // 全新 profile：匿名访问一次让站点种下会话 cookie（会短暂打开一个标签页）
            const page = await browser.newPage()
            try {
                process.stderr.write(`[cookie] 初始化 ${domain} 匿名会话（将短暂打开一个标签页）...\n`)
                await page.goto(`https://${domain}/`, {
                    waitUntil: 'domcontentloaded',
                    timeout: 45_000,
                }).catch(() => {})
                await new Promise(r => setTimeout(r, 2000))
                cookies = await readJar()
            } finally {
                await page.close().catch(() => {})
            }
        }
        cache.set(domain, cookies)
        return cookies
    } finally {
        // 断开本次连接（防泄漏）；只关自己拉起的临时实例，复用的不动
        await browser.disconnect().catch(() => {})
        await stopLoginBrowser(handle)
    }
}

/** 常见登录标记 cookie 名（各平台不统一，近似判断） */
const LOGIN_HINTS = ['SESSDATA', 'DedeUserID', 'sessionid', 'passport', 'auth', 'SID', 'ltoken', 'access_token']

/** cookie 数组里是否含登录标记 */
export function hasLoginMarker(cookies: EngineCookie[]): boolean {
    return cookies.some(c => LOGIN_HINTS.some(h => c.name.toLowerCase().includes(h.toLowerCase())))
}

/** 判断某域是否已有"像登录态"的 cookie（login 引导用，非精确判断） */
export async function hasLoginCookies(url: string): Promise<boolean> {
    const cookies = await fetchCookiesForUrl(url)
    return hasLoginMarker(cookies)
}

/** 某域是否已登录（语义化别名） */
export async function isLoggedInto(url: string): Promise<boolean> {
    return hasLoginCookies(url)
}

/**
 * 打开登录页并阻塞等待登录完成（轮询登录标记 cookie）。
 * 每次轮询带独立超时防护（单次 CDP 读取卡死不会挂住整个循环）。
 * 返回是否在超时前登录成功。
 */
export async function waitForLogin(url: string, timeoutMs = 300_000): Promise<boolean> {
    await openLoginPage(url)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000))
        clearCookieCache()
        const probe = hasLoginCookies(url).catch(() => false)
        const guard = new Promise<false>(r => setTimeout(() => r(false), 10_000))
        if (await Promise.race([probe, guard])) {
            return true
        }
    }
    return false
}

/** 打开登录页（确保可见窗口：残留的无头实例先优雅关闭重启为可见——否则登录页用户看不见） */
export async function openLoginPage(url: string): Promise<{ browserName: string; pageUrl: string }> {
    const target = loginTargetFor(url) ?? { url, name: registrableDomain(url) || '目标站点' }

    // 若运行中的实例可能是无头的（无法从外部判断），统一重启为可见，保证登录页可见
    if (await loginBrowserAlive()) {
        try {
            const puppeteer = await import('puppeteer-core')
            const browser = await puppeteer.default.connect({ browserURL: loginBrowserUrl(), defaultViewport: null, protocolTimeout: 15_000 })
            const session = await (browser as any).target().createCDPSession()
            await session.send('Browser.close').catch(() => {})
            await browser.disconnect()
            const deadline = Date.now() + 5000
            while (Date.now() < deadline && await loginBrowserAlive()) {
                await new Promise(r => setTimeout(r, 300))
            }
        } catch {
            // 已退出
        }
    }

    const handle = await ensureLoginBrowser({ visible: true })
    const puppeteer = await import('puppeteer-core')
    const browser = await puppeteer.default.connect({ browserURL: handle.url, defaultViewport: null, protocolTimeout: 30_000 })
    const page = await browser.newPage()
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
    // 只断开连接，不关浏览器/标签页——用户在窗口里登录，实例常驻
    await browser.disconnect()
    return { browserName: target.name, pageUrl: target.url }
}
