#!/usr/bin/env node

import { Command } from 'commander'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { downloadCommand } from './commands/download.js'
import { parseCommand } from './commands/parse.js'
import { captionsCommand } from './commands/captions.js'
import { transcribeCommand } from './commands/transcribe.js'
import { engineCheck, engineVersion, ENGINE_SCRIPT, PROJECT_ROOT, setAnonMode } from './engine/driver.js'
import { openLoginPage, loginTargetFor } from './cookies.js'
import { profileExists, loginBrowserAlive, loginBrowserUrl, PROFILE_DIR, findBrowserExecutable } from './loginBrowser.js'
import { getPlatformDisplayName, normalizePlatform } from './platforms.js'
import { queryRecords, queryByPlatform, queryByTitle } from './db.js'

// 项目根目录（dist/ 上一级），默认路径不受 cwd 影响
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const program = new Command()

program
    .name('svdl')
    .description('多平台媒体下载 CLI —— 引擎为 galaxy-downloader-client 的 yt-dlp 封装（本地源码级，无远程 API）')
    .version('1.0.0')
// 主命令与子命令同名选项（--json 等）按位置归属：子命令名前的归主命令，之后的归子命令
program.enablePositionalOptions()

// 主命令：下载
program
    .argument('<url>', '媒体链接（视频/合集/用户主页）')
    .option('-t, --type <type>', '下载类型: video, audio, auto (默认: auto)', 'auto')
    .option('-o, --output <dir>', '输出目录', join(ROOT, 'downloads'))
    .option('--folder <name>', '子文件夹名（按系列/用户分组，强烈建议使用）')
    .option('-i, --items <items>', '列表条目选择，如 "1,3-5"')
    .option('--all', '下载列表全部条目')
    .option('-p, --part <num>', '单个分P/条目序号（--items N 的简写）')
    .option('--quality <quality>', '画质: lowest, highest, ask (默认: ask；音频模式自动最低)', 'ask')
    .option('--since <time>', '发布时间范围起点: 2026-11-13[ 09:00] / yesterday[ 09:00] / today / 7d')
    .option('--until <time>', '发布时间范围终点（同上，默认当前时刻）')
    .option('--format <format>', 'yt-dlp 格式选择器或 format_id（优先于 --quality）')
    .option('--save-cover', '同时保存封面图')
    .option('--browser', '浏览器模式（抖音用户主页/反爬兜底）')
    .option('--anon', '纯匿名：不注入 cookie、不弹登录提示')
    .option('--json', '输出 JSON 格式结果（进度走 stderr）')
    .action(async (url: string, options) => {
        process.env.GALAXY_BROWSER_MODE = options.browser ? 'true' : ''
        setAnonMode(!!options.anon)

        const output = options.folder ? `${options.output}/${options.folder}` : options.output

        const result = await downloadCommand({
            url,
            type: options.type as 'video' | 'audio' | 'images' | 'auto',
            output,
            items: options.items,
            all: options.all,
            part: options.part ? parseInt(options.part, 10) : undefined,
            browser: options.browser,
            json: options.json,
            quality: options.quality as 'lowest' | 'highest' | 'ask',
            format: options.format,
            saveCover: options.saveCover,
            since: options.since,
            until: options.until,
        })

        if (options.json) {
            console.log(JSON.stringify(result, null, 2))
        } else if (!result.success && result.error) {
            console.error(`\n[错误] ${result.error}\n`)
        }
        process.exit(result.success ? 0 : 1)
    })

// 子命令：登录浏览器（一次登录，cookie 长期有效）
program
    .command('login')
    .argument('<url>', '平台链接或域名（如 douyin.com / bilibili.com）')
    .description('打开专属浏览器登录目标平台（登录态持久保存，下载时自动注入）')
    .action(async (url: string) => {
        const fullUrl = /^https?:\/\//.test(url) ? url : `https://${url}/`
        const target = loginTargetFor(fullUrl)
        if (!target) {
            console.log(`\n未识别的平台，将直接打开: ${fullUrl}\n`)
        }
        try {
            const info = await openLoginPage(fullUrl)
            console.log(`\n[登录] 已在专属浏览器中打开 ${info.browserName}（${info.pageUrl}）`)
            console.log('[登录] 在窗口中完成登录（扫码/账密），登录状态会持久保存')
            console.log('[登录] 完成后可直接关闭窗口；之后下载/解析会自动携带该平台的登录态\n')
            console.log(`[登录] profile 位置: ${PROFILE_DIR}`)
            console.log('[登录] 抖音用户主页等场景仍需 --browser，将自动复用本实例\n')
            process.exit(0)
        } catch (error) {
            console.error(`\n[错误] ${error instanceof Error ? error.message : String(error)}\n`)
            process.exit(1)
        }
    })

