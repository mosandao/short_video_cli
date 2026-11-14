/**
 * --browser 模式下载：抖音用户主页 / 单视频（Edge 9222 登录态 + CDP 拦截）
 *
 * 移植自 galaxy-downloader fork cli/src/commands/download.ts 的浏览器分支。
 * 引擎（yt-dlp）无法可靠覆盖抖音主页列表与部分单视频，此模式作为登录态兜底。
 */

import { execSync } from 'child_process'
import { unlinkSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import { parseDouyinUserHomepageWithBrowser, parseDouyinVideoWithBrowser } from '../browser.js'
import { ensureLoginBrowser, loginBrowserAlive, loginBrowserUrl, profileExists } from '../loginBrowser.js'
import { isDouyinProfileUrl } from '../douyin.js'
import { isLoggedInto, waitForLogin } from '../cookies.js'
import { isAnonMode } from '../engine/driver.js'
import { parseTimeRange, formatTimePoint, type TimeRange } from '../timeRange.js'
import type { MediaInfo, PageInfo } from '../types.js'
import { downloadFile } from '../utils/download.js'
import { formatBytes, sanitizeFilename } from '../utils/format.js'
import { insertRecord, queryByVideoUrl, queryByTitleExact } from '../db.js'
import type { DownloadOptions, DownloadResult } from './download.js'

/** 已下载去重：URL 或精确标题命中且文件仍在 */
function alreadyDownloaded(videoUrl: string, title: string): { dbId: number; mediaPath: string } | null {
    let record = queryByVideoUrl(videoUrl)
    if (!record && title) record = queryByTitleExact(title)
    if (record?.mediaPath && existsSync(record.mediaPath)) {
        return { dbId: record.id, mediaPath: record.mediaPath }
    }
    return null
}

function recordToDb(params: {
    username: string
    title: string
    videoUrl: string
    mediaPath: string
}): number {
    try {
        const record = insertRecord({
            platform: 'douyin',
            username: params.username,
            title: params.title,
            videoUrl: params.videoUrl,
            mediaPath: params.mediaPath,
            transcriptText: '',
            publishedAt: '',
        })
        console.log(`  [记录] 已保存到数据库 (ID: ${record.id})`)
        return record.id
    } catch {
        return 0
    }
}

/** 带进度与 Referer 的直链下载 */
async function downloadWithType(
    url: string,
    outputDir: string,
    baseName: string,
    type: 'video' | 'audio-temp',
): Promise<{ success: boolean; path: string; size: number }> {
    const ext = type === 'audio-temp' ? '.mp4' : '.mp4'
    const outputPath = join(outputDir, sanitizeFilename(baseName) + ext)
    const result = await downloadFile(url, outputPath, (p) => {
        const progress = p.total
            ? `${p.percentage}% (${formatBytes(p.downloaded)}/${formatBytes(p.total)})`
            : formatBytes(p.downloaded)
        const speed = p.speed ? ` @ ${p.speed}` : ''
        process.stdout.write(`\r  [下载] ${progress}${speed}   `)
    }, { Referer: 'https://www.douyin.com/' })

    if (result.success) {
        process.stdout.write('\r')
        console.log(`  [完成] ${sanitizeFilename(baseName)}.mp4`)
    }
    return result
}

/** 从视频提取音频后删除临时视频 */
function extractAudio(videoPath: string, audioPath: string): { success: boolean; path: string; size: number } {
    try {
        console.log(`  [提取音频] → ${audioPath}`)
        execSync(`ffmpeg -i "${videoPath}" -vn -acodec aac -y "${audioPath}"`, {
            stdio: 'pipe',
            timeout: 120_000,
        })
        unlinkSync(videoPath)
        const size = statSync(audioPath).size
        console.log(`  [音频完成] ${audioPath} (${formatBytes(size)})`)
        return { success: true, path: audioPath, size }
    } catch (error) {
        console.log(`  [音频提取失败] ${error instanceof Error ? error.message : 'ffmpeg error'}`)
        return { success: false, path: audioPath, size: 0 }
    }
}

/** 下载单个已解析的抖音视频（CDN 直链） */
async function downloadParsedVideo(
    data: MediaInfo,
    output: string,
    type: 'video' | 'audio' | 'images' | 'auto',
    username: string,
    videoUrl: string,
): Promise<DownloadResult['files'][number] | null> {
    const baseName = sanitizeFilename(data.title || '抖音视频')
    const cdnUrl = data.downloadVideoUrl || data.originDownloadVideoUrl
    if (!cdnUrl) {
        console.log('  [跳过] 未捕获到视频流 URL')
        return null
    }

    const existed = alreadyDownloaded(videoUrl, baseName)
    if (existed) {
        console.log(`  [跳过] 已下载: ${existed.mediaPath}`)
        return {
            path: existed.mediaPath,
            size: existsSync(existed.mediaPath) ? statSync(existed.mediaPath).size : 0,
            type: type === 'audio' ? 'audio' : 'video',
            dbId: existed.dbId,
            title: baseName,
        }
    }

    if (type === 'audio') {
        // 最低画质合成流 → 提取音频 → 删临时视频
        const videoResult = await downloadWithType(cdnUrl, output, baseName + '_temp', 'audio-temp')
        if (!videoResult.success) return null
        const audioPath = join(output, baseName + '.m4a')
        const audioResult = extractAudio(videoResult.path, audioPath)
        if (!audioResult.success) return null
        const dbId = recordToDb({ username, title: baseName, videoUrl, mediaPath: audioPath })
        return { path: audioPath, size: audioResult.size, type: 'audio', dbId, title: baseName }
    }

    const videoResult = await downloadWithType(cdnUrl, output, baseName, 'video')
    if (!videoResult.success) return null
    const dbId = recordToDb({ username, title: baseName, videoUrl, mediaPath: videoResult.path })
    return { path: videoResult.path, size: videoResult.size, type: 'video', dbId, title: baseName }
}

/** 打印主页条目清单（带发布时间，有则显示） */
function printPageList(pages: PageInfo[]): void {
    console.log('\n[提示] 可用条目:')
    pages.slice(0, 30).forEach(p =>
        console.log(`  [${p.page}] ${p.createTime ? formatTimePoint(p.createTime) : '????-??-??'}  ${p.part}`))
    if (pages.length > 30) console.log(`  ... 还有 ${pages.length - 30} 项`)
}

/** 解析条目选择（--items "1,3-5" / --part N / --all） */
function selectPages(pages: PageInfo[], options: DownloadOptions): PageInfo[] {
    if (options.part && options.part > 0) {
        const page = pages.find(p => p.page === options.part)
        if (!page) throw new Error(`条目 ${options.part} 不存在（共 ${pages.length} 项）`)
        return [page]
    }
    if (options.all) return pages
    if (options.items) {
        const selected: PageInfo[] = []
        for (const token of options.items.split(',')) {
            const range = token.trim()
            const m = range.match(/^(\d+)-(\d+)$/)
            if (m) {
                for (let i = parseInt(m[1], 10); i <= parseInt(m[2], 10); i++) {
                    const page = pages.find(p => p.page === i)
                    if (page) selected.push(page)
                }
            } else if (/^\d+$/.test(range)) {
                const page = pages.find(p => p.page === parseInt(range, 10))
                if (page) selected.push(page)
            }
        }
        if (selected.length === 0) throw new Error(`--items "${options.items}" 未匹配到任何条目`)
        return selected
    }
    return []
}

/**
 * 确保 --browser 模式的专属实例可用并指向它（download/parse 共用）。
 *
 * 实测（2026-11-14）：登录态 profile 下无头模式对抖音完全可用（匿名无头才被
 * 验证码墙拦），因此有 profile 时默认无头拉起——零窗口打扰；首次解析若未捕获
 * （如该平台未登录/风控），调用方用 withHeadlessFallback 自动切可见窗口重试。
 */
export interface BrowserModeState {
    /** reused=复用运行中实例；headless=本次无头拉起；visible=本次可见拉起；none=无 profile 未拉起 */
    mode: 'reused' | 'headless' | 'visible' | 'none'
}

export async function ensureBrowserModeInstance(): Promise<BrowserModeState> {
    if (await loginBrowserAlive()) {
        process.env.GALAXY_CHROME_DEBUG_URL = loginBrowserUrl()
        console.log(`[浏览器] 复用专属登录实例: ${loginBrowserUrl()}`)
        return { mode: 'reused' }
    }
    if (profileExists()) {
        await ensureLoginBrowser({ visible: false })
        process.env.GALAXY_CHROME_DEBUG_URL = loginBrowserUrl()
        console.log(`[浏览器] 已拉起无头登录实例: ${loginBrowserUrl()}`)
        return { mode: 'headless' }
    }
    return { mode: 'none' }
}

/** 关掉现有实例并以可见窗口重启（无头降级用） */
export async function relaunchVisibleBrowser(): Promise<void> {
    try {
        const puppeteer = (await import('puppeteer-core')).default
        const browser = await puppeteer.connect({ browserURL: loginBrowserUrl(), defaultViewport: null })
        const session = await (browser as any).target().createCDPSession()
        await session.send('Browser.close').catch(() => {})
        await browser.disconnect()
    } catch { /* 已退出 */ }
    // 等真正退出再重启（避免 profile 锁竞态）
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && await loginBrowserAlive()) {
        await new Promise(r => setTimeout(r, 300))
    }
    await ensureLoginBrowser({ visible: true })
    process.env.GALAXY_CHROME_DEBUG_URL = loginBrowserUrl()
    console.log(`[浏览器] 已切换可见窗口实例: ${loginBrowserUrl()}`)
}

