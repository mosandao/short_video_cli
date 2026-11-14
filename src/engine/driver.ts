/**
 * engine 驱动：spawn Python 引擎进程，stdin 写入 JSON 请求，逐行解析 stdout NDJSON 事件
 *
 * 引擎源码：external/galaxy-downloader-client/engine/main.py（git submodule，只调用不修改）
 * Python 环境：.venv-engine（npm run setup 创建）
 */

import { spawn } from 'child_process'
import { join, dirname } from 'path'
import { existsSync } from 'fs'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { profileExists } from '../loginBrowser.js'
import { fetchCookiesForUrl, hasLoginMarker, clearCookieCache } from '../cookies.js'
import type {
    EngineCaptionsRequest,
    EngineCaptionsResult,
    EngineCookie,
    EngineDownloadRequest,
    EngineDownloadResult,
    EngineEvent,
    EngineExtractRequest,
    EngineRequest,
    EngineRunOutcome,
    EngineVersionRequest,
    EngineVersionResult,
    YtDlpInfo,
} from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 项目根（dist/ 上一级） */
export const PROJECT_ROOT = join(__dirname, '..', '..')

/** 引擎脚本路径 */
export const ENGINE_SCRIPT = join(
    PROJECT_ROOT, 'external', 'galaxy-downloader-client', 'engine', 'main.py',
)

/** 引擎 venv Python 路径 */
export const ENGINE_PYTHON = join(PROJECT_ROOT, '.venv-engine', 'bin', 'python')

export interface RunEngineOptions {
    /** 收到事件时的回调（progress/log 等；result 与 error 除外） */
    onEvent?: (event: EngineEvent) => void
    /** 进程级超时（毫秒），默认 30 分钟 */
    timeoutMs?: number
    /** 静默 log 事件（--json 模式用） */
    quiet?: boolean
}

export class EngineError extends Error {
    code?: string
    constructor(message: string, code?: string) {
        super(message)
        this.name = 'EngineError'
        this.code = code
    }
}

/** 检查引擎依赖是否就绪，返回缺失项列表 */
export function engineCheck(): { pythonOk: boolean; engineScriptOk: boolean; ffmpeg: string | null } {
    return {
        pythonOk: existsSync(ENGINE_PYTHON),
        engineScriptOk: existsSync(ENGINE_SCRIPT),
        ffmpeg: findFfmpeg(),
    }
}

/** 定位系统 ffmpeg */
export function findFfmpeg(): string | null {
    try {
        const p = execSync('which ffmpeg', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
        return p || null
    } catch {
        return null
    }
}

/** 生成环境缺失时的提示 */
export function engineSetupHint(): string {
    const { pythonOk, engineScriptOk } = engineCheck()
    const lines: string[] = []
    if (!engineScriptOk) {
        lines.push('引擎源码缺失（external/galaxy-downloader-client），请运行: git submodule update --init --recursive')
    }
    if (!pythonOk) {
        lines.push('引擎 Python 环境未就绪（.venv-engine），请运行: npm run setup')
    }
    return lines.join('\n')
}

/**
 * 运行一次引擎请求
 *
 * 成功 → resolve { ok: true, result }
 * 失败 → resolve { ok: false, error }（不 throw，由调用方决定如何呈现）
 */
export function runEngine(
    request: EngineRequest,
    options: RunEngineOptions = {},
): Promise<EngineRunOutcome> {
    const { onEvent, timeoutMs = 30 * 60_000, quiet = false } = options

    if (!existsSync(ENGINE_SCRIPT)) {
        return Promise.resolve({ ok: false, error: engineSetupHint() || '引擎脚本不存在' })
    }
    if (!existsSync(ENGINE_PYTHON)) {
        return Promise.resolve({ ok: false, error: engineSetupHint() || '引擎 Python 环境不存在' })
    }

    // ffmpeg 定位（download/process/captions 需要；version 不需要）
    const needsFfmpeg = request.operation !== 'version'
    const ffmpeg = findFfmpeg()
    if (needsFfmpeg && !ffmpeg) {
        return Promise.resolve({
            ok: false,
            error: '未找到 ffmpeg。请先安装（macOS: brew install ffmpeg），合并视频/提取音频/字幕都依赖它',
        })
    }
    if (ffmpeg && needsFfmpeg) {
        (request as unknown as Record<string, unknown>).ffmpeg = ffmpeg
    }

    return new Promise((resolve) => {
        const child = spawn(ENGINE_PYTHON, [ENGINE_SCRIPT], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        })

        let settled = false
        let buffer = ''
        let stderrTail = ''

        const timer = setTimeout(() => {
            if (!settled) {
                child.kill('SIGKILL')
                settled = true
                resolve({ ok: false, error: `引擎超时（${Math.round(timeoutMs / 1000)}s）` })
            }
        }, timeoutMs)

        const finish = (outcome: EngineRunOutcome) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(outcome)
        }

        const handleLine = (line: string) => {
            const trimmed = line.trim()
            if (!trimmed) return
            let event: EngineEvent
            try {
                event = JSON.parse(trimmed) as EngineEvent
            } catch {
                if (!quiet) process.stderr.write(`[engine] ${trimmed}\n`)
                return
            }

            switch (event.kind) {
                case 'log':
                    if (!quiet) process.stderr.write(`[engine] ${(event as any).message}\n`)
                    onEvent?.(event)
                    break
                case 'result':
                    finish({ ok: true, result: (event as any).result })
                    break
                case 'error':
                    finish({ ok: false, error: (event as any).message, code: (event as any).code })
                    break
                default:
                    onEvent?.(event)
            }
        }

        child.stdout.setEncoding('utf-8')
        child.stdout.on('data', (chunk: string) => {
            buffer += chunk
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) handleLine(line)
        })

        child.stderr.setEncoding('utf-8')
        child.stderr.on('data', (chunk: string) => {
            // 引擎正常不应输出 stderr；保留尾部用于诊断
            stderrTail = (stderrTail + chunk).slice(-2000)
        })

        child.on('error', (err) => {
            finish({ ok: false, error: `引擎进程启动失败: ${err.message}` })
        })

        child.on('close', (code) => {
            // flush 残余行
            if (buffer) handleLine(buffer)
            if (!settled) {
                finish({
                    ok: false,
                    error: `引擎进程异常退出 (code ${code})${stderrTail ? `\n${stderrTail.trim().split('\n').slice(-5).join('\n')}` : ''}`,
                })
            }
        })

        // 写入请求并关闭 stdin
        child.stdin.write(JSON.stringify(request))
        child.stdin.end()
    })
}

