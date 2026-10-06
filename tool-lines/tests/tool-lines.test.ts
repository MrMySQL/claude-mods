import { expect, test } from 'claude-code/testing'

// MARK: Fixtures

const BASH_ROW = {
  tool_use_id: 'toolu_1',
  tool: 'Bash',
  input: { command: 'cd /Users/arya/repo && grep -rn "needle" packages' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: { stdout: 'a\nb\nc', stderr: 'Shell cwd was reset to /Users/arya/repo', interrupted: false },
}

// Nested Text children read as one line, the way the terminal paints them.
function shown(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null) return ''
  const children = (node as { children?: unknown[] }).children ?? []
  return children.map(shown).join('')
}

// The outermost Text holding the summary, apart from the dot's column.
async function lineOf(ui: { find: (query: { type: string; text: RegExp }) => Promise<unknown> }): Promise<string> {
  return shown(await ui.find({ type: 'Text', text: /tool_call|\(/ }))
}

// MARK: ToolUse

test('draws a tool call as one compact line with its meta', async $ => {
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolUse',
    props: BASH_ROW,
    viewport: { columns: 200, rows: 50 },
  })
  expect(await lineOf(ui)).toBe(
    'tool_call: Bash(cd /Users/arya/repo && grep -rn "needle" packages) - shell cwd was reset',
  )
})

test('cuts only the input so the line fits a wide terminal', async $ => {
  const long = { ...BASH_ROW, input: { command: 'echo ' + 'x'.repeat(400) } }
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolUse',
    props: long,
    viewport: { columns: 150, rows: 50 },
  })
  const line = await lineOf(ui)
  expect(line.length).toBe(150 - 4 - 2)
  expect(line).toMatch(/…\) - shell cwd was reset$/)
})

test('lets a narrow terminal wrap to a few rows', async $ => {
  const long = { ...BASH_ROW, input: { command: 'echo ' + 'x'.repeat(400) } }
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolUse',
    props: long,
    viewport: { columns: 60, rows: 40 },
  })
  expect((await lineOf(ui)).length).toBe(120)
})

test('colors the dot yellow while running, green when done, red when errored', async $ => {
  const dotColor = async (props: typeof BASH_ROW) => {
    const ui = await $.ui.mount({
      plugin: 'tool-lines',
      surface: 'terminal',
      component: 'ToolUse',
      props,
      viewport: { columns: 200, rows: 50 },
    })
    return (await ui.find({ type: 'Text', text: '●' }))?.props.color
  }
  expect(await dotColor({ ...BASH_ROW, isRunning: true })).toBe('warning')
  // Written by the model but not started yet: no result, not flagged running.
  expect(await dotColor({ ...BASH_ROW, output: undefined } as never)).toBe('warning')
  expect(await dotColor(BASH_ROW)).toBe('success')
  expect(await dotColor({ ...BASH_ROW, isErrored: true })).toBe('error')
})

test('leaves running to the dot and marks errored calls', async $ => {
  const running = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolUse',
    props: { ...BASH_ROW, isRunning: true, output: undefined },
    viewport: { columns: 200, rows: 50 },
  })
  expect(await lineOf(running)).toBe('tool_call: Bash(cd /Users/arya/repo && grep -rn "needle" packages)')

  const failed = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolUse',
    props: { ...BASH_ROW, isErrored: true, output: 'Exit code 1' },
    viewport: { columns: 200, rows: 50 },
  })
  expect(await lineOf(failed)).toMatch(/\) - error$/)
})

test('names a file tool by its path', async $ => {
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolUse',
    props: {
      ...BASH_ROW,
      tool: 'Read',
      input: { file_path: '/Users/arya/notes.md', limit: 20 },
      output: { type: 'text' },
    },
    viewport: { columns: 200, rows: 50 },
  })
  expect(await lineOf(ui)).toBe('tool_call: Read(/Users/arya/notes.md)')
})

// MARK: UserMessage

test('pads below the prompt so the tool block starts apart from it', async ($, on) => {
  // Stands for what the engine draws at any site the mod passes on.
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text: 'find the costs', origin: { kind: 'composer' }, isExpanded: false },
    viewport: { columns: 200, rows: 50 },
  } as never)
  const root = (await ui.drawn()) as { type: string; props?: { marginBottom?: number } }
  expect(root.type).toBe('Box')
  expect(root.props?.marginBottom).toBe(1)
  expect(shown(root)).toBe('engine')
})

// MARK: Expanded view

test('leaves tool rows to the engine while ctrl+o is open', async ($, on) => {
  // Stands for what the engine draws at any site the mod passes on.
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  const mountOn = (component: 'UserMessage' | 'ToolUse' | 'ToolResult', props: object) =>
    $.ui.mount({ plugin: 'tool-lines', surface: 'terminal', component, props, viewport: { columns: 200, rows: 50 } } as never)
  const prompt = { text: 'find the costs', origin: { kind: 'composer' } }

  await mountOn('UserMessage', { ...prompt, isExpanded: true })
  expect(shown(await (await mountOn('ToolUse', BASH_ROW)).drawn())).toBe('engine')
  const result = { tool_use_id: 'toolu_1', tool: 'Bash', output: BASH_ROW.output, isErrored: false }
  expect(shown(await (await mountOn('ToolResult', result)).drawn())).toBe('engine')

  await mountOn('UserMessage', { ...prompt, isExpanded: false })
  expect(shown(await (await mountOn('ToolUse', BASH_ROW)).drawn())).toMatch(/^●tool_call: Bash/)
})

// MARK: ToolGroup

test('unfolds a group of reads and searches into one row per call', async ($, on) => {
  let isExpanded: boolean | undefined
  // Stands in for the engine beneath the mod, recording what it was asked to draw.
  on('ui.render', { component: 'ToolGroup' }, async ($, e) => {
    isExpanded = e.props.isExpanded
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['engine'] })
  })
  await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolGroup',
    props: {
      calls: [{ tool: 'Read', input: { file_path: '/a.md' }, isRunning: false, isErrored: false, isInterrupted: false }],
      isActive: false,
      isExpanded: false,
    },
    viewport: { columns: 200, rows: 50 },
  })
  expect(isExpanded).toBe(true)
})

// MARK: ToolResult

test('hides the result block', async $ => {
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 'toolu_1', tool: 'Bash', output: BASH_ROW.output, isErrored: false },
    viewport: { columns: 200, rows: 50 },
  })
  expect(shown(await ui.drawn())).toBe('')
})
