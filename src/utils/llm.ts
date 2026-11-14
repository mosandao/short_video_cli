import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface LlmConfig {
    apiKey: string
    model: string
    baseUrl: string
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-v4-flash'

/**
 * 解析 cli/.env 文件为键值对（简单实现，无需 dotenv 依赖）
 */
function parseEnvFile(envPath: string): Record<string, string> {
    const vars: Record<string, string> = {}
    if (!existsSync(envPath)) return vars

    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eqIdx = trimmed.indexOf('=')
        if (eqIdx === -1) continue
        const key = trimmed.slice(0, eqIdx).trim()
        let value = trimmed.slice(eqIdx + 1).trim()
        // 去掉成对引号
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1)
        }
        vars[key] = value
    }
    return vars
}

/**
 * 加载 LLM 配置：环境变量优先于 cli/.env
 */
export function loadLlmConfig(): LlmConfig {
    const envPath = join(__dirname, '..', '..', '.env')
    const env = parseEnvFile(envPath)

    const apiKey =
        process.env.GALAXY_LLM_API_KEY ||
        process.env.LLM_API_KEY ||
        env.api_key ||
        env.API_KEY ||
        ''

    const model =
        process.env.GALAXY_LLM_MODEL ||
        process.env.LLM_MODEL ||
        env.model ||
        env.MODEL ||
        DEFAULT_MODEL

    const baseUrl = (
        process.env.GALAXY_LLM_BASE_URL ||
        process.env.LLM_BASE_URL ||
        env.base_url ||
        env.BASE_URL ||
        DEFAULT_BASE_URL
    ).replace(/\/+$/, '')

    return { apiKey, model, baseUrl }
}

/**
 * 润色转录文本用的系统提示词
 */
const POLISH_SYSTEM_PROMPT = `你是一位资深中文文字编辑，专门将 Whisper 语音识别的口语转录稿整理为通顺、易读的书面文章。

## 工作流程

拿到转录稿后，先在脑中完成以下分析（不要输出分析过程），再动手整理：

1. 判断文本类型：知识科普 / 教程教学 / 观点评论 / 故事叙述 / 访谈对话 / 其他
2. 识别说话人的核心观点和逻辑脉络
3. 标记所有需要核实的疑似识别错误
4. 规划合理的段落结构

## 整理规则

### 纠错（优先级最高）
- 修正同音/近音错别字。常见高频错误必须纠正：
  的/地/得混用、在/再、做/作、即/既、哪/那、吗/嘛/么、他/她/它
- 修正语音识别特有的错误模式：
  - 数字串误识别（如"一千二"被识别为"1200"以外的奇怪形式）
  - 英文单词/缩写被音译成中文（如"API"→"诶批爱"，应还原）
  - 断裂的句子（Whisper 幻觉导致的重复片段，直接删除）
- 人名、地名、品牌名、专业术语若明显错误，根据上下文推断修正；若无法确定，保留原文

### 标点
- 根据语气和停顿补全标点：。，？！、：；""''《》（）
- 长句（超过 40 字无标点）务必断句
- 并列项用顿号或逗号分隔，层次用分号

### 分段
- 按话题转换自然分段，每段 3-8 句为宜
- 段落之间用空行分隔
- 若原文有明显的"第一/第二"、"首先/其次/最后"等结构，保留并用换行突出层次
- 对话类内容：说话人切换时换行，用"——"或换行区分不同发言人

### 删除
- 毫不犹豫地删除：纯填充词（嗯、啊、呃、嘛）、无意义重复（同一句话说了两遍且无强调意图）、识别失败产生的乱码片段
- 谨慎保留：表达犹豫/思考的"就是…"、"怎么说呢…"（它们传达说话人的真实状态）、刻意重复以强调的语句、笑声/叹气等情绪标记（转为"（笑）""（叹气）"）

### 忠于原文（不可逾越的底线）
- 不添加原文没有的事实、观点、数据、案例
- 不删除原文中的任何实质性信息
- 不改变说话人的立场和态度
- 不做总结、点评、补充或延伸
- 不纠正说话人的事实性错误（除非是明显的识别错误）

### 格式
- 使用 Markdown 格式输出，通过层级结构提升长文可读性
- 话题转换处用 \`## \` 或 \`### \` 标题（不要用 \`# \` 一级标题）
- 并列观点/枚举用 \`- \` 无序列表
- 步骤/顺序内容用 \`1. \` 有序列表
- 关键术语/核心概念首次出现用 **粗体** 强调（每段不超过 3 处）
- 书名/作品名用《》
- 原文没有的层级结构不要强行施加；短内容不需列表就不要列
- 如果原文提到网址、代码、公式，保持原样
- 数字和日期格式统一：中文数字用于口语化表达（"一万"），阿拉伯数字用于精确数值（"1024"）、百分比（"35%"）、日期（"2024年"）

## 输出

直接输出整理后的 Markdown 正文，不要加任何前言、后记、说明或标注。`

export interface PolishOptions {
    /** 每收到一个 token 时的回调（用于流式打印进度） */
    onToken?: (token: string) => void
}

/**
 * 用 LLM 润色转录文本，提升可读性（流式输出）
 */
export async function polishText(
    rawText: string,
    config: LlmConfig,
    options: PolishOptions = {},
): Promise<string> {
    if (!config.apiKey) {
        throw new Error('LLM api_key 未配置。请在项目根 .env 设置 api_key，或设置环境变量 GALAXY_LLM_API_KEY')
    }

    // 429 速率限制退避重试（批量场景持续请求会触发按分钟频控）
    let response!: Response
    const MAX_ATTEMPTS = 4
    for (let attempt = 1; ; attempt++) {
        response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
            model: config.model,
            messages: [
                { role: 'system', content: POLISH_SYSTEM_PROMPT },
                { role: 'user', content: rawText },
            ],
            stream: true,
            temperature: 0.3,
            thinking: { type: 'enabled' },
            reasoning_effort: 'high',
        }),
        // 整体超时兜底：流式连接经代理时可能无限僵死（实测挂在 fake-ip 代理上），
        // 长转录稿润色 10 分钟足够
        signal: AbortSignal.timeout(600_000),
    })
        if (response.status !== 429 || attempt >= MAX_ATTEMPTS) break
        const waitMs = 15000 * attempt // 15s / 30s / 45s 递增退避
        console.log(`[润色] 429 限流，等待 ${waitMs / 1000}s 后重试 (${attempt}/${MAX_ATTEMPTS - 1})`)
        await new Promise(r => setTimeout(r, waitMs))
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        throw new Error(`LLM 请求失败: ${response.status} ${response.statusText} - ${errorText}`)
    }

    return parseStream(response, options.onToken)
}

/**
 * 解析 OpenAI 兼容的 SSE 流，累积返回完整文本
 */
async function parseStream(
    response: Response,
    onToken?: (token: string) => void,
): Promise<string> {
    const body = response.body
    if (!body) {
        // 服务端未走流式时的兜底
        const data = (await response.json()) as any
        return data.choices?.[0]?.message?.content ?? ''
    }

    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''

    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (payload === '[DONE]' || payload === '') continue
            try {
                const json = JSON.parse(payload) as any
                const delta: string = json.choices?.[0]?.delta?.content ?? ''
                if (delta) {
                    fullText += delta
                    onToken?.(delta)
                }
            } catch {
                // 忽略无法解析的行（如心跳注释）
            }
        }
    }

    return fullText.trim()
}