/** 默认进度展示：单行刷新（stderr，不污染 --json 的 stdout） */
export function makeProgressPrinter(): (event: EngineEvent) => void {
    let lastLine = ''
    return (event) => {
        if (event.kind !== 'progress') return
        const { status, downloaded, total, speed, eta } = event as any
        if (status === 'downloading') {
            const totalStr = total ? `${(total / 1024 / 1024).toFixed(1)}MB` : '?'
            const pct = total ? `${Math.round((downloaded / total) * 100)}%` : `${(downloaded / 1024 / 1024).toFixed(1)}MB`
            const speedStr = speed ? ` ${(speed / 1024 / 1024).toFixed(2)}MB/s` : ''
            const etaStr = eta ? ` ETA ${Math.round(eta)}s` : ''
            lastLine = `  [下载] ${pct} / ${totalStr}${speedStr}${etaStr}`
            process.stderr.write(`\r${lastLine}`)
        } else if (status === 'finished') {
            process.stderr.write(`\r${' '.repeat(lastLine.length + 2)}\r`)
        }
    }
}

// ---------------------------------------------------------------------------
// cookie 注入（galaxy 方案：专属登录浏览器 → 引擎请求）
// ---------------------------------------------------------------------------

/** 进程级开关：--anon 时禁用 cookie 自动注入 */
let anonMode = false
export function setAnonMode(on: boolean): void {
    anonMode = on
}
export function isAnonMode(): boolean {
    return anonMode
}

/** 错误消息是否疑似"需要登录态/新鲜 cookie/风控拦截"（可带 cookie 重试） */
function looksLikeCookieProblem(message: string): boolean {
    return /fresh cookies|cookies? (are )?needed|need(s)? (fresh )?cookies|(rejected|blocked) by server|requires? (login|sign|auth|account)|sign in|登录|风控|risk control/i.test(message)
}

/**
 * 带 cookie 感知的执行器（至多两次尝试）：
 * 1. 专属 profile 存在且非 --anon → 首次尝试即附该域 cookie
 * 2. 首次裸跑失败、错误像 cookie/风控问题 → 取 cookie（匿名新会话 cookie 也常能解）重试一次
 */
async function withCookieSupport<T>(
    url: string,
    build: (cookies?: EngineCookie[]) => T,
    exec: (request: T) => Promise<EngineRunOutcome>,
): Promise<unknown> {
    let cookies: EngineCookie[] | undefined
    if (!anonMode && profileExists()) {
        try {
            const c = await fetchCookiesForUrl(url)
            if (c.length > 0) {
                cookies = c
                process.stderr.write(`[cookie] 附带 ${c.length} 个登录态 cookie\n`)
            }
        } catch {
            // cookie 读取失败不影响主流程
        }
    }

    let outcome = await exec(build(cookies))
    if (outcome.ok) return outcome.result

    if (!cookies && !anonMode && looksLikeCookieProblem(outcome.error || '')) {
        try {
            let c = await fetchCookiesForUrl(url)

            // 取到了 cookie 但没有登录标记：内容需要登录态，交互式终端主动弹登录页阻塞等待
            if (c.length > 0 && !hasLoginMarker(c) && process.stdin.isTTY) {
                process.stderr.write('[登录] 该内容需要登录态，已打开登录页，扫码/登录后将自动继续（最多等 5 分钟）...\n')
                const { waitForLogin } = await import('../cookies.js')
                if (await waitForLogin(url, 300_000)) {
                    process.stderr.write('[登录] 登录成功 ✅ 继续任务\n')
                    clearCookieCache()
                    c = await fetchCookiesForUrl(url)
                } else {
                    process.stderr.write('[登录] 等待超时，放弃登录重试\n')
                }
            }

            if (c.length > 0 && hasLoginMarker(c)) {
                process.stderr.write('[cookie] 检测到风控/登录要求，注入专属浏览器 cookie 重试...\n')
                const retry = await exec(build(c))
                if (retry.ok) return retry.result
                outcome = retry
            }
        } catch {
            // 保留原错误
        }
    }

    throw new EngineError(outcome.error || '引擎执行失败', outcome.code)
}

