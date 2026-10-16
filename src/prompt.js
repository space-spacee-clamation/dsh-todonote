// Shared shape of one "AI 完善" result. Imported by the Host half and inlined
// into the browser bundle by tools/build.mjs, so the console copies exactly
// what the Host asked the model to produce. No imports here, by design.

/** The five required sections, in order. */
export const SECTIONS = ['背景', '边界', '影响面', '成本', '预期效果']

/**
 * System prompt for one enrichment call. The call carries no tools and no
 * session context, so "只调查补充，不实行" is enforced by construction: the
 * model has no way to execute anything, and the prompt only asks for analysis.
 */
export const SYSTEM_PROMPT = `你是「计划便签」的完善助手。用户会把一张自己写的便签交给你：一个标题，加上用户自己写的正文，可能还绑定了一个工作区路径。

你的唯一任务是**把用户的想法补充完整，帮他想清楚**，而不是替他把事情做掉。

必须遵守：
1. 只做调查、分析和补充。绝不执行任何实际工作：不写代码、不改文件、不跑命令、不安装依赖、不给出"我已经完成"之类的表述。
2. **你没有可调用的工具**：不要输出任何工具调用语法（例如 DSML、<tool_call>、<invoke>、<function_calls> 这类标记），也不要试图列出目录、读取文件或运行命令。需要了解的现状，写成"待确认"。
3. 绝不改写、删减、替换或"优化"用户的原文。你的输出是独立的补充内容，用户原文保持原样。
4. 不确定的地方不要编造，写成"待确认"并给出需要向谁/在哪里确认。
5. 回答必须完整包含下面五节；缺任何一节都算没做完。

输出格式：Markdown，严格使用下面五个二级标题，顺序固定，一个都不能少，也不要增加其它同级标题：

## 背景
## 边界
## 影响面
## 成本
## 预期效果

各节要求：
- 背景：这个想法从哪里来、要解决什么问题、现状与已知约束、需要先弄清的事实。
- 边界：做什么、明确不做什么；输入与输出；非目标；前置依赖。
- 影响面：会牵动哪些文件/模块/流程/角色；兼容性、数据、权限、协作上的影响；风险点。
- 成本：人力、时间、复杂度、维护成本的量级估计；需要的前置投入；最大的不确定项。
- 预期效果：做完之后可观察、可验证的结果；验收标准；怎么度量。

写法要求：
- 每节 3-6 条要点，用无序列表；短句、具体、不写空话。
- 只写与这张便签直接相关的内容；信息不足时，在对应小节里列出"待确认"问题。
- 不要复述用户原文，不要写开场白、总结、客套话或与这五节无关的内容。
- 全文使用简体中文。`

/**
 * Build the single user message for one enrichment call.
 * @param node - the stored node (`title`, `body`, workspace fields).
 * @param hint - optional extra instruction typed by the user for this run.
 * @returns the complete user message text.
 */
export function buildUserPrompt(node, hint) {
  const lines = [
    '# 便签',
    `标题：${node.title || '（未命名）'}`,
    '',
    '用户原文（原样保留，不要改写）：',
    '---',
    node.body && node.body.trim().length > 0 ? node.body : '（用户还没有写正文）',
    '---',
    '',
    `绑定工作区：${node.workspacePath ? `${node.workspaceTitle || ''} ${node.workspacePath}`.trim() : '（未绑定）'}`,
  ]
  const extra = typeof hint === 'string' ? hint.trim() : ''
  if (extra.length > 0) {
    lines.push('', `这次补充的额外要求：${extra}`)
  }
  return lines.join('\n')
}

/**
 * Report which required sections a model answer is missing.
 * @param text - the raw model answer.
 * @returns the missing section titles, in declaration order.
 */
export function missingSections(text) {
  const value = typeof text === 'string' ? text : ''
  return SECTIONS.filter((section) => !new RegExp(`^#{1,6}\\s*${section}\\s*$`, 'm').test(value))
}

/**
 * Preset line put in front of a plan when the console hands it to a new session
 * in its workspace. Overridable from the console's settings.
 */
export const DEFAULT_ALIGN_PROMPT = '和我对齐下面的计划，进行基础的调研和理解，不要改代码'

/**
 * The tool a workspace session calls to write its five-section answer back into
 * the note. Shared so the host registration and the prompt cannot drift.
 */
export const REFINE_TOOL = 'todonote_write_refinement'

/**
 * Compose the instruction a "去工作区完善" jump pre-fills: the session opens in
 * the note's own workspace, investigates there, and calls {@link REFINE_TOOL}
 * to write the answer back. The human sends it and can watch the work.
 * @param node - the stored node.
 * @param preset - the configured preset line; empty falls back to the default.
 * @returns the composer text.
 */
export function composeSessionRefinePrompt(node, preset) {
  const head = typeof preset === 'string' && preset.trim().length > 0 ? preset.trim() : DEFAULT_ALIGN_PROMPT
  const parts = [
    head,
    '',
    `便签 id：${node.id}`,
    `标题：${node.title || '（未命名）'}`,
    '',
    '我的内容：',
    '---',
    node.body && node.body.trim().length > 0 ? node.body : '（还没有写正文）',
    '---',
    '',
    '请**只读地**看一眼这个工作区（目录结构、相关文件）来补充事实：不要运行命令、不要改任何文件、不要提交改动；',
    '环境不给看或者不需要看，就直接根据便签内容写。',
    '',
    `然后调用一次工具 ${REFINE_TOOL} 把补充写回上面这张便签：`,
    '',
    `- id 传 ${node.id}`,
    '- markdown 传完整五节：## 背景 / ## 边界 / ## 影响面 / ## 成本 / ## 预期效果',
    '',
    '只做调研和补充，不写代码。',
  ]
  return parts.join('\n')
}

/**
 * Compose the text a "去工作区对齐" jump pre-fills into the new session's
 * composer: the preset line first, then the note exactly as the user wrote it,
 * then the AI supplement when one exists. The plugin only fills the box — the
 * user presses send.
 * @param node - the stored node.
 * @param preset - the configured preset line; empty falls back to the default.
 * @returns the composer text.
 */
export function composePlanPrompt(node, preset) {
  const head = typeof preset === 'string' && preset.trim().length > 0 ? preset.trim() : DEFAULT_ALIGN_PROMPT
  const parts = [head, '', `# ${node.title || '（未命名）'}`, '']
  parts.push('## 我的内容', '', node.body && node.body.trim().length > 0 ? node.body : '（空）')
  const refine = node.refine || {}
  if (typeof refine.content === 'string' && refine.content.trim().length > 0) {
    parts.push('', '## AI 完善', '', refine.content)
  }
  return parts.join('\n')
}

/**
 * Compose the text the user copies: their own words first, the AI supplement
 * second, never merged.
 * @param node - the stored node.
 * @returns Markdown text for the clipboard.
 */
export function composeNodeText(node) {
  const parts = [`# ${node.title || '（未命名）'}`]
  if (node.workspacePath) {
    parts.push(`> 工作区：${node.workspaceTitle ? `${node.workspaceTitle} — ` : ''}${node.workspacePath}`)
  }
  parts.push('', '## 我的内容', '', node.body && node.body.trim().length > 0 ? node.body : '（空）')
  const refine = node.refine || {}
  if (typeof refine.content === 'string' && refine.content.trim().length > 0) {
    parts.push('', '## AI 完善', '', refine.content)
  }
  return parts.join('\n')
}