// 子命令：仅解析信息
program
    .command('parse')
    .argument('<url>', '媒体链接')
    .description('解析媒体信息（条目/画质/元数据，不下载）')
    .option('--anon', '禁用登录浏览器 cookie 注入（纯匿名请求）')
    .option('--json', '输出 JSON 格式结果')
    .action(async (url: string, options) => {
        setAnonMode(!!options.anon)
        const result = await parseCommand({ url, json: options.json })
        if (options.json) {
            console.log(JSON.stringify(result, null, 2))
        }
        process.exit(result.success ? 0 : 1)
    })

// 子命令：下载字幕
program
    .command('captions')
    .argument('<url>', '媒体链接')
    .description('仅下载字幕（不下载媒体）')
    .option('-o, --output <dir>', '输出目录', join(ROOT, 'downloads'))
    .option('--folder <name>', '子文件夹名')
    .option('-l, --languages <langs>', '字幕语言，逗号分隔 (默认: zh)', 'zh')
    .option('--no-auto', '不使用自动生成字幕（仅手动上传的字幕）')
    .option('--anon', '禁用登录浏览器 cookie 注入（纯匿名请求）')
    .option('--json', '输出 JSON 格式结果')
    .action(async (url: string, options) => {
        setAnonMode(!!options.anon)
        const output = options.folder ? `${options.output}/${options.folder}` : options.output
        const result = await captionsCommand({
            url,
            output,
            languages: options.languages,
            auto: options.auto,
            json: options.json,
        })
        if (options.json) {
            console.log(JSON.stringify(result, null, 2))
        }
        process.exit(result.success ? 0 : 1)
    })

// 子命令：环境自检
program
    .command('status')
    .description('检查引擎/依赖/路径状态')
    .option('--json', '输出 JSON 格式结果')
    .action(async (options) => {
        const check = engineCheck()
        let engineVersionStr: string | null = null
        let engineError: string | null = null
        try {
            const v = await engineVersion(false)
            engineVersionStr = v.version
        } catch (e) {
            engineError = e instanceof Error ? e.message : String(e)
        }
        const loginAlive = await loginBrowserAlive()
        const browserBin = findBrowserExecutable()

        if (options.json) {
            console.log(JSON.stringify({
                engineScript: check.engineScriptOk,
                python: check.pythonOk,
                ffmpeg: check.ffmpeg,
                ytDlp: engineVersionStr,
                loginProfile: profileExists(),
                loginBrowserRunning: loginAlive,
                browserExecutable: browserBin,
                error: engineError,
            }, null, 2))
            process.exit(0)
        }

        console.log('\n环境状态:')
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.log(`引擎源码 (submodule): ${check.engineScriptOk ? '✅ ' + ENGINE_SCRIPT : '❌ 缺失，运行 git submodule update --init --recursive'}`)
        console.log(`Python 环境 (.venv-engine): ${check.pythonOk ? '✅' : '❌ 缺失，运行 npm run setup'}`)
        console.log(`ffmpeg: ${check.ffmpeg ? '✅ ' + check.ffmpeg : '❌ 未安装（brew install ffmpeg）'}`)
        console.log(`yt-dlp 版本: ${engineVersionStr ? '✅ ' + engineVersionStr : `❌ ${engineError}`}`)
        console.log(`登录浏览器: ${profileExists() ? '✅ 已初始化' : '○ 未登录（svdl login douyin.com 开启）'}${loginAlive ? '，实例运行中' : ''}`)
        console.log(`浏览器二进制: ${browserBin || '❌ 未找到（设置 GALAXY_BROWSER_EXECUTABLE）'}`)
        console.log(`下载目录: ${join(ROOT, 'downloads')}`)
        console.log(`转录目录: ${join(ROOT, 'transcripts')}`)
        console.log(`数据库: ${join(ROOT, '.data', 'short_video.db')}`)
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
        process.exit(engineVersionStr ? 0 : 1)
    })

