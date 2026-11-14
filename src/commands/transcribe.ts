import { execSync } from 'child_process'
import { join, dirname } from 'path'
import { existsSync, readdirSync, statSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { queryByTitle, updateTranscript } from '../db.js'
import { loadLlmConfig, polishText } from '../utils/llm.js'
import { ensureAsrServer, stopAsrServer, type AsrServerHandle } from '../utils/asrServer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface TranscribeOptions {
    input: string
    output: string
    model?: string
    language?: string
    api?: string
    apiKey?: string
    format?: 'txt' | 'srt' | 'vtt' | 'json'
    polish?: boolean
}

export interface TranscribeResult {
    success: boolean
    files: Array<{
        input: string
        output: string
        text?: string
        error?: string
    }>
    total: number
    successCount: number
    failCount: number
    error?: string
}

/**
 * 获取 Python helper 脚本路径
 */
function getPythonScriptPath(): string {
    const scriptPath = join(__dirname, '..', '..', 'scripts', 'transcribe.py')
    if (!existsSync(scriptPath)) {
        throw new Error(`Python 转录脚本不存在: ${scriptPath}`)
    }
    return scriptPath
}

/**
 * 检查 Python 环境是否有 mlx-audio
 */
function checkMlxAudio(): boolean {
    try {
        execSync('python3 -c "import mlx_audio.stt.generate" 2>/dev/null', { stdio: 'pipe' })
        return true
    } catch {
        return false
    }
}

/**
 * 使用 API 服务转录单个文件
 * unreachable=true 表示网络层失败（服务失联/被关闭），调用方可据此重启服务并重试
 */
async function transcribeWithApi(
    filePath: string,
    apiUrl: string,
    apiKey: string,
    language: string = 'zh'
): Promise<{ success: boolean; text?: string; error?: string; unreachable?: boolean }> {
    try {
        const fileBytes = readFileSync(filePath)
        const formData = new FormData()
        formData.append('file', new Blob([fileBytes]), filePath.split('/').pop() || 'audio.mp3')
        formData.append('model', 'whisper-large-v3-turbo')
        formData.append('language', language)
        formData.append('response_format', 'json')

        const response = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/audio/transcriptions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
            },
            body: formData,
            signal: AbortSignal.timeout(30 * 60_000), // 长音频 30 分钟上限
        })

        if (!response.ok) {
            const errorText = await response.text()
            return { success: false, error: `API 错误: ${response.status} - ${errorText.slice(0, 200)}` }
        }

        const data = await response.json() as any
        return { success: true, text: ((data.text || '') as string).trim() }
    } catch (error) {
        return {
            success: false,
            unreachable: true,
            error: error instanceof Error ? error.message : 'API 请求失败',
        }
    }
}

/**
 * 使用本地 mlx-audio 转录单个文件
 */
function transcribeWithMlxAudio(
    filePath: string,
    outputPath: string,
    model: string,
    language: string,
    format: string
): { success: boolean; text?: string; error?: string } {
    try {
        const scriptPath = getPythonScriptPath()
        const args = [
            scriptPath,
            '--audio', filePath,
            '--output', outputPath,
            '--model', model,
            '--language', language,
            '--format', format,
        ]

        const result = execSync(`python3 ${args.map(a => `"${a}"`).join(' ')}`, {
            encoding: 'utf-8',
            timeout: 3600000, // 60 分钟超时
            stdio: ['pipe', 'pipe', 'pipe'],
        })

        // 读取输出文件
        const outputFile = `${outputPath}.${format}`
        if (existsSync(outputFile)) {
            const text = readFileSync(outputFile, 'utf-8')
            return { success: true, text }
        }

        return { success: true, text: result.trim() }
    } catch (error) {
        const message = error instanceof Error ? error.message : '转录失败'
        return { success: false, error: message }
    }
}

/**
 * 获取输入目录中的所有媒体文件（音频 + 视频容器，视频会先提取音轨）
 */
const AUDIO_RE = /\.(mp3|wav|m4a|flac|ogg|aac)$/i
const VIDEO_RE = /\.(mp4|mkv|webm|mov|avi)$/i

