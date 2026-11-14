/**
 * 无头浏览器解析模块
 *
 * 使用 Puppeteer 解析抖音用户主页和单个视频
 * 需要安装可选依赖：puppeteer-core
 *
 * 支持无限滚动分页加载，获取全部视频
 */

import type { ParserResult } from './types.js'

// 可选依赖的类型声明（动态导入时使用 any）
type PuppeteerExtra = any
type PuppeteerPage = any

/**
 * 检查 Puppeteer 是否可用
 */
export async function isPuppeteerAvailable(): Promise<boolean> {
    try {
        await import('puppeteer-core')
        return true
    } catch {
        return false
    }
}

/**
 * 自动滚动页面加载全部视频
 *
 * @param page Puppeteer 页面对象
 * @param maxVideos 最大视频数量限制（防止无限循环）
 * @param maxScrolls 最大滚动次数限制
 * @param apiInfo API 信息（用于直接调用分页 API）
 * @returns 全部视频 ID 数组
 */
interface ApiInfo {
    lastApiUrl: string | null
    lastCursor: string | null
    hasMoreData: boolean
}

async function autoScrollAndGetVideos(
    page: PuppeteerPage,
    maxVideos: number = 500,
    maxScrolls: number = 100,
    _apiInfo?: ApiInfo,
    shouldStop?: () => boolean,
): Promise<string[]> {
    let allIds: Set<string> = new Set()
    let noNewDataCount = 0
    let scrollCount = 0
    const maxNoNewData = 15

    console.log('[浏览器] 开始自动滚动加载视频...')

    // 使用 CDP Input.dispatchMouseEvent 发送真实 OS 级鼠标滚轮事件
    // 这是唯一能触发抖音懒加载的方式（page.evaluate 注入的事件 isTrusted=false 无法触发）
    const cdp = await page.target().createCDPSession()

    const collectIds = async () => {
        try {
            const newIds = await page.evaluate(() => {
                const ids: string[] = []
                document.querySelectorAll('a[href*="/video/"]').forEach(el => {
                    const href = el.getAttribute('href') || ''
                    const match = href.match(/video\/(\d+)/)
                    if (match && match[1]) ids.push(match[1])
                })
                return Array.from(new Set(ids))
            })
            for (const id of newIds) allIds.add(id)
        } catch (e) { /* ignore */ }
    }

    await collectIds()
    console.log(`[浏览器] 初始有 ${allIds.size} 个视频`)

    // 从视口获取鼠标坐标，避免硬编码
    const viewport = page.viewport() || { width: 1280, height: 800 }
    const cx = Math.floor(viewport.width / 2)
    const cy = Math.floor(viewport.height / 2)

    while (scrollCount < maxScrolls && allIds.size < maxVideos && !shouldStop?.()) {
        const currentCount = allIds.size

        try {
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 800
            })
        } catch (e) {}

        await new Promise(resolve => setTimeout(resolve, 2000))

        if (scrollCount % 5 === 0) {
            try {
                await cdp.send('Input.dispatchMouseEvent', {
                    type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 2000
                })
            } catch (e) {}
            await new Promise(resolve => setTimeout(resolve, 2000))
        }

        scrollCount++
        await collectIds()
        const newCount = allIds.size

        if (newCount > currentCount) {
            console.log(`[浏览器] 已加载 ${newCount} 个视频 (滚动 ${scrollCount} 次)`)
            noNewDataCount = 0
        } else {
            // 检查是否出现"暂时没有更多了"（最可靠的停止信号）
            noNewDataCount++
            try {
                const noMore = await page.evaluate(() => {
                    const body = document.body.innerText || ''
                    return body.includes('暂时没有更多了') || body.includes('没有更多了')
                })
                if (noMore) {
                    console.log('[浏览器] 页面显示"暂时没有更多了"，停止滚动')
                    break
                }
            } catch (e) {}

            if (noNewDataCount % 5 === 0) {
                console.log(`[浏览器] 无新数据 (${noNewDataCount}/${maxNoNewData})，当前 ${newCount} 个视频`)
            }
            if (noNewDataCount >= maxNoNewData) {
                console.log('[浏览器] 连续多次无新数据，停止滚动')
                break
            }
        }
    }

    if (scrollCount >= maxScrolls) {
        console.log(`[浏览器] 达到最大滚动次数限制 (${maxScrolls})`)
    }
    if (allIds.size >= maxVideos) {
        console.log(`[浏览器] 达到最大视频数量限制 (${maxVideos})`)
    }

    return Array.from(allIds)
}

