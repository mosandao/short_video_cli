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
import { downloadMedia, extractInfo, extractInfoResolved, makeProgressPrinter } from '../engine/driver.js'
import type { YtDlpInfo } from '../engine/types.js'
import { insertRecord, queryByVideoUrl, queryByMediaPath, touchRecord, updateVideoUrl } from '../db.js'
import { formatBytes, formatDuration } from '../utils/format.js'
import { isDouyinUrl, resolveDouyinShareLink, canonicalizeDouyinUrl } from '../douyin.js'
import { parseTimeRange, formatTimePoint, type TimeRange } from '../timeRange.js'
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
    /** 画质：lowest / medium / highest / ask（默认 medium 中等画质） */
    quality?: 'lowest' | 'medium' | 'highest' | 'ask'
    /** 直接指定 yt-dlp 格式选择器或 format_id（优先于 quality） */
    format?: string
    /** 同时保存封面 */
    saveCover?: boolean
    /** 时间范围起点（YYYY-MM-DD [HH:mm] / yesterday [HH:mm] / today [HH:mm] / Nd） */
    since?: string
    /** 时间范围终点（同上，默认当前时刻） */
    until?: string
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
function qualityToFormat(quality: 'lowest' | 'medium' | 'highest'): string {
    if (quality === 'lowest') return 'wv*+wa/w'
    if (quality === 'medium') return 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b' // ≤720p 最佳，无中档时退回最佳
    return 'bv*+ba/b'
}

/** 条目发布时间（Unix 秒）：优先 timestamp，回退 upload_date(YYYYMMDD)；多P 嵌套取内层 */
function entryTimestamp(e: YtDlpInfo): number | null {
    if (typeof e.timestamp === 'number' && e.timestamp > 0) return e.timestamp
    const d = e.upload_date
    if (typeof d === 'string' && /^\d{8}$/.test(d)) {
        return Math.floor(new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)).getTime() / 1000)
    }
    // 空间条目可能是嵌套 playlist（多P 合集），日期在内层第一条
    const inner = (e.entries as YtDlpInfo[] | undefined)?.[0]
    if (inner) return entryTimestamp(inner)
    return null
}