function getAudioFiles(input: string): string[] {
    if (!existsSync(input)) {
        return []
    }

    const stat = statSync(input)
    if (stat.isFile()) {
        // 单文件
        if (input.match(AUDIO_RE) || input.match(VIDEO_RE)) {
            return [input]
        }
        return []
    }

    // 目录
    const files = readdirSync(input)
    const media = files
        .filter(f => (f.match(AUDIO_RE) || f.match(VIDEO_RE)) && !f.includes('.polished.'))
        .filter(f => !f.endsWith('.part')) // 未完成的分块下载
    // 去重：视频与其已提取的同名音轨（.m4a）只按视频计一条（ensureAudioTrack 会复用音轨）
    const videoBaseNames = new Set(
        media.filter(f => VIDEO_RE.test(f)).map(f => f.replace(/\.[^.]+$/, '')),
    )
    return media
        .filter(f => VIDEO_RE.test(f) || !videoBaseNames.has(f.replace(/\.[^.]+$/, '')))
        .map(f => join(input, f))
        .sort()
}

/**
 * 视频文件 → 同目录 .m4a（ffmpeg 无重编码 copy，失败回退重编码；已存在则复用）。
 * 返回值即为送入 ASR 的音频路径；音频文件原样返回。
 */
function ensureAudioTrack(filePath: string): { audioPath: string; error?: string } {
    if (!VIDEO_RE.test(filePath)) {
        return { audioPath: filePath }
    }
    const audioPath = filePath.replace(/\.[^.]+$/, '') + '.m4a'
    if (existsSync(audioPath)) {
        return { audioPath }
    }
    try {
        // 优先无损 copy（aac 音轨瞬时完成）
        execSync(`ffmpeg -y -i "${filePath}" -vn -acodec copy "${audioPath}" 2>/dev/null`, { timeout: 120_000, stdio: 'pipe' })
    } catch {
        try {
            // 非 aac 音轨（部分 mkv/webm）：重编码
            execSync(`ffmpeg -y -i "${filePath}" -vn -acodec aac -b:a 192k "${audioPath}" 2>/dev/null`, { timeout: 300_000, stdio: 'pipe' })
        } catch (error) {
            return { audioPath, error: `音轨提取失败: ${error instanceof Error ? error.message : 'ffmpeg error'}` }
        }
    }
    console.log(`  [提取音轨] ${filePath.split('/').pop()} → ${audioPath.split('/').pop()}`)
    return { audioPath }
}

/**
 * 执行转录命令
 */
