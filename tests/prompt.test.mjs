// Prompt and copy-format contract: the model must always be asked for the five
// sections, and the copied text must keep the user's words separate from the
// AI supplement.

import test from 'node:test'
import assert from 'node:assert/strict'

import { SECTIONS, SYSTEM_PROMPT, DEFAULT_ALIGN_PROMPT, REFINE_TOOL, buildUserPrompt, composePlanPrompt, composeSessionRefinePrompt, missingSections, composeNodeText } from '../src/prompt.js'

test('the five sections are fixed and ordered', () => {
  assert.deepEqual(SECTIONS, ['背景', '边界', '影响面', '成本', '预期效果'])
})

test('the system prompt forbids executing work and rewriting the user text', () => {
  assert.match(SYSTEM_PROMPT, /绝不执行任何实际工作/)
  assert.match(SYSTEM_PROMPT, /绝不改写/)
  for (const section of SECTIONS) assert.ok(SYSTEM_PROMPT.includes(`## ${section}`), `prompt names ${section}`)
})

test('the user message carries the note, the workspace and an optional hint', () => {
  const prompt = buildUserPrompt({
    title: '接入日志',
    body: '把审计日志接到集中存储。',
    workspacePath: 'D:\\work',
    workspaceTitle: 'work',
  }, '重点看成本')
  assert.match(prompt, /标题：接入日志/)
  assert.match(prompt, /把审计日志接到集中存储。/)
  assert.match(prompt, /work D:\\work/)
  assert.match(prompt, /这次补充的额外要求：重点看成本/)
})

test('an unbound note says so instead of inventing a workspace', () => {
  const prompt = buildUserPrompt({ title: 'x', body: '' }, '')
  assert.match(prompt, /（未绑定）/)
  assert.match(prompt, /（用户还没有写正文）/)
  assert.doesNotMatch(prompt, /额外要求/)
})

test('missing section detection matches headings only', () => {
  const full = SECTIONS.map((section) => `## ${section}\n- 一条`).join('\n')
  assert.deepEqual(missingSections(full), [])
  assert.deepEqual(missingSections('## 背景\n- 只写了背景'), ['边界', '影响面', '成本', '预期效果'])
  assert.deepEqual(missingSections('背景 这两个字出现在正文里'), SECTIONS)
})

test('the copied text keeps the user text before the AI supplement', () => {
  const text = composeNodeText({
    title: '接入日志',
    body: '我自己的想法',
    workspacePath: 'D:\\work',
    workspaceTitle: 'work',
    refine: { content: '## 背景\n- 补充' },
  })
  assert.match(text, /^# 接入日志/)
  assert.match(text, /> 工作区：work — D:\\work/)
  assert.ok(text.indexOf('我自己的想法') < text.indexOf('## 背景'), 'user text comes first')
  assert.match(text, /## 我的内容/)
  assert.match(text, /## AI 完善/)
})

test('copying a note that was never refined has no empty AI block', () => {
  const text = composeNodeText({ title: 'x', body: 'y', refine: { content: '   ' } })
  assert.doesNotMatch(text, /## AI 完善/)
})

test('the workspace-jump prompt leads with the preset line and keeps both halves', () => {
  const text = composePlanPrompt({
    title: '接入审计日志',
    body: '我自己的原文',
    refine: { content: '## 背景\n- 补充' },
  })
  assert.ok(text.startsWith(`${DEFAULT_ALIGN_PROMPT}\n\n`), 'the preset line leads')
  assert.match(text, /# 接入审计日志/)
  assert.match(text, /## 我的内容\n\n我自己的原文/)
  assert.match(text, /## AI 完善\n\n## 背景/)
  assert.ok(text.indexOf('我自己的原文') < text.indexOf('## AI 完善'), 'the user text stays first')
})

test('a configured preset replaces the default, and an empty one falls back', () => {
  const node = { title: 'x', body: 'y' }
  assert.ok(composePlanPrompt(node, '先看影响面').startsWith('先看影响面\n\n'))
  assert.ok(composePlanPrompt(node, '   ').startsWith(DEFAULT_ALIGN_PROMPT))
  assert.doesNotMatch(composePlanPrompt({ title: 'x', body: '' }), /## AI 完善/)
})

test('the session-refine prompt names the note and the write-back tool', () => {
  const text = composeSessionRefinePrompt({
    id: 'node-42',
    title: '接入审计日志',
    body: '我自己的原文',
  }, '先和我对齐')
  assert.ok(text.startsWith('先和我对齐\n\n'))
  assert.match(text, /便签 id：node-42/)
  assert.match(text, /我自己的原文/)
  assert.match(text, new RegExp(REFINE_TOOL))
  assert.match(text, /- id 传 node-42/)
  for (const section of SECTIONS) assert.match(text, new RegExp(`## ${section}`))
  assert.match(text, /不要运行命令/)
  assert.match(text, /不要改任何文件/)
})

test('the system prompt tells the model it has no tools at all', () => {
  assert.match(SYSTEM_PROMPT, /没有可调用的工具/)
  assert.match(SYSTEM_PROMPT, /DSML/)
  assert.match(SYSTEM_PROMPT, /缺任何一节都算没做完/)
})