/** 解析画质：音频模式自动最低；未指定默认中等；显式 ask 才交互询问 */
async function resolveQuality(options: DownloadOptions): Promise<'lowest' | 'medium' | 'highest'> {
    // 音频模式只需要最低画质视频流（引擎随后提取音频）
    if (options.type === 'audio') {
        if (!options.json) console.log('[画质] 音频模式，自动最低画质')
        return 'lowest'
    }
    if (options.quality === 'lowest' || options.quality === 'medium' || options.quality === 'highest') {
        return options.quality
    }

    // ask 模式（显式指定才询问）
    if (!process.stdin.isTTY) {
        if (!options.json) console.log('[画质] 非交互环境，默认中等画质')
        return 'medium'
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    return new Promise((resolve) => {
        rl.question('\n[画质] 选择视频画质:\n  [1] 中等画质（默认，≤720p）\n  [2] 最高画质\n  [3] 最低画质（仅需文字稿/音频时推荐）\n请输入 (1/2/3): ', (answer) => {
            rl.close()
            const q = answer.trim() === '2' ? 'highest' : (answer.trim() === '3' ? 'lowest' : 'medium')
            if (!options.json) console.log(`[画质] 已选择：${q === 'lowest' ? '最低' : q === 'highest' ? '最高' : '中等'}\n`)
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

/** 音频文件扩展名（判断已有记录与本次请求类型是否一致） */
const AUDIO_EXTS = /\.(m4a|mp3|wav|flac|ogg|aac)$/i

/** 已有文件与本次请求类型是否一致（请求音频但命中视频文件时不跳过，正常重下） */
function matchesRequestedType(path: string, audioOnly: boolean): boolean {
    return audioOnly ? AUDIO_EXTS.test(path) : !AUDIO_EXTS.test(path)
}

/** 已下载去重：URL 命中、本地文件仍在且类型一致 → 跳过（文件被删/类型不符会重下） */
function alreadyDownloaded(url: string, audioOnly = false): { dbId: number; mediaPath: string } | null {
    const record = queryByVideoUrl(url)
    if (record?.mediaPath && existsSync(record.mediaPath) && matchesRequestedType(record.mediaPath, audioOnly)) {
        return { dbId: record.id, mediaPath: record.mediaPath }
    }
    return null
}

/** 条目真实视频地址（flat 条目的 url/webpage_url；作为跨次运行稳定的去重键，不受索引偏移影响） */
function entryRealUrl(e: YtDlpInfo | null | undefined): string | undefined {
    const u = e?.webpage_url || e?.url
    return typeof u === 'string' && /^https?:\/\//.test(u) ? u : undefined
}

/** 旧版列表条目的合成 URL（?items=<idx> 后缀；用于兼容历史记录去重） */
function syntheticEntryUrl(canonicalUrl: string, idx: number): string {
    return `${canonicalUrl}${canonicalUrl.includes('?') ? '&' : '?'}items=${idx}`
}

/** 解析 playlist_items 索引串 "1,3-5" → 升序索引数组；undefined → 全部 1..count */
function parseEntryIndices(entry: string | undefined, count: number): number[] {
    if (entry === undefined) return Array.from({ length: count }, (_, i) => i + 1)
    const out: number[] = []
    for (const token of entry.split(',')) {
        const m = /^(\d+)-(\d+)$/.exec(token.trim())
        if (m) {
            for (let n = +m[1]; n <= +m[2]; n++) out.push(n)
        } else {
            const n = parseInt(token, 10)
            if (Number.isFinite(n) && n > 0) out.push(n)
        }
    }
    return out.sort((a, b) => a - b)
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
        // 同一物理文件路径（引擎"文件已存在跳过"后的重复落库、删后重下回原位、
        // 旧记录合成 URL 索引偏移失配等场景）→ 复用原行，不插重复行；
        // 旧 video_url 是合成地址时顺带升级为本次的（真实）地址
        const dup = queryByMediaPath(params.mediaPath)
        if (dup) {
            touchRecord(dup.id)
            if (dup.videoUrl !== params.videoUrl) updateVideoUrl(dup.id, params.videoUrl)
            if (!params.quiet) console.log(`  [记录] 已存在，复用记录 (ID: ${dup.id})`)
            return dup.id
        }
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
        // 短链解析 + 规范化（vid/modal_id 弹层参数 → /video/<id>；主页剥参数）
        let targetUrl = canonicalizeDouyinUrl(await resolveDouyinShareLink(url))
        if (!options.json && targetUrl !== url) {
            console.log(`[规范化] ${url} → ${targetUrl}`)
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

        // 时间范围（--since/--until）
        let range: TimeRange | null = null
        if (options.since || options.until) {
            const r = parseTimeRange(options.since, options.until)
            if ('error' in r) {
                return { success: false, files: [], error: r.error }
            }
            range = r
        }

        // 第一步：解析（flat 枚举列表；条目缺元数据时自动补非 flat）
        if (!options.json) console.log('[解析] 引擎解析中...')
        const info = await extractInfoResolved(url)

        let entries = (info.entries || []).filter(Boolean)
        const isPlaylist = info._type === 'playlist' || entries.length > 1

        // 时间范围需要每条的发布时间 → 非 flat 全量提取（引擎单次上限 100 条，主页/空间通常最新在前）
        if (range && isPlaylist && entries.some(e => entryTimestamp(e) === null)) {
            if (!options.json) console.log('[时间] 获取条目发布时间（非 flat 提取，条目多时较慢）...')
            try {
                const full = await extractInfo(url, { flat: false })
                const fullEntries = (full.entries || []).filter(Boolean)
                if (fullEntries.length) entries = fullEntries
            } catch {
                // 整表提取被失效视频等中止 → 保留 flat，走下面的逐条提取
            }
            // 逐条兜底：失效视频只影响自己，不影响整表（慢但稳）
            if (entries.some(e => entryTimestamp(e) === null)) {
                if (!options.json) console.log('[时间] 部分条目无日期，逐条提取（跳过失效视频）...')
                for (let i = 0; i < entries.length; i++) {
                    if (entryTimestamp(entries[i]) !== null) continue
                    const entryUrl = (entries[i].url || entries[i].webpage_url) as string | undefined
                    if (!entryUrl) continue
                    try {
                        const one = await extractInfo(entryUrl, { flat: false })
                        const ts = entryTimestamp(one)
                        if (ts !== null) (entries[i] as any).timestamp = ts
                    } catch {
                        // 失效视频，跳过
                    }
                }
            }
        }

        // 单视频 + 时间范围 → 范围外直接跳过
        if (range && !isPlaylist) {
            const ts = entryTimestamp(info)
            if (ts !== null && (ts < range.sinceTs || ts > range.untilTs)) {
                if (!options.json) {
                    console.log(`\n[跳过] 发布于 ${formatTimePoint(ts)}，不在指定时间范围内`)
                }
                return { success: true, files: [] }
            }
        }

        // 列表条目选择：时间范围 > --items > --part > --all > 安全闸
        let entry: string | undefined
        if (isPlaylist) {
            const count = info.playlist_count || entries.length
            if (range) {
                const dated = entries.map((e, i) => ({ i, ts: entryTimestamp(e) }))
                const hits = dated
                    .filter(d => d.ts !== null && d.ts >= range.sinceTs && d.ts <= range.untilTs)
                    .map(d => d.i + 1)
                if (!options.json) {
                    console.log(`\n[时间] ${formatTimePoint(range.sinceTs)} ~ ${formatTimePoint(range.untilTs)} 命中 ${hits.length}/${entries.length} 条`)
                    hits.slice(0, 30).forEach(n => {
                        const e = entries[n - 1]
                        const ts = entryTimestamp(e)
                        console.log(`  [${n}] ${ts ? formatTimePoint(ts) : '????-??-??'}  ${e.title || e.id}`)
                    })
                    if (hits.length > 30) console.log(`  ... 还有 ${hits.length - 30} 条`)
                }
                if (hits.length === 0) {
                    const known = dated.filter(d => d.ts !== null).map(d => d.ts as number)
                    const span = known.length
                        ? `（已扫描条目的时间跨度 ${formatTimePoint(Math.min(...known))} ~ ${formatTimePoint(Math.max(...known))}，引擎单次最多扫描 100 条）`
                        : ''
                    return { success: false, files: [], error: `指定时间范围内没有条目${span}` }
                }
                entry = hits.join(',')
            } else if (options.items) {
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
                    console.log(`\n[提示] 指定 --items 1,3-5 / --part <N> / --all，或 --since/--until 按发布时间筛选`)
                }
                return {
                    success: false,
                    files: [],
                    error: `链接包含 ${count} 个条目，需指定 --items / --part / --all / 时间范围`,
                }
            }
        }

        // 去重（单视频场景）
        const canonicalUrl = String(info.webpage_url || info.original_url || url)
        if (!isPlaylist) {
            const existed = alreadyDownloaded(canonicalUrl, audioOnly)
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

        // 列表逐条去重：条目真实 URL（新记录）或合成 items URL（旧记录）命中且文件仍在 → 剔除该条，
        // 避免重复下载与重复 DB 行；文件被删的记录不命中，会正常重下
        const batchSkipped: Array<{ idx: number; dbId: number; mediaPath: string; title: string }> = []
        if (isPlaylist) {
            const indices = parseEntryIndices(entry, entries.length)
            const remaining: number[] = []
            for (const n of indices) {
                const e = entries[n - 1]
                if (!e) {
                    remaining.push(n) // 越界索引交给引擎报错
                    continue
                }
                let hit: { dbId: number; mediaPath: string } | null = null
                const realUrl = entryRealUrl(e)
                if (realUrl) hit = alreadyDownloaded(realUrl, audioOnly)
                if (!hit) hit = alreadyDownloaded(syntheticEntryUrl(canonicalUrl, n), audioOnly)
                if (hit) {
                    batchSkipped.push({ idx: n, dbId: hit.dbId, mediaPath: hit.mediaPath, title: String(e.title || e.id || '') })
                } else {
                    remaining.push(n)
                }
            }
            if (batchSkipped.length && !options.json) {
                console.log(`\n[去重] ${batchSkipped.length}/${indices.length} 个条目已下载且文件仍在，跳过:`)
                batchSkipped.slice(0, 20).forEach(s => console.log(`  [${s.idx}] ${s.title || s.mediaPath}`))
                if (batchSkipped.length > 20) console.log(`  ... 还有 ${batchSkipped.length - 20} 条`)
            }
            if (!remaining.length) {
                if (!options.json) console.log('[去重] 全部条目均已下载，无需重复下载')
                return {
                    success: true,
                    files: batchSkipped.map(s => ({
                        path: s.mediaPath,
                        size: fileSize(s.mediaPath),
                        type: (audioOnly ? 'audio' : 'video') as 'audio' | 'video',
                        title: s.title,
                        platform,
                        dbId: s.dbId,
                    })),
                }
            }
            if (batchSkipped.length) entry = remaining.join(',')
        }

        // 逐条关联索引（升序，与引擎 playlist_items 输出顺序一致；供落库取条目 URL/标题/发布时间）
        const downloadIndices = entry
            ? entry.split(',').map(t => parseInt(t, 10)).filter(n => Number.isFinite(n) && n > 0)
            : []

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
                // 按下载顺序关联条目（downloadIndices 升序，与引擎输出一致）；
                // videoUrl 优先记录条目真实地址（跨次去重键，索引偏移也不失配），无则退回合成 items URL
                const idx = downloadIndices[i]
                const selectedEntry = idx ? (entries[idx - 1] ?? null) : null
                const realUrl = entryRealUrl(selectedEntry)
                const entryUrl = realUrl
                    || (idx ? syntheticEntryUrl(canonicalUrl, idx) : canonicalUrl)
                const entryTs = selectedEntry ? entryTimestamp(selectedEntry) : null
                dbId = recordToDb({
                    platform,
                    username,
                    title: fileTitle,
                    videoUrl: entryUrl,
                    mediaPath: path,
                    publishedAt: entryTs ? formatTimePoint(entryTs).slice(0, 16) : normalizeUploadDate(info),
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

        // 跳过的已下载条目一并返回（调用方拿到的仍是完整产出集）
        const skippedFiles = batchSkipped.map(s => ({
            path: s.mediaPath,
            size: fileSize(s.mediaPath),
            type: (audioOnly ? 'audio' : 'video') as 'audio' | 'video',
            title: s.title,
            platform,
            dbId: s.dbId,
        }))
        return { success: true, files: [...skippedFiles, ...dbFiles] }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!options.json) console.error(`\n[错误] ${message}\n`)
        return { success: false, files: [], error: message }
    }
}