export async function transcribeCommand(options: TranscribeOptions): Promise<TranscribeResult> {
    const { input, output, model, language, api, apiKey, format, polish } = options

    // 默认值
    const outputPath = output || './transcripts'
    const modelPath = model || process.env.GALAXY_WHISPER_MODEL || '/Users/yiyi/.omlx/models/Qwen3-ASR-0.6B-8bit'
    const lang = language || 'zh'
    const outputFormat = format || 'txt'

    // 加载 LLM 配置（用于可选的转录文本润色）
    const llmConfig = polish ? loadLlmConfig() : null
    const willPolish = !!(polish && llmConfig?.apiKey)
    if (polish && !willPolish) {
        console.log(`[润色] 未配置 LLM api_key，将跳过润色步骤`)
    }

    console.log(`\n[转录] 正在处理: ${input}`)
    console.log(`[输出] 目录: ${outputPath}`)
    console.log(`[模型] ${modelPath}`)
    console.log(`[语言] ${lang}`)
    console.log(`[格式] ${outputFormat}`)
    if (willPolish) {
        console.log(`[润色] 开启（模型: ${llmConfig!.model}）`)
    }

    // 创建输出目录
    mkdirSync(outputPath, { recursive: true })

    // 获取音频文件
    const audioFiles = getAudioFiles(input)
    if (audioFiles.length === 0) {
        return {
            success: false,
            files: [],
            total: 0,
            successCount: 0,
            failCount: 0,
            error: '未找到可转录的媒体文件。支持音频 (mp3/wav/m4a/flac/ogg/aac) 与视频容器 (mp4/mkv/webm/mov，自动提取音轨)',
        }
    }

    console.log(`\n[文件] 共 ${audioFiles.length} 个音频文件`)

    // 转录方式: 显式 --api 优先（远程服务）；否则默认用常驻本地 ASR 服务（模型只加载一次，4 路并发）
    const useApi = !!(api && apiKey)
    let serverUrl: string | null = null
    let serverHandle: AsrServerHandle | null = null

    if (useApi) {
        console.log(`[方式] API 服务: ${api}`)
    } else {
        try {
            serverHandle = await ensureAsrServer({ model: modelPath })
            serverUrl = serverHandle.url
            console.log(`[方式] 本地 ASR 服务 ${serverUrl}（${serverHandle.owned ? '本次拉起，结束自动关闭' : '复用已在运行的服务'}）`)
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e)
            if (!checkMlxAudio()) {
                return {
                    success: false,
                    files: [],
                    total: 0,
                    successCount: 0,
                    failCount: 0,
                    error: `本地 ASR 服务不可用（${reason}），且 mlx-audio 未安装无法回退。请运行: pip install mlx-audio，或用 --api 指定远程服务`,
                }
            }
            console.log(`[方式] 本地 ASR 服务不可用（${reason}），回退为逐文件本地转录`)
        }
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    const results: Array<{ input: string; output: string; text?: string; error?: string }> = []
    let successCount = 0
    let failCount = 0

    try {
        for (let i = 0; i < audioFiles.length; i++) {
            const filePath = audioFiles[i]
            const filename = filePath.split('/').pop() || `audio_${i}`
            const baseName = filename.replace(/\.[^.]+$/, '')
            const fileOutputPath = join(outputPath, baseName)

            console.log(`\n[${i + 1}/${audioFiles.length}] ${filename}`)

            // 视频容器先提取音轨（同目录 .m4a，已提取过则复用）
            const track = ensureAudioTrack(filePath)
            if (track.error) {
                console.log(`  失败: ${track.error}`)
                results.push({ input: filePath, output: fileOutputPath, error: track.error })
                failCount++
                continue
            }
            const asrPath = track.audioPath

            // 检查是否已转录
            const existingFile = `${fileOutputPath}.${outputFormat}`
            if (existsSync(existingFile)) {
                // 已有原始转录；若开了润色但 .polished.md 缺失（上次中断），补润色
                if (willPolish) {
                    const polishedFile = `${fileOutputPath}.polished.md`
                    if (!existsSync(polishedFile)) {
                        const rawText = readFileSync(existingFile, 'utf-8').trim()
                        if (rawText) {
                            console.log(`  [润色] 补录（上次未完成润色）`)
                            let polished: string | null = null
                            for (let attempt = 1; attempt <= 2 && polished === null; attempt++) {
                                try {
                                    polished = await polishText(rawText, llmConfig!, {
                                        onToken: (token) => process.stdout.write(token),
                                    })
                                } catch (err) {
                                    if (attempt < 2) {
                                        console.log(`\n  [润色] 补录第 ${attempt} 次失败（${err instanceof Error ? err.message : err}），10s 后重试...`)
                                        await new Promise(r => setTimeout(r, 10000))
                                    }
                                }
                            }
                            if (polished !== null) {
                                console.log('\n')
                                writeFileSync(polishedFile, polished + '\n', 'utf-8')
                                console.log(`  [润色] 完成 → ${polishedFile}`)
                            } else {
                                console.log('\n  [润色] 补录失败')
                            }
                        }
                    }
                }
                console.log(`  跳过（已存在）`)
                results.push({ input: filePath, output: existingFile })
                successCount++
                continue
            }

            let result: { success: boolean; text?: string; error?: string; unreachable?: boolean }

            if (useApi) {
                result = await transcribeWithApi(asrPath, api!, apiKey!, lang)
                if (result.success && result.text !== undefined) {
                    writeFileSync(existingFile, result.text + '\n', 'utf-8')
                }
            } else if (serverUrl) {
                // 常驻服务模式：失联（服务被其属主关闭/崩溃）→ 重启接管并重跑本文件
                for (let attempt = 1; ; attempt++) {
                    result = await transcribeWithApi(asrPath, serverUrl, 'local', lang)
                    if (result.success || !result.unreachable || attempt >= 2) break
                    console.log(`  [服务] ASR 服务失联（${result.error}），重启后重试...`)
                    serverHandle = await ensureAsrServer({ model: modelPath })
                    serverUrl = serverHandle.url
                }
                if (result.success && result.text !== undefined) {
                    writeFileSync(existingFile, result.text + '\n', 'utf-8')
                }
            } else {
                result = transcribeWithMlxAudio(asrPath, fileOutputPath, modelPath, lang, outputFormat)
            }

            if (result.success) {
                console.log(`  转录完成`)
                let finalTextFile = existingFile

                // 后续步骤：用 LLM 润色，提升可读性
                if (willPolish) {
                    const polishedFile = `${fileOutputPath}.polished.md`
                    if (existsSync(polishedFile)) {
                        console.log(`  [润色] 跳过（已存在）`)
                        finalTextFile = polishedFile
                    } else {
                        const rawText = readFileSync(existingFile, 'utf-8').trim()
                        if (!rawText) {
                            console.log(`  [润色] 跳过（转录文本为空）`)
                        } else {
                            console.log(`  [润色] 正在用 LLM 处理文本...\n`)
                            // 瞬时故障（代理抖动、SSE 断流）自动重试
                            const POLISH_RETRIES = 2
                            let polished: string | null = null
                            let lastErr: unknown = null
                            for (let attempt = 1; attempt <= POLISH_RETRIES && polished === null; attempt++) {
                                try {
                                    polished = await polishText(rawText, llmConfig!, {
                                        onToken: (token) => process.stdout.write(token),
                                    })
                                } catch (err) {
                                    lastErr = err
                                    if (attempt < POLISH_RETRIES) {
                                        console.log(`\n  [润色] 第 ${attempt} 次失败（${err instanceof Error ? err.message : err}），${10 * attempt}s 后重试...`)
                                        await new Promise(r => setTimeout(r, 10000 * attempt))
                                    }
                                }
                            }
                            if (polished !== null) {
                                console.log('\n')
                                writeFileSync(polishedFile, polished + '\n', 'utf-8')
                                console.log(`  [润色] 完成 → ${polishedFile}`)
                                finalTextFile = polishedFile
                            } else {
                                console.log('\n')
                                console.log(`  [润色] 失败: ${lastErr instanceof Error ? lastErr.message : lastErr}`)
                                console.log(`  [润色] 保留原始转录文本`)
                            }
                        }
                    }
                }

                // 更新数据库中的转录文本（润色成功则存润色版，否则存原始转录）
                try {
                    const baseNameMatch = baseName.replace(/\.[^.]+$/, '')
                    const records = queryByTitle(baseNameMatch)
                    if (records.length > 0) {
                        const latestRecord = records[0]
                        const textContent = readFileSync(finalTextFile, 'utf-8').trim()
                        updateTranscript(latestRecord.id, textContent)
                        console.log(`  [记录] 已更新数据库 (ID: ${latestRecord.id})`)
                    }
                } catch {
                    // 数据库更新失败不影响转录结果
                }
                results.push({ input: filePath, output: existingFile, text: result.text })
                successCount++
            } else {
                console.log(`  失败: ${result.error}`)
                results.push({ input: filePath, output: fileOutputPath, error: result.error })
                failCount++
            }
        }
    } finally {
        // 谁启动谁负责关闭：无条件关闭（即便有其他程序还在用——它们会自行重启并重试）
        stopAsrServer(serverHandle)
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`转录完成: 成功 ${successCount}, 失败 ${failCount}`)
    console.log(`输出目录: ${outputPath}`)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    return {
        success: failCount === 0,
        files: results,
        total: audioFiles.length,
        successCount,
        failCount,
    }
}