// ---------------------------------------------------------------------------
// 高层封装
// ---------------------------------------------------------------------------

/** 解析 URL（flat=true 快速枚举列表；flat=false 单视频带格式表） */
export async function extractInfo(
    url: string,
    opts: { flat?: boolean; headers?: Record<string, string> } = {},
): Promise<YtDlpInfo> {
    const build = (cookies?: EngineCookie[]): EngineExtractRequest => ({
        operation: 'extract',
        url,
        flat: opts.flat ?? true,
        headers: opts.headers,
        locale: 'zh',
        ...(cookies ? { cookies } : {}),
    })
    const result = await withCookieSupport(url, build, (request) => runEngine(request))
    return result as YtDlpInfo
}

/**
 * 解析并补全条目元数据：
 * - flat 枚举的列表条目可能无标题（引擎注释：此时调用方应再请求一次非 flat）
 * - 列表 ≤30 项且缺元数据 → 非 flat 重取；单视频 → 非 flat 取格式表
 */
export async function extractInfoResolved(url: string): Promise<YtDlpInfo> {
    const info = await extractInfo(url, { flat: true })
    const entries = (info.entries || []).filter(Boolean)
    const isPlaylist = info._type === 'playlist' || entries.length > 1

    if (isPlaylist && entries.length > 0 && entries.length <= 30 && entries.some(e => !e.title)) {
        try {
            const full = await extractInfo(url, { flat: false })
            const fullEntries = (full.entries || []).filter(Boolean)
            if (fullEntries.some(e => e.title)) {
                full.entries = fullEntries
                return full
            }
        } catch {
            // 保留 flat 结果
        }
    }

    if (!isPlaylist) {
        // 单视频：非 flat 拿完整格式表
        try {
            return await extractInfo(url, { flat: false })
        } catch {
            return info
        }
    }

    return info
}

export interface DownloadEngineOptions {
    url: string
    /** 输出目录（已有 folder 拼接后的最终目录） */
    outputDir: string
    /** yt-dlp 输出模板覆盖（默认 %(title)s.%(ext)s） */
    outTemplate?: string
    format?: string
    entry?: string
    audioOnly?: boolean
    audioFormat?: string
    subtitles?: 'off' | 'file'
    subtitleLanguages?: string
    saveThumbnail?: boolean
    onEvent?: (event: EngineEvent) => void
    quiet?: boolean
}

/** 下载媒体，返回产出文件列表 */
export async function downloadMedia(opts: DownloadEngineOptions): Promise<EngineDownloadResult> {
    const template = opts.outTemplate ?? '%(title)s.%(ext)s'
    const build = (cookies?: EngineCookie[]): EngineDownloadRequest => ({
        operation: 'download',
        url: opts.url,
        output: join(opts.outputDir, template),
        format: opts.format,
        entry: opts.entry,
        audioOnly: opts.audioOnly,
        audioFormat: opts.audioFormat,
        subtitles: opts.subtitles ?? 'off',
        subtitleLanguages: opts.subtitleLanguages,
        saveThumbnail: opts.saveThumbnail,
        workMode: 'download',
        locale: 'zh',
        ...(cookies ? { cookies } : {}),
    })
    const result = await withCookieSupport(opts.url, build, (request) =>
        runEngine(request, {
            onEvent: opts.onEvent,
            quiet: opts.quiet,
            timeoutMs: 60 * 60_000,
        }),
    )
    return result as EngineDownloadResult
}

/** 仅下载字幕 */
export async function fetchCaptions(
    url: string,
    outputDir: string,
    languages: string[],
    autoGenerated = true,
): Promise<EngineCaptionsResult> {
    const build = (cookies?: EngineCookie[]): EngineCaptionsRequest => ({
        operation: 'captions',
        url,
        output: join(outputDir, '%(title)s.%(ext)s'),
        captionLanguages: languages,
        subtitleAutoGenerated: autoGenerated,
        locale: 'zh',
        ...(cookies ? { cookies } : {}),
    })
    const result = await withCookieSupport(url, build, (request) => runEngine(request))
    return result as EngineCaptionsResult
}

/** 引擎/yt-dlp 版本（kernelCheck=true 时顺带验证 ffmpeg 可用） */
export async function engineVersion(kernelCheck = false): Promise<EngineVersionResult> {
    const request: EngineVersionRequest = {
        operation: kernelCheck ? 'kernel-check' : 'version',
    }
    const outcome = await runEngine(request)
    if (!outcome.ok) throw new EngineError(outcome.error || '引擎不可用', outcome.code)
    return outcome.result as EngineVersionResult
}
