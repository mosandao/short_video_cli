/**
 * captions 命令：仅下载字幕（引擎 captions 操作，skip_download）
 */

import { fetchCaptions } from '../engine/driver.js'

export interface CaptionsOptions {
    url: string
    output: string
    /** 语言列表，如 zh,en（默认 zh） */
    languages?: string
    /** 包含自动生成字幕（默认 true） */
    auto?: boolean
    json?: boolean
}

export interface CaptionsResult {
    success: boolean
    tracks?: Array<{ language: string; file: string }>
    error?: string
}

export async function captionsCommand(options: CaptionsOptions): Promise<CaptionsResult> {
    const languages = (options.languages || 'zh')
        .split(',')
        .map(l => l.trim())
        .filter(Boolean)

    try {
        const result = await fetchCaptions(options.url, options.output, languages, options.auto !== false)
        if (!options.json) {
            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
            if (result.tracks.length === 0) {
                console.log('未获取到字幕（该内容可能没有对应语言的字幕）')
            } else {
                console.log('字幕下载完成:')
                result.tracks.forEach(t => console.log(`  [${t.language}] ${t.file}`))
            }
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
        }
        return { success: true, tracks: result.tracks }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!options.json) console.error(`\n[错误] ${message}\n`)
        return { success: false, error: message }
    }
}
