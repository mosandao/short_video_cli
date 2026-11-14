/**
 * download 命令：引擎（yt-dlp）下载 + SQLite 落库
 *
 * 引擎路径：extract（拿元数据与列表）→ download（条目选择/画质/音频提取）
 * --browser 路径：commands/browserDownload.ts（抖音主页 Edge 9222 模式）
 */

import { existsSync } from 'fs'
import { statSync } from 'fs'
import { basename } from 'path'
import { createInterface } from 'readline'
import { downloadMedia, extractInfoResolved, makeProgressPrinter } from '../engine/driver.js'
import type { YtDlpInfo } from '../engine/types.js'
import { insertRecord, queryByVideoUrl } from '../db.js'
import { formatBytes, formatDuration } from '../utils/format.js'
import { isDouyinUrl, resolveDouyinShareLink } from '../douyin.js'
import { browserDownloadCommand } from './browserDownload.js'

export interface DownloadOptions {
    url: string
    type: 'video' | 'audio' | 'images' | 'auto'
    /** 输出目录（--folder 已拼接种子目录） */
    output: string
    /** 播放列表条目选择（yt-dlp 语法 "1,3-5"） */
    items?: string
    all?: boolean
    /** 单个分P序号（--items N 的别名，兼容旧习惯） */
    part?: number
    browser?: boolean
    json?: boolean
    /** 画质：lowest / highest / ask（默认 ask，非交互环境取 highest） */
    quality?: 'lowest' | 'highest' | 'ask'
    /** 直接指定 yt-dlp 格式选择器或 format_id（优先于 quality） */
    format?: string
    /** 同时保存封面 */
    saveCover?: boolean
}

export interface DownloadResult {
    success: boolean
    files: Array<{
        path: string
        size: number
        type: 'video' | 'audio' | 'image'
        title?: string
        platform?: string
        dbId?: number
    }>
    error?: string
}

/** yt-dlp 格式选择器映射 */
function qualityToFormat(quality: 'lowest' | 'highest'): string {
    return quality === 'lowest' ? 'wv*+wa/w' : 'bv*+ba/b'
}