/**
 * 使用浏览器解析抖音用户主页（支持无限滚动）
 */
/**
 * 解析抖音用户主页。
 * opts.stopTs：时间下界（Unix 秒）——主页除置顶外按时间倒序，遇到非置顶且
 * 早于 stopTs 的视频即停止滚动（--since 的早停优化，不必加载全部视频）。
 */
export async function parseDouyinUserHomepageWithBrowser(
    url: string,
    opts: { stopTs?: number } = {},
): Promise<ParserResult> {
    // 检查依赖是否可用
    if (!await isPuppeteerAvailable()) {
        return {
            success: false,
            error: '浏览器模式需要安装 Puppeteer。\n请运行：npm install puppeteer-core',
            code: 'DEPENDENCY_MISSING',
        }
    }

    // 必须连接用户已有的 Edge/Chrome（保留登录态和 Cookie）
    // 不再自动启动新浏览器，因为新实例没有用户的登录态，对抖音反爬无效
    const chromeDebugUrl = process.env.GALAXY_CHROME_DEBUG_URL || 'http://127.0.0.1:9222'

    try {
        const response = await fetch(`${chromeDebugUrl}/json/version`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch {
        return {
            success: false,
            error: `未找到可连接的浏览器（${chromeDebugUrl}）。

推荐方式（一次配置，长期有效）：

  svdl login douyin.com

  # 在弹出的专属浏览器窗口中登录抖音，之后 --browser 会自动复用该实例（端口 9223）

备选方式（复用日常 Edge 的登录态）：

  Edge 150+ 禁止在默认 Profile 上启用远程调试，必须手动启动调试实例：

  # 1. 彻底关闭 Edge
  pkill -9 -f "Microsoft Edge"

  # 2. 复制 Profile（保留登录态）
  cp -r ~/Library/Application\\ Support/Microsoft\\ Edge ~/Library/Application\\ Support/Microsoft\\ Edge\\ Debug

  # 3. 二进制直接启动（不能用 open -a）
  /Applications/Microsoft\\ Edge.app/Contents/MacOS/Microsoft\\ Edge --remote-debugging-port=9222 --user-data-dir="$HOME/Library/Application Support/Microsoft Edge Debug" &

  # 4. 确认端口已监听
  curl -s http://127.0.0.1:9222/json/version`,
            code: 'DEPENDENCY_MISSING',
        }
    }

    console.log(`[浏览器] 连接到已有浏览器: ${chromeDebugUrl}`)

    try {
        // 使用 puppeteer-core 直连，不用 stealth 插件（stealth 会破坏页面布局）
        const puppeteer = await import('puppeteer-core')

        const browser = await puppeteer.default.connect({
            browserURL: chromeDebugUrl,
            defaultViewport: null,
        })

        const page = await browser.newPage()


        // 监听响应，捕获 API URL 和 cursor 参数
        let lastApiUrl: string | null = null
        let lastCursor: string | null = null
        let hasMoreData: boolean = false
        let userId: string | null = null // 用户 ID

        // 用于直接从 API 响应收集视频 ID 和描述
        const collectedVideoIds: Set<string> = new Set()
        const videoDescMap: Map<string, string> = new Map()
        const videoTimeMap: Map<string, number> = new Map()
        // 时间下界早停：置顶视频(is_top)不参与判断，其余按倒序一旦早于 stopTs 即停
        let earlyStopped = false
        const stopTs = opts.stopTs

        page.on('response', async (response: any) => {
            const url = response.url()
            if (url.includes('/aweme/post')) {
                console.log(`[浏览器] API 响应完整 URL: ${url.slice(0, 150)}...`)
                lastApiUrl = url
                try {
                    const data = await response.json()
                    if (data?.aweme_list) {
                        console.log(`[浏览器] 响应包含 ${data.aweme_list.length} 个视频`)

                        // 直接从 API 响应收集视频 ID、描述和发布时间（统一转字符串避免类型不匹配）
                        for (const item of data.aweme_list) {
                            if (item.aweme_id) {
                                const id = String(item.aweme_id)
                                collectedVideoIds.add(id)
                                if (item.desc) videoDescMap.set(id, item.desc)
                                if (item.create_time) videoTimeMap.set(id, Number(item.create_time))
                                if (stopTs && !earlyStopped && item.create_time && !item.is_top
                                    && Number(item.create_time) < stopTs) {
                                    earlyStopped = true
                                    console.log(`[浏览器] 遇到早于时间下界的视频，停止加载（已收集 ${collectedVideoIds.size} 个）`)
                                }
                            }
                        }
                        console.log(`[浏览器] 已收集 ${collectedVideoIds.size} 个视频 ID`)

                        // 输出 cursor 参数（用于分页）
                        if (data.cursor || data.max_cursor || data.next_cursor) {
                            lastCursor = data.cursor || data.max_cursor || data.next_cursor
                            console.log(`[浏览器] 分页 cursor: ${lastCursor}`)
                        }
                        // has_more 参数
                        hasMoreData = data.has_more === 1 || data.has_more === true
                        console.log(`[浏览器] has_more: ${hasMoreData}`)
                        // 提取用户 ID（如果有的话）
                        if (data.aweme_list[0]?.author_user_id) {
                            userId = data.aweme_list[0].author_user_id
                        }
                        // 检查 URL 中是否包含 a_bogus 参数（签名参数）
                        const aBogusMatch = url.match(/a_bogus=([^&]+)/)
                        if (aBogusMatch) {
                            console.log(`[浏览器] 发现 a_bogus 签名参数: ${aBogusMatch[1].slice(0, 20)}...`)
                        }
                    }
                } catch {
                    // 非 JSON 响应
                }
            }
        })

        console.log('[浏览器] 访问用户主页...')

        // 访问用户主页
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 30000,
        })

        // 等待页面初始加载
        await new Promise(resolve => setTimeout(resolve, 3000))

        // 尝试等待视频元素
        try {
            await page.waitForSelector('[class*="video"]', { timeout: 10000 })
        } catch {
            // 可能页面结构不同，继续尝试提取
        }

        // 自动滚动加载视频（stopTs 存在时滚动到时间下界即提前停止）
        await autoScrollAndGetVideos(page, 500, 50, undefined, () => earlyStopped)

        // 以 API 响应中收集到的视频为准（有标题描述），DOM 仅用于触发滚动
        const videoIds = Array.from(collectedVideoIds)

        // 断开连接（保留用户浏览器和登录态）
        console.log('[浏览器] 断开连接（保留现有浏览器）')
        await browser.disconnect()

        console.log(`[浏览器] 总计找到 ${videoIds.length} 个视频${earlyStopped ? '（已到时间下界，提前停止）' : ''}`)

        // 添加说明：如果视频数量少于预期，说明分页被反爬机制阻止
        if (videoIds.length < 50 && hasMoreData) {
            console.log(`[浏览器] ⚠️  注意: 抖音使用了反爬签名机制，无法加载更多视频`)
            console.log(`[浏览器] 建议: 在浏览器中手动滚动页面，或使用其他工具获取完整列表`)
        }

        if (videoIds.length === 0) {
            return {
                success: false,
                error: '未找到视频，可能用户主页为空或需要登录',
                code: 'PARSE_FAILED',
            }
        }

        // 返回结果
        return {
            success: true,
            data: {
                title: `用户视频合集 (${videoIds.length} 个)`,
                desc: `共 ${videoIds.length} 个视频`,
                cover: '',
                platform: 'douyin',
                url: url,
                duration: 0,
                downloadVideoUrl: null,
                downloadAudioUrl: null,
                originDownloadVideoUrl: null,
                originDownloadAudioUrl: null,
                mediaActions: {
                    video: 'direct-download',
                    audio: 'extract-audio',
                },
                noteType: 'video',
                isMultiPart: true,
                pages: videoIds.map((id: string, i: number) => ({
                    page: i + 1,
                    cid: id,
                    part: videoDescMap.get(id) || `视频 ${i + 1}`,
                    duration: 0,
                    downloadVideoUrl: `https://www.douyin.com/video/${id}`,
                    downloadAudioUrl: null,
                    ...(videoTimeMap.has(id) ? { createTime: videoTimeMap.get(id) } : {}),
                })),
            },
        }
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : '浏览器解析失败',
            code: 'UPSTREAM_ERROR',
        }
    }
}

