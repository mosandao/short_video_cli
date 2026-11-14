/**
 * 专属登录浏览器：持久 profile + 远程调试端口
 *
 * galaxy 桌面客户端方案的 CLI 化：
 * - 一个我们完全控制的浏览器实例（独立 user-data-dir，登录一次长期有效）
 * - CDP 读取 cookie jar（不访问目标站点，风控无感）
 * - cookie 经管道注入引擎请求（凭据不落盘）
 *
 * 端口 9223（避免与用户自己的 Edge 9222 调试实例冲突），
 * 可用 GALAXY_BROWSER_DEBUG_URL 覆盖；二进制可用 GALAXY_BROWSER_EXECUTABLE 指定。
 */

import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

/** 持久化浏览器 profile 目录（gitignored） */
export const PROFILE_DIR = join(PROJECT_ROOT, '.browser-data')

/** 本实例调试地址（与用户自己的 9222 区分开） */
export function loginBrowserUrl(): string {
    return process.env.GALAXY_BROWSER_DEBUG_URL || 'http://127.0.0.1:9223'
}

/** 探测可用浏览器二进制（macOS / Linux） */
export function findBrowserExecutable(): string | null {
    if (process.env.GALAXY_BROWSER_EXECUTABLE) {
        return process.env.GALAXY_BROWSER_EXECUTABLE
    }
    const candidates = [
        // macOS
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        // Linux
        'microsoft-edge',
        'google-chrome',
        'chromium',
        'chromium-browser',
    ]
    for (const p of candidates) {
        if (p.startsWith('/') ? existsSync(p) : which(p)) {
            return p
        }
    }
    return null
}

function which(bin: string): boolean {
    try {
        const { execSync } = require('child_process') as typeof import('child_process')
        execSync(`which ${bin}`, { stdio: 'pipe' })
        return true
    } catch {
        return false
    }
}

/** 实例是否已在运行（调试端口可访问） */
export async function loginBrowserAlive(): Promise<boolean> {
    const url = loginBrowserUrl()
    try {
        const res = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1500) })
        return res.ok
    } catch {
        return false
    }
}

/** profile 是否已初始化（登录过至少一次） */
export function profileExists(): boolean {
    return existsSync(join(PROFILE_DIR, 'Default', 'Cookies')) || existsSync(PROFILE_DIR)
}

export interface LoginBrowserHandle {
    url: string
    /**
     * - 'external'   已在运行的实例（复用，绝不关闭）
     * - 'persistent' 本次 detached 拉起的可见实例（登录/页面渲染用，CLI 退出后继续存活）
     * - 'temporary'  本次 detached 拉起的无头实例（cookie 读取用，读完优雅关闭）
     */
    mode: 'external' | 'persistent' | 'temporary'
    pid: number | null
}

/**
 * 确保实例可用。
 *
 * 关键：浏览器用 detached spawn 启动（stdio ignore + unref），
 * 生命周期与 CLI 进程完全解耦——CLI 退出/断管道都不会带死浏览器。
 * 所有交互一律 puppeteer.connect，绝不持有子进程句柄。
 */
export async function ensureLoginBrowser(opts: { visible?: boolean } = {}): Promise<LoginBrowserHandle> {
    const url = loginBrowserUrl()
    if (await loginBrowserAlive()) {
        return { url, mode: 'external', pid: null }
    }

    const executable = findBrowserExecutable()
    if (!executable) {
        throw new Error(
            '未找到可用的浏览器（Edge/Chrome/Chromium）。请安装其一，或设置 GALAXY_BROWSER_EXECUTABLE 指向二进制路径',
        )
    }

    const port = new URL(url).port || '9223'
    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
    ]
    if (!opts.visible) {
        args.push('--headless=new')
    }

    const { spawn } = await import('child_process')
    const child = spawn(executable, args, {
        detached: true, // 独立进程组：CLI 退出后浏览器继续存活
        stdio: 'ignore', // 断开 stdio 管道，避免孤儿进程因 EPIPE 被带死
    })
    child.unref()

    // 等调试端口就绪（浏览器冷启动 2-8s）
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
        if (await loginBrowserAlive()) {
            return { url, mode: opts.visible ? 'persistent' : 'temporary', pid: child.pid ?? null }
        }
        await new Promise(r => setTimeout(r, 400))
    }
    throw new Error(`专属浏览器启动超时（${url}）。请手动检查: ${executable} ${args.join(' ')}`)
}

/**
 * 关闭 temporary 模式的实例（优雅关闭会把 cookie 落盘）。
 * external / persistent 一律不动。
 */
export async function stopLoginBrowser(handle: LoginBrowserHandle | null | undefined): Promise<void> {
    if (!handle || handle.mode !== 'temporary') return
    try {
        const puppeteer = await import('puppeteer-core')
        const browser = await puppeteer.default.connect({ browserURL: handle.url, defaultViewport: null })
        // CDP Browser.close = 优雅关停，触发 profile/cookie 落盘（不能用 kill -9）
        const session = await (browser as any).target().createCDPSession()
        await session.send('Browser.close').catch(() => {})
        await session.detach().catch(() => {})
        await browser.disconnect()
    } catch {
        // 已退出或连接失败，兜底清进程
        if (handle.pid) {
            try { process.kill(handle.pid, 'SIGTERM') } catch { /* 已退出 */ }
        }
    }
    // 等实例真正退出再返回：避免下一个进程立刻 spawn 抢跑、读到未就绪的 profile
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && await loginBrowserAlive()) {
        await new Promise(r => setTimeout(r, 300))
    }
}
