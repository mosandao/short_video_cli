/**
 * 共享类型定义
 */

export type CanonicalPlatform =
    | 'bilibili'
    | 'bilibili_tv'
    | 'douyin'
    | 'youtube'
    | 'telegram'
    | 'threads'
    | 'wechat'
    | 'niconico'
    | 'weibo'
    | 'xiaohongshu'
    | 'tiktok'
    | 'instagram'
    | 'x'
    | 'unknown'

export interface CommandResult {
    success: boolean
    error?: string
    [key: string]: unknown
}

/** 多P视频的单个分P信息 */
export interface PageInfo {
    page: number
    cid: string
    part: string
    duration: number
    downloadVideoUrl: string | null
    downloadAudioUrl: string | null
    /** 发布时间（Unix 秒，抖音主页拦截 /aweme/post 的 create_time） */
    createTime?: number
}

/**
 * 统一媒体信息（--browser 模式解析结果；engine 模式结果见 engine/types.ts）
 */
export interface MediaInfo {
    title: string
    desc?: string
    cover?: string | null
    platform: string
    author?: string
    publishedAt?: string
    url: string
    duration?: number
    noteType?: 'video' | 'image' | 'audio'
    downloadVideoUrl?: string | null
    downloadAudioUrl?: string | null
    originDownloadVideoUrl?: string | null
    originDownloadAudioUrl?: string | null
    mediaActions?: { video: string; audio: string }
    isMultiPart?: boolean
    pages?: PageInfo[]
    images?: string[]
    videos?: Array<{
        id: string
        title: string
        cover?: string | null
        duration?: number
        downloadVideoUrl?: string | null
        originDownloadVideoUrl?: string | null
    }>
}

export interface ParserResult {
    success: boolean
    data?: MediaInfo
    error?: string
    code?: string
}
