/**
 * parse 命令：仅解析媒体信息（引擎 extract），展示条目/画质/元数据，不下载
 */

import { extractInfoResolved } from '../engine/driver.js'
import type { YtDlpFormat, YtDlpInfo } from '../engine/types.js'
import { formatDuration } from '../utils/format.js'
import { normalizePlatform } from '../platforms.js'
import { isDouyinUrl, isDouyinProfileUrl, resolveDouyinShareLink } from '../douyin.js'
import { parseDouyinUserHomepageWithBrowser, parseDouyinVideoWithBrowser } from '../browser.js'
import { ensureBrowserModeInstance, withHeadlessFallback } from './browserDownload.js'

export interface ParseOptions {
    url: string
    json?: boolean
}

export interface ParseResult {
    success: boolean
    info?: unknown
    error?: string
}

function formatSize(bytes?: number): string {
    if (!bytes) return '-'
    const mb = bytes / 1024 / 1024
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
    if (mb >= 1) return `${mb.toFixed(1)} MB`
    return `${(bytes / 1024).toFixed(0)} KB`
}

/** 从 extractor 字段推断平台标识 */
function platformOf(info: YtDlpInfo): string {
    const extractor = String(info.extractor || '').toLowerCase()
    if (!extractor) return 'unknown'
    return normalizePlatform(extractor.split(':')[0])
}

/** 打印画质格式表（单视频，flat=false 时才有 formats） */
function printFormats(formats: YtDlpFormat[]): void {
    const rows = formats.filter(f => f.vcodec !== 'none' || f.acodec !== 'none')
    const videoFormats = rows.filter(f => f.vcodec !== 'none')
    // 组合流 + 纯视频流，倒序（最佳在前）
    const interesting = [...rows].reverse().slice(-12)
    console.log('\n画质格式:')
    console.log('  format_id  扩展名  分辨率   大小        说明')
    console.log('  ─────────────────────────────────────────')
    for (const f of interesting) {
        const res = f.height ? `${f.height}p` : (f.vcodec === 'none' ? '纯音频' : '-')
        console.log(
            `  ${String(f.format_id || '-').padEnd(9)} ${(f.ext || '-').padEnd(6)} ${res.padEnd(7)} ${formatSize(f.filesize || f.filesize_approx).padEnd(10)} ${f.format_note || ''}`,
        )
    }
    if (videoFormats.length === 0) {
        console.log('  （纯音频内容）')
    }
    console.log('  提示: 下载时可用 --format <format_id> 指定画质')
}

/** 抖音链接的浏览器模式解析（单视频画质信息 / 用户主页列表） */
async function parseDouyinWithBrowser(options: ParseOptions): Promise<ParseResult> {
    const url = await resolveDouyinShareLink(options.url)
    if (url !== options.url && !options.json) {
        console.log(`[短链] ${options.url} → ${url}`)
    }

    const bm = await ensureBrowserModeInstance()

    if (isDouyinProfileUrl(url)) {
        // 用户主页：枚举视频列表
        const result = await withHeadlessFallback(bm.mode, () => parseDouyinUserHomepageWithBrowser(url))
        if (!result.success || !result.data) {
            if (!options.json) console.error(`\n[错误] ${result.error}\n`)
            return { success: false, error: result.error }
        }
        const pages = result.data.pages || []
        if (!options.json) {
            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
            console.log(`类型: 抖音用户主页，共 ${pages.length} 个视频`)
            console.log(`主页: ${url}`)
            pages.slice(0, 30).forEach(p => console.log(`  [${p.page}] ${p.part}`))
            if (pages.length > 30) console.log(`  ... 还有 ${pages.length - 30} 项`)
            console.log('\n提示: 下载用 --items 1,3-5 / --part N / --all，建议 --folder 按作者分目录')
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
        }
        return {
            success: true,
            info: { _type: 'playlist', platform: 'douyin', url, count: pages.length, entries: pages.map(p => ({ index: p.page, id: p.cid, title: p.part })) },
        }
    }

    // 单视频：捕获标题与视频流
    const result = await withHeadlessFallback(bm.mode, () => parseDouyinVideoWithBrowser(url, 'highest'))
    if (!result.success || !result.data) {
        if (!options.json) console.error(`\n[错误] ${result.error}\n`)
        return { success: false, error: result.error }
    }
    const d = result.data
    if (!options.json) {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.log(`标题: ${d.title}`)
        console.log('平台: 抖音（浏览器模式，已捕获视频流）')
        console.log('提示: 直接 svdl "<url>" 下载（可 --quality lowest / --type audio）')
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
    }
    return { success: true, info: { ...d, platform: 'douyin' } }
}

export async function parseCommand(options: ParseOptions): Promise<ParseResult> {
    const { url } = options

    try {
        // 抖音系链接：引擎 extractor 签名限制，走浏览器模式解析
        if (isDouyinUrl(url)) {
            return await parseDouyinWithBrowser(options)
        }

        // flat 快速枚举；条目缺元数据（≤30 项）或单视频需要格式表时自动补非 flat 解析
        const info = await extractInfoResolved(url)

        if (!options.json) {
            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
            console.log(`标题: ${info.title || '(无标题)'}`)
            console.log(`平台: ${info.extractor || platformOf(info)}`)
            if (info.uploader || info.channel) {
                console.log(`作者: ${info.uploader || info.channel}`)
            }
            if (info.duration) {
                console.log(`时长: ${formatDuration(info.duration)}`)
            }
            if (info.upload_date) {
                const d = info.upload_date
                console.log(`发布: ${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`)
            }
            if (info.view_count) {
                console.log(`播放: ${info.view_count.toLocaleString()}`)
            }

            // 列表（合集/用户主页/多P）
            const entries = (info.entries || []).filter(Boolean)
            if (info._type === 'playlist' || entries.length > 1) {
                console.log(`\n类型: 列表，共 ${info.playlist_count || entries.length} 项`)
                entries.slice(0, 30).forEach((e, i) => {
                    const dur = e.duration ? formatDuration(e.duration) : '  -  '
                    console.log(`  [${i + 1}] ${dur}  ${e.title || e.id || '(无标题)'}`)
                })
                if (entries.length > 30) {
                    console.log(`  ... 还有 ${entries.length - 30} 项`)
                }
                console.log('\n提示: 下载用 --items 1,3-5 选择条目，或 --all 全部下载')
            } else if (entries.length === 1 && entries[0]?.title) {
                console.log(`条目: ${entries[0].title}`)
            }

            if (info.formats?.length) {
                printFormats(info.formats)
            }

            const desc = String(info.description || '').trim()
            if (desc) {
                console.log(`\n简介: ${desc.slice(0, 300)}${desc.length > 300 ? '...' : ''}`)
            }
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
        }

        return { success: true, info }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!options.json) {
            console.error(`\n[错误] ${message}\n`)
        }
        return { success: false, error: message }
    }
}