/**
 * 使用浏览器解析单个抖音视频，通过 CDP 拦截真实的视频流 URL
 *
 * 原因：旧的 playwm API (aweme.snssdk.com/aweme/v1/playwm/) 返回 404，
 * 移动端 API (iesdouyin.com) 返回 "encrypt_data_miss"，
 * 分享页面也不再内嵌视频 URL — 唯一可靠方式是通过浏览器 CDP 拦截。
 */
export async function parseDouyinVideoWithBrowser(videoUrl: string, quality?: 'lowest' | 'highest'): Promise<ParserResult> {
    if (!await isPuppeteerAvailable()) {
        return {
            success: false,
            error: '浏览器模式需要安装 Puppeteer。请运行：npm install puppeteer-core',
            code: 'DEPENDENCY_MISSING',
        }
    }

    const chromeDebugUrl = process.env.GALAXY_CHROME_DEBUG_URL || 'http://127.0.0.1:9222'

    try {
        const response = await fetch(`${chromeDebugUrl}/json/version`)
        if (!response.ok) {
            return {
                success: false,
                error: '未找到可连接的浏览器，请先启动 Edge 远程调试（端口 9222）',
                code: 'DEPENDENCY_MISSING',
            }
        }
    } catch {
        return {
            success: false,
            error: '未找到可连接的浏览器，请先启动 Edge 远程调试（端口 9222）',
            code: 'DEPENDENCY_MISSING',
        }
    }

    console.log(`[浏览器] 连接到已有浏览器: ${chromeDebugUrl}`)

    try {
        const puppeteer = await import('puppeteer-core')

        const browser = await puppeteer.default.connect({
            browserURL: chromeDebugUrl,
            defaultViewport: null,
        })

        const page = await browser.newPage()

        // 拦截网络响应，捕获视频流 URL 和画质信息
        let capturedVideoUrl: string | null = null
        let capturedVideoSize: number = 0
        let capturedTitle: string = ''
        let apiTitle: string = ''
        // 最低画质模式：从 detail API 捕获 bit_rate 数组
        let bitRateOptions: Array<{ gear_name: string; bit_rate: number; url: string }> = []
        let lowestQualityUrl: string | null = null
        // 默认合成流 URL（始终含音轨，用于提取音频场景）
        let defaultPlayAddr: string | null = null

        page.on('response', async (response: any) => {
            const url = response.url()
            const headers = response.headers() || {}
            const contentType = headers['content-type'] || ''
            const contentLength = parseInt(headers['content-length'] || '0', 10)

            // 从 detail API 提取标题和画质选项
            if (url.includes('/aweme/v1/web/aweme/detail/')) {
                try {
                    const data = await response.json()
                    const detail = data?.aweme_detail
                    if (detail?.desc) {
                        apiTitle = detail.desc
                        console.log(`[浏览器] API 标题: ${apiTitle}`)
                    }
                    // 提取 bit_rate 用于最低画质选择
                    const video = detail?.video
                    if (video) {
                        // 默认 play_addr 是进度式合成流（音视频合一），bit_rate 各档位
                        // 无法从档位名区分是否含音轨（实测同一档位在不同视频上不一致，
                        // adapt_*/720_1_1 等多为 DASH 纯视频流），提取音频必须用它兜底
                        const defAddr = (video.play_addr?.url_list || video.playAddr?.urlList || [])[0]
                        if (defAddr) defaultPlayAddr = defAddr
                        const bitRates: any[] = video.bit_rate || video.bitRate || []
                        if (bitRates.length > 0) {
                            bitRateOptions = bitRates
                                .map((br: any) => ({
                                    gear_name: br.gear_name || 'unknown',
                                    bit_rate: br.bit_rate || 0,
                                    url: (br.play_addr?.url_list || br.playAddr?.urlList || [])[0] || '',
                                }))
                                .filter(b => b.url)
                            console.log(`[浏览器] 画质选项: ${bitRateOptions.map(b => `${b.gear_name}(${(b.bit_rate/1000).toFixed(0)}kbps)`).join(', ')}`)
                        }
                    }
                } catch {}
            }

            // 匹配视频流 URL（抖音 CDN 视频地址特征）
            const isVideoUrl = (
                contentType.includes('video/') ||
                url.includes('.mp4') ||
                url.includes('douyinvod.com') ||
                url.includes('bytecdn') ||
                (url.includes('aweme.snssdk.com') && !url.includes('playwm'))
            )

            if (isVideoUrl && contentLength > capturedVideoSize) {
                capturedVideoUrl = url
                capturedVideoSize = contentLength
                console.log(`[浏览器] 捕获视频流: ${url.slice(0, 80)}... (${(contentLength / 1024 / 1024).toFixed(1)}MB)`)
            }
        })

        console.log(`[浏览器] 访问视频页面: ${videoUrl}`)
        await page.goto(videoUrl, {
            waitUntil: 'networkidle2',
            timeout: 30000,
        })

        // detail API 的响应是异步捕获的，networkidle2 后 flags 可能尚未就绪；
        // 最低画质模式必须等它（兜底的捕获流可能是 DASH 纯视频段，无音轨）
        if (quality === 'lowest' && !defaultPlayAddr && bitRateOptions.length === 0) {
            console.log('[浏览器] 等待 detail API 数据...')
            for (let i = 0; i < 8 && !defaultPlayAddr && bitRateOptions.length === 0; i++) {
                await new Promise(resolve => setTimeout(resolve, 1000))
            }
        }

        // 最低画质模式：用 detail API 的 bit_rate 选最低码率流
        if (quality === 'lowest' && bitRateOptions.length > 0) {
            const defAddr = defaultPlayAddr as string | null
            if (defAddr) {
                // 合成流保证含音轨（低码率档多为 DASH 纯视频流，无法提取音频）
                lowestQualityUrl = defAddr
                console.log(`[浏览器] 最低画质: 默认合成流（保证含音轨） → ${defAddr.slice(0, 60)}...`)
            } else {
                const sorted = [...bitRateOptions].sort((a, b) => a.bit_rate - b.bit_rate)
                lowestQualityUrl = sorted[0].url
                console.log(`[浏览器] 最低画质: ${sorted[0].gear_name} (${(sorted[0].bit_rate/1000).toFixed(0)}kbps, 无默认流备选) → ${lowestQualityUrl.slice(0, 60)}...`)
            }
        }

        // 等待视频开始加载（最高画质模式需要）
        if (quality !== 'lowest') {
            await new Promise(resolve => setTimeout(resolve, 4000))

            // 如果还没捕获到视频 URL，继续等待
            if (!capturedVideoUrl) {
                console.log('[浏览器] 等待视频加载...')
                let waitAttempts = 0
                while (!capturedVideoUrl && waitAttempts < 8) {
                    await new Promise(resolve => setTimeout(resolve, 2000))
                    waitAttempts++
                }
            }
        }

        // 优先使用 API 标题，否则从页面提取
        capturedTitle = apiTitle
        if (!capturedTitle) {
            try {
                capturedTitle = await page.evaluate(() => {
                    const titleEl = document.querySelector('[data-e2e="video-title"]') ||
                        document.querySelector('.video-title') ||
                        document.querySelector('title')
                    return titleEl?.textContent?.replace(' - 抖音', '').trim() || ''
                })
            } catch {}
        }

        await page.close()
        await browser.disconnect()

        // 选择最终 URL：
        // - lowest：bit_rate 选出的最低档/默认合成流
        // - highest：detail API 的 bit_rate 最高档直选（确定性拿平台最高画质，
        //   不依赖播放器实际加载了什么）；DASH 无音轨流由下载方 ffprobe 校验后回退
        // - 无 bit_rate 数据：用捕获的播放器流
        let finalVideoUrl: string | null
        let fallbackVideoUrl: string | null = null

        if (quality === 'lowest' && lowestQualityUrl) {
            finalVideoUrl = lowestQualityUrl
        } else if (quality !== 'lowest' && bitRateOptions.length > 0) {
            const best = [...bitRateOptions].sort((a, b) => b.bit_rate - a.bit_rate)[0]
            finalVideoUrl = best.url
            // 回退链：播放器实际加载的流（必有音轨）→ 默认合成流
            fallbackVideoUrl = capturedVideoUrl || defaultPlayAddr || null
            console.log(`[浏览器] 最高画质(API直选): ${best.gear_name} (${(best.bit_rate/1000).toFixed(0)}kbps)${fallbackVideoUrl ? '（无音轨时自动回退）' : ''}`)
        } else {
            finalVideoUrl = capturedVideoUrl
        }

        if (!finalVideoUrl) {
            // 如果是低画质模式但没拿到 bit_rate，回退到捕获的流
            if (quality === 'lowest' && capturedVideoUrl) {
                console.log('[浏览器] bit_rate 不可用，回退到捕获的视频流')
                finalVideoUrl = capturedVideoUrl
            } else {
                return {
                    success: false,
                    error: '未能捕获视频下载链接，请确认视频页面已正常加载',
                    code: 'UPSTREAM_ERROR',
                }
            }
        }

        console.log(`[浏览器] 视频标题: ${capturedTitle || '(未获取)'}`)

        return {
            success: true,
            data: {
                title: capturedTitle || '抖音视频',
                desc: capturedTitle || '',
                cover: '',
                platform: 'douyin',
                url: videoUrl,
                duration: 0,
                downloadVideoUrl: finalVideoUrl,
                fallbackVideoUrl,
                downloadAudioUrl: null,
                originDownloadVideoUrl: finalVideoUrl,
                originDownloadAudioUrl: null,
                mediaActions: {
                    video: 'direct-download',
                    audio: 'extract-audio',
                },
                noteType: 'video',
            },
        }
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : '浏览器解析失败',
            code: 'UPSTREAM_ERROR',
        }
    }
}