async function resolveQuality(options: DownloadOptions): Promise<'lowest' | 'highest'> {
    // 音频模式只需要最低画质视频流（引擎随后提取音频）
    if (options.type === 'audio') {
        if (!options.json) console.log('[画质] 音频模式，自动最低画质')
        return 'lowest'
    }
    if (options.quality === 'lowest' || options.quality === 'highest') return options.quality

    // ask 模式
    if (!process.stdin.isTTY) {
        if (!options.json) console.log('[画质] 非交互环境，默认最高画质')
        return 'highest'
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    return new Promise((resolve) => {
        rl.question('\n[画质] 选择视频画质:\n  [1] 最高画质（默认）\n  [2] 最低画质（仅需文字稿/音频时推荐）\n请输入 (1/2): ', (answer) => {
            rl.close()
            const q = answer.trim() === '2' ? 'lowest' : 'highest'
            if (!options.json) console.log(`[画质] 已选择：${q === 'lowest' ? '最低' : '最高'}\n`)
            resolve(q)
        })
    })
}

/** 上传日期 YYYYMMDD → YYYY-MM-DD */
function normalizeUploadDate(info: YtDlpInfo): string {
    const d = info.upload_date
    if (!d) return ''
    return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d
}

/** 已下载去重：URL 命中且本地文件仍在 → 跳过（修复旧版"文件已删仍跳过"的陷阱） */
function alreadyDownloaded(url: string): { dbId: number; mediaPath: string } | null {
    const record = queryByVideoUrl(url)
    if (record?.mediaPath && existsSync(record.mediaPath)) {
        return { dbId: record.id, mediaPath: record.mediaPath }
    }
    return null
}

function recordToDb(params: {
    platform: string
    username: string
    title: string
    videoUrl: string
    mediaPath: string
    publishedAt: string
    quiet?: boolean
}): number {
    try {
        const record = insertRecord({
            platform: params.platform,
            username: params.username,
            title: params.title,
            videoUrl: params.videoUrl,
            mediaPath: params.mediaPath,
            transcriptText: '',
            publishedAt: params.publishedAt,
        })
        if (!params.quiet) {
            console.log(`  [记录] 已保存到数据库 (ID: ${record.id})`)
        }
        return record.id
    } catch {
        return 0
    }
}

function fileSize(path: string): number {
    try {
        return statSync(path).size
    } catch {
        return 0
    }
}

export async function downloadCommand(options: DownloadOptions): Promise<DownloadResult> {
    const { url, type, output } = options

    if (!url.trim()) {
        return { success: false, files: [], error: 'URL 不能为空' }
    }

    // 抖音系链接（视频/主页/分享短链）→ 自动浏览器模式：
    // yt-dlp 抖音 extractor 未实现 a_bogus 签名，引擎路径不可用，无需用户手动 --browser
    if (isDouyinUrl(url)) {
        const targetUrl = await resolveDouyinShareLink(url)
        if (!options.json && targetUrl !== url) {
            console.log(`[短链] ${url} → ${targetUrl}`)
        }
        if (!options.json) {
            console.log('[模式] 抖音链接自动走浏览器模式（引擎签名限制）')
        }
        return browserDownloadCommand({ ...options, url: targetUrl })
    }

    // 其他平台显式 --browser → 浏览器模式
    if (options.browser) {
        if (!options.json) {
            console.log('[模式] 浏览器模式（强制）')
        }
        return browserDownloadCommand(options)
    }

    if (!options.json) {
        console.log(`\n[下载] ${url}`)
        console.log(`[输出] ${output}`)
    }

    try {
        const audioOnly = type === 'audio'
        const quality = await resolveQuality(options)

        // 第一步：解析（flat 枚举列表；条目缺元数据时自动补非 flat）
        if (!options.json) console.log('[解析] 引擎解析中...')
        const info = await extractInfoResolved(url)

        const entries = (info.entries || []).filter(Boolean)
        const isPlaylist = info._type === 'playlist' || entries.length > 1

        // 列表安全选择：多项且未指定 --items/--all → 拒绝整包下载
        let entry: string | undefined
        if (isPlaylist) {
            const count = info.playlist_count || entries.length
            if (options.items) {
                entry = options.items
            } else if (options.part && options.part > 0) {
                entry = String(options.part)
            } else if (options.all) {
                entry = undefined // 不传 entry = 全部
            } else {
                if (!options.json) {
                    console.log(`\n[列表] 该链接包含 ${count} 个条目：`)
                    entries.slice(0, 20).forEach((e, i) => {
                        const dur = e.duration ? formatDuration(e.duration) : '  -  '
                        console.log(`  [${i + 1}] ${dur}  ${e.title || e.id}`)
                    })
                    if (entries.length > 20) console.log(`  ... 还有 ${entries.length - 20} 项`)
                    console.log(`\n[提示] 指定 --items 1,3-5 或 --part <N> 选择条目，--all 下载全部 ${count} 项`)
                }
                return {
                    success: false,
                    files: [],
                    error: `链接包含 ${count} 个条目，需指定 --items / --part / --all`,
                }
            }
        }

        // 去重（单视频场景）
        const canonicalUrl = String(info.webpage_url || info.original_url || url)
        if (!isPlaylist) {
            const existed = alreadyDownloaded(canonicalUrl)
            if (existed) {
                if (!options.json) console.log(`\n[跳过] 已下载过: ${existed.mediaPath}`)
                return {
                    success: true,
                    files: [{
                        path: existed.mediaPath,
                        size: fileSize(existed.mediaPath),
                        type: audioOnly ? 'audio' : 'video',
                        dbId: existed.dbId,
                        title: info.title,
                    }],
                }
            }
        }

        const title = info.title || '未知标题'
        const platform = String(info.extractor || 'unknown').split(':')[0]
        const username = info.uploader || info.channel || ''

        if (!options.json) {
            console.log(`[标题] ${title}`)
            console.log(`[平台] ${platform}${username ? ` / ${username}` : ''}`)
        }

        // 第二步：引擎下载
        const result = await downloadMedia({
            url,
            outputDir: output,
            format: options.format || qualityToFormat(quality),
            entry,
            audioOnly,
            audioFormat: 'm4a',
            saveThumbnail: options.saveCover,
            onEvent: makeProgressPrinter(),
            quiet: options.json,
        })

        const files = (result.files || []).filter(f => existsSync(f))
        if (files.length === 0) {
            return { success: false, files: [], error: '引擎未产出任何文件（可能链接无效或内容不可用）' }
        }

        // 第三步：落库（标题用文件基名，保证与 transcribe 的标题回查、history 显示一致；
        // 引擎 windowsfilenames 会把标题中的 / 转为 ⧸，直接用 info.title 会失配）
        const dbFiles = files.map((path, i) => {
            const fileTitle = basename(path).replace(/\.[^.]+$/, '') || title
            let dbId = 0
            let itemTitle = fileTitle
            if (!isPlaylist) {
                dbId = recordToDb({
                    platform,
                    username,
                    title: fileTitle,
                    videoUrl: canonicalUrl,
                    mediaPath: path,
                    publishedAt: normalizeUploadDate(info),
                    quiet: options.json,
                })
            } else {
                const entryUrl = entry
                    ? `${canonicalUrl}${canonicalUrl.includes('?') ? '&' : '?'}items=${entry}`
                    : canonicalUrl
                dbId = recordToDb({
                    platform,
                    username,
                    title: fileTitle,
                    videoUrl: entryUrl,
                    mediaPath: path,
                    publishedAt: normalizeUploadDate(info),
                    quiet: options.json,
                })
            }
            return {
                path,
                size: fileSize(path),
                type: audioOnly ? ('audio' as const) : ('video' as const),
                title: itemTitle,
                platform,
                dbId,
            }
        })

        if (!options.json) {
            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
            console.log('下载完成:')
            dbFiles.forEach(f => console.log(`  ${f.type}: ${f.path} (${formatBytes(f.size)})`))
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
        }

        return { success: true, files: dbFiles }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!options.json) console.error(`\n[错误] ${message}\n`)
        return { success: false, files: [], error: message }
    }
}
