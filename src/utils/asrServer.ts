import { spawn, type ChildProcess } from 'child_process'
import { join, dirname } from 'path'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 本地常驻 ASR 服务地址（可用 GALAXY_ASR_API 覆盖） */
export const DEFAULT_ASR_API = process.env.GALAXY_ASR_API || 'http://127.0.0.1:8300'

export interface AsrServerHandle {
    url: string
    /** 是否由本进程拉起（是 → 任务结束后负责关闭） */
    owned: boolean
    child: ChildProcess | null
}

/** 探活：ASR 服务是否在运行 */
export async function asrServerAlive(url: string, timeoutMs = 1500): Promise<boolean> {
    try {
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), timeoutMs)
        const res = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: ac.signal })
        clearTimeout(timer)
        return res.ok
    } catch {
        return false
    }
}

/**
 * 确保 ASR 服务可用（谁启动谁负责关闭）:
 * - 已在运行 → 直接用（owned: false，不负责关闭）
 * - 没在运行 → 拉起（owned: true）；若拉起瞬间被并发程序抢先占端口 → 认输，改用对方的
 */
export async function ensureAsrServer(opts: {
    apiUrl?: string
    model: string
    workers?: number
    startupTimeoutMs?: number
}): Promise<AsrServerHandle> {
    const url = (opts.apiUrl || DEFAULT_ASR_API).replace(/\/$/, '')
    if (await asrServerAlive(url)) {
        return { url, owned: false, child: null }
    }

    const script = join(__dirname, '..', '..', 'scripts', 'asr_server.py')
    if (!existsSync(script)) {
        throw new Error(`ASR 服务脚本不存在: ${script}`)
    }

    const port = new URL(url).port || '8300'
    const child = spawn('python3', [
        script,
        '--model', opts.model,
        '--port', port,
        '--workers', String(opts.workers ?? 4),
    ], {
        detached: true, // 独立进程组：负 pid 一键回收 supervisor + 全部 worker
        stdio: 'ignore',
        env: { ...process.env },
    })
    child.unref()

    const deadline = Date.now() + (opts.startupTimeoutMs ?? 90_000) // 4 worker 并行加载模型的余量
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500))
        if (await asrServerAlive(url)) {
            // 端口活了：我的进程还健在 → 我是属主；已退出 → 并发抢跑输了，用对方的
            return child.exitCode === null
                ? { url, owned: true, child }
                : { url, owned: false, child: null }
        }
        if (child.exitCode !== null) {
            // 我的进程退了且端口没活：真失败；再探一次防止退出与探活之间的窗口漏判
            if (await asrServerAlive(url)) {
                return { url, owned: false, child: null }
            }
            throw new Error(`ASR 服务启动失败 (exit ${child.exitCode})，检查 python3 / mlx-audio / fastapi`)
        }
    }
    throw new Error('ASR 服务启动超时（模型加载过慢？）')
}

/**
 * 关闭自己拉起的 ASR 服务 —— 无条件整组强杀，不等其他使用方。
 * 正在使用的程序会探测到失联，自行重启服务并重试任务。
 */
export function stopAsrServer(handle: AsrServerHandle | null | undefined): void {
    if (!handle?.owned || !handle.child?.pid) return
    try {
        process.kill(-handle.child.pid, 'SIGKILL') // 负 pid = 整个进程组
    } catch {
        // 已退出
    }
}