/**
 * 无头模式失败时自动切可见窗口重试一次（仅 headless 拉起时生效）。
 * 用于浏览器解析类调用（ParserResult 形状）。
 */
export async function withHeadlessFallback<T extends { success: boolean; error?: string }>(
    mode: BrowserModeState['mode'],
    op: () => Promise<T>,
): Promise<T> {
    let result = await op()
    if (!result.success && mode === 'headless') {
        console.log('[浏览器] 无头模式未成功（该平台可能未登录/风控），切换可见窗口重试...')
        await relaunchVisibleBrowser()
        result = await op()
    }
    return result
}

export async function browserDownloadCommand(options: DownloadOptions): Promise<DownloadResult> {
    const { url, type, output } = options
    const quality = type === 'audio' ? 'lowest' : (options.quality === 'lowest' ? 'lowest' : 'highest')
    const files: DownloadResult['files'] = []

    try {
        console.log(`\n[浏览器] ${url}`)
        console.log(`[输出] ${output}`)

        const bm = await ensureBrowserModeInstance()

        // 未登录抖音 → 主动弹登录页（交互式终端）；45s 宽限内扫码则用登录态，超时匿名继续
        if (!isAnonMode() && process.stdin.isTTY
            && (!profileExists() || !(await isLoggedInto('https://www.douyin.com/')))) {
            console.log('\n[登录] 未检测到抖音登录态，已打开登录页——扫码后自动以登录态继续')
            console.log('[登录] 45 秒内未登录将以匿名继续（主页批量建议先完成登录）\n')
            const ok = await waitForLogin('https://www.douyin.com/', 45_000)
            if (ok) {
                console.log('[登录] 登录成功 ✅ 继续下载')
            } else {
                console.log('[登录] 宽限期过，匿名继续（之后可随时 svdl login douyin.com）\n')
            }
        }

        // 用户主页 → 枚举视频列表
        if (isDouyinProfileUrl(url)) {
            // 时间范围：解析于枚举前（早停下界传给滚动循环，置顶除外按时间倒序，到界即停）
            let range: TimeRange | null = null
            if (options.since || options.until) {
                const r = parseTimeRange(options.since, options.until)
                if ('error' in r) {
                    return { success: false, files: [], error: r.error }
                }
                range = r
            }
            // 有 since 用 since 作下界；只给 until 用 until（降序列表一旦低于 until，其后全在范围外）
            const stopTs = range ? (options.since ? range.sinceTs : range.untilTs) : undefined

            const homepage = await withHeadlessFallback(bm.mode,
                () => parseDouyinUserHomepageWithBrowser(url, stopTs !== undefined ? { stopTs } : {}))
            if (!homepage.success || !homepage.data) {
                return { success: false, files: [], error: homepage.error || '主页解析失败' }
            }
            const pages = homepage.data.pages || []
            const dated = pages.filter(p => p.createTime !== undefined)
            console.log(`\n[列表] 共 ${pages.length} 个视频${dated.length ? '' : '（⚠️ 未捕获发布时间，无法用时间范围过滤）'}`)

            let selected: PageInfo[]
            if (range) {
                if (dated.length === 0) {
                    return { success: false, files: [], error: '本轮未捕获到发布时间，无法按时间范围过滤（重试或用 --items）' }
                }
                selected = dated.filter(p =>
                    (p.createTime as number) >= range.sinceTs && (p.createTime as number) <= range.untilTs)
                console.log(`[时间] ${formatTimePoint(range.sinceTs)} ~ ${formatTimePoint(range.untilTs)} 命中 ${selected.length}/${pages.length}`)
                selected.slice(0, 30).forEach(p =>
                    console.log(`  [${p.page}] ${formatTimePoint(p.createTime as number)}  ${p.part}`))
                if (selected.length > 30) console.log(`  ... 还有 ${selected.length - 30} 条`)
                if (selected.length === 0) {
                    const times = dated.map(p => p.createTime as number)
                    return {
                        success: false,
                        files: [],
                        error: `指定时间范围内没有视频（主页时间跨度 ${formatTimePoint(Math.min(...times))} ~ ${formatTimePoint(Math.max(...times))}）`,
                    }
                }
            } else {
                try {
                    selected = selectPages(pages, options)
                } catch (e) {
                    printPageList(pages)
                    return { success: false, files: [], error: e instanceof Error ? e.message : String(e) }
                }
                if (selected.length === 0) {
                    printPageList(pages)
                    console.log('\n[提示] 指定 --items 1,3-5 或 --part <N> 选择，--all 全部，--since/--until 按发布时间筛选')
                    return { success: false, files: [], error: `共 ${pages.length} 个视频，需指定 --items / --part / --all / 时间范围` }
                }
            }

            const username = (homepage.data.desc || '').replace(/共 \d+ 个视频/, '').trim()
                || new URL(url).pathname.split('/').pop() || 'douyin'

            for (const page of selected) {
                console.log(`\n[${page.page}/${selected.length}] ${page.part}`)
                try {
                    const single = await parseDouyinVideoWithBrowser(page.downloadVideoUrl!, quality)
                    if (!single.success || !single.data) {
                        console.log(`  [失败] ${single.error}`)
                        continue
                    }
                    const item = await downloadParsedVideo(single.data, output, type, username, page.downloadVideoUrl!)
                    if (item) files.push(item)
                } catch (e) {
                    console.log(`  [失败] ${e instanceof Error ? e.message : e}`)
                }
                // 连续浏览器操作必须间隔 3 秒，否则 puppeteer 断连
                if (page !== selected[selected.length - 1]) {
                    await new Promise(r => setTimeout(r, 3000))
                }
            }
        } else {
            // 单视频
            const single = await withHeadlessFallback(bm.mode, () => parseDouyinVideoWithBrowser(url, quality))
            if (!single.success || !single.data) {
                return { success: false, files: [], error: single.error || '视频解析失败' }
            }
            const item = await downloadParsedVideo(single.data, output, type, '', url)
            if (item) files.push(item)
        }

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.log(`浏览器模式下载完成: ${files.length} 个文件`)
        files.forEach(f => console.log(`  ${f.type}: ${f.path}`))
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

        return { success: files.length > 0, files }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`\n[错误] ${message}\n`)
        return { success: false, files, error: message }
    }
}