// 子命令：显示支持的平台
program
    .command('platforms')
    .description('显示支持的平台列表')
    .action(() => {
        console.log('\n支持的平台（引擎 = yt-dlp，列表为常用站点）:')
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        const platforms = [
            { name: 'Bilibili', support: '视频、音频、多P、合集、用户空间' },
            { name: 'YouTube', support: '视频、音频、字幕、频道/合集' },
            { name: '抖音', support: '视频（引擎）；用户主页需 --browser Edge 模式' },
            { name: 'TikTok', support: '视频、音频' },
            { name: '小红书', support: '视频（部分内容需登录态）' },
            { name: 'X/Twitter', support: '视频、音频' },
            { name: 'Instagram', support: 'Reels、帖子' },
            { name: '微博', support: '视频、音频' },
            { name: '微信公众号', support: '文章内嵌视频' },
            { name: '更多', support: 'yt-dlp 支持的 1000+ 站点（用 parse 命令试探）' },
        ]
        platforms.forEach(p => {
            console.log(`\n  ${p.name}`)
            console.log(`    支持: ${p.support}`)
        })
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
    })

// 子命令：下载历史
program
    .command('history')
    .argument('[query]', '搜索关键词（按标题搜索）')
    .option('-p, --platform <name>', '按平台筛选: bilibili, douyin, tiktok 等')
    .option('-n, --limit <num>', '显示条数 (默认: 20)', '20')
    .description('查看下载历史记录')
    .action((query: string | undefined, options: any) => {
        let records: any[]
        if (options.platform) {
            records = queryByPlatform(options.platform)
        } else if (query) {
            records = queryByTitle(query)
        } else {
            records = queryRecords(parseInt(options.limit, 10))
        }

        if (records.length === 0) {
            console.log('\n暂无下载记录\n')
            process.exit(0)
        }

        console.log('\n下载历史:')
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        records.forEach(r => {
            console.log(`[${r.id}] ${r.title}`)
            console.log(`    平台: ${getPlatformDisplayName(normalizePlatform(r.platform))}  |  发布: ${r.publishedAt || '未知'}  |  下载: ${r.downloadedAt}`)
            console.log(`    文件: ${r.mediaPath || '(无)'}`)
            console.log(`    转录: ${r.transcriptText ? '✅ 已完成' : '(未转录)'}`)
            console.log('')
        })
        console.log(`共 ${records.length} 条记录`)
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
        process.exit(0)
    })

// 子命令：音频转录
program
    .command('transcribe')
    .argument('<input>', '音频文件或目录路径')
    .description('将音频转录为文本（默认 Qwen3-ASR），可选 --polish 用 LLM 润色提升可读性')
    .option('--outdir <dir>', '输出目录', join(ROOT, 'transcripts'))
    .option('--folder <name>', '子文件夹名（按系列/用户分组）')
    .option('-m, --model <path>', '转录模型路径 (默认: ~/.omlx/models/Qwen3-ASR-0.6B-8bit)')
    .option('-l, --language <lang>', '语言代码: zh, en, ja, ko 等 (默认: zh)', 'zh')
    .option('-f, --format <format>', '输出格式: txt, srt, vtt, json (默认: txt)', 'txt')
    .option('--api <url>', '使用 API 服务转录（如 http://localhost:8000）')
    .option('--api-key <key>', 'API 服务密钥')
    .option('--polish', '转录后用 LLM 润色文本，提升可读性（需配置根目录 .env）')
    .action(async (input: string, options: any) => {
        const output = options.folder ? `${options.outdir}/${options.folder}` : options.outdir

        const result = await transcribeCommand({
            input,
            output,
            model: options.model,
            language: options.language,
            format: options.format as 'txt' | 'srt' | 'vtt' | 'json',
            api: options.api,
            apiKey: options.apiKey,
            polish: options.polish,
        })
        if (!result.success && result.error) {
            console.error(`\n[错误] ${result.error}\n`)
        }
        process.exit(result.success ? 0 : 1)
    })

program.parse()
