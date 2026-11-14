import type { CanonicalPlatform } from './types.js'

const PLATFORM_ALIASES: Record<string, CanonicalPlatform> = {
    bili: 'bilibili',
    bilibili: 'bilibili',
    bilibili_tv: 'bilibili_tv',
    douyin: 'douyin',
    youtube: 'youtube',
    telegram: 'telegram',
    threads: 'threads',
    wechat: 'wechat',
    niconico: 'niconico',
    nico: 'niconico',
    weibo: 'weibo',
    xiaohongshu: 'xiaohongshu',
    tiktok: 'tiktok',
    instagram: 'instagram',
    ins: 'instagram',
    x: 'x',
    twitter: 'x',
    unknown: 'unknown',
}

const AUDIO_EXTRACTION_PLATFORMS = new Set<CanonicalPlatform>([
    'douyin',
    'threads',
    'weibo',
    'xiaohongshu',
    'tiktok',
    'instagram',
    'x',
])

export function normalizePlatform(platform?: string | null): CanonicalPlatform {
    if (!platform) {
        return 'unknown'
    }

    const key = platform.trim().toLowerCase()
    if (PLATFORM_ALIASES[key]) {
        return PLATFORM_ALIASES[key]
    }
    // 模糊兜底：BilibiliSpaceVideo / DouyinIE 等 extractor 复合名
    for (const [alias, canonical] of Object.entries(PLATFORM_ALIASES)) {
        if (alias !== 'unknown' && alias !== 'x' && key.includes(alias)) {
            return canonical
        }
    }
    return 'unknown'
}

export function supportsAudioExtraction(platform: string | null | undefined): boolean {
    return AUDIO_EXTRACTION_PLATFORMS.has(normalizePlatform(platform))
}

export function getPlatformDisplayName(platform: CanonicalPlatform): string {
    const names: Record<CanonicalPlatform, string> = {
        bilibili: 'Bilibili',
        bilibili_tv: 'Bilibili TV',
        douyin: '抖音',
        youtube: 'YouTube',
        telegram: 'Telegram',
        threads: 'Threads',
        wechat: '微信',
        niconico: 'Niconico',
        weibo: '微博',
        xiaohongshu: '小红书',
        tiktok: 'TikTok',
        instagram: 'Instagram',
        x: 'X/Twitter',
        unknown: '未知平台',
    }
    return names[platform]
}