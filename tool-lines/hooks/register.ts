import type { Register } from 'claude-code'

// MARK: Layout

// Wide terminals fit the whole line on one row; narrow ones may wrap, up to MAX_ROWS.
const MIN_CHARS = 120
const MAX_ROWS = 3
// A long argument (a whole script or prompt) buries the tool name, so the subject stops here, ellipsis included.
const MAX_SUBJECT_CHARS = 35
// The engine indents transcript rows, so a line sized to the full width would spill onto a second row.
const GUTTER = 4
// The viewport is absent until the terminal has been measured.
const FALLBACK_COLUMNS = 120

// MARK: Row facts

type ToolRow = {
  tool: string
  input: unknown
  output?: unknown
  isRunning: boolean
  isErrored: boolean
  isInterrupted: boolean
}

// Input fields that name what a call acts on, most telling first; add a key here to cover a new tool.
const SUBJECT_KEYS = [
  'command',
  'file_path',
  'notebook_path',
  'pattern',
  'url',
  'query',
  'skill',
  'description',
  'path',
  'action',
  'prompt',
]

// This extracts the main argument of a tool call. Tools with no known key fall back to their raw
// JSON so the line is never blank, and whitespace is collapsed so a multi-line command can't break
// the line apart.
function subjectOf(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const fields = input as Record<string, unknown>
  const key = SUBJECT_KEYS.find(name => typeof fields[name] === 'string' && fields[name] !== '')
  const raw =
    key !== undefined ? String(fields[key]) : Object.keys(fields).length > 0 ? JSON.stringify(fields) : ''
  return raw.replace(/\s+/g, ' ').trim()
}

// An errored call's output is the plain text the model read, so only an object carries result fields.
function resultField(row: ToolRow, name: string): unknown {
  return typeof row.output === 'object' && row.output !== null
    ? (row.output as Record<string, unknown>)[name]
    : undefined
}

// Each probe surfaces one fact the hidden result block would have shown; add one here to extend the meta.
type MetaProbe = (row: ToolRow) => string | undefined

const META_PROBES: MetaProbe[] = [
  row => (row.isInterrupted ? 'interrupted' : undefined),
  row => (row.isErrored && !row.isInterrupted ? 'error' : undefined),
  row => (resultField(row, 'backgroundTaskId') !== undefined ? 'background' : undefined),
  row => (resultField(row, 'timedOutAfterMs') !== undefined ? 'timed out' : undefined),
  row => {
    const printed = `${resultField(row, 'stdout') ?? ''}\n${resultField(row, 'stderr') ?? ''}`
    return /Shell cwd was reset/.test(printed) ? 'shell cwd was reset' : undefined
  },
  row => {
    const note = resultField(row, 'returnCodeInterpretation')
    return typeof note === 'string' && note !== '' ? note : undefined
  },
]

// MARK: Line

type ToolLine = { tool: string; subject: string; meta: string }

function clip(text: string, room: number): string {
  if (text.length <= room) return text
  return room <= 1 ? '…' : text.slice(0, room - 1) + '…'
}

// The subject is the only part cut, so the tool name and meta always stay readable.
function lineFor(row: ToolRow, columns: number): ToolLine {
  // 2 is the dot's column, which the summary text sits beside.
  const width = Math.max(columns - GUTTER - 2, 20)
  const budget = Math.min(Math.max(width, MIN_CHARS), width * MAX_ROWS)
  const meta = META_PROBES.map(probe => probe(row))
    .filter(note => note !== undefined)
    .join(', ')
  const frame = `tool_call: ${row.tool}()`.length + (meta === '' ? 0 : ` - ${meta}`.length)
  const subjectWidth = Math.min(MAX_SUBJECT_CHARS, budget - frame)
  return { tool: row.tool, subject: clip(subjectOf(row.input), subjectWidth), meta }
}

// MARK: Status

// The dot alone carries the call's state, so the line needs no "running" text. Theme keys follow
// the person's theme: warning is its yellow, success its green, error its red.
function dotStyle(row: ToolRow): { color: string } {
  if (row.isErrored || row.isInterrupted) return { color: 'error' }
  // isRunning is false while a call waits its turn or its approval, so only a stored result marks it done.
  return row.isRunning || row.output === undefined ? { color: 'warning' } : { color: 'success' }
}

// MARK: View

// Tool rows don't say whether the ctrl+o transcript (or --verbose) is open, but the person's own
// prompt rows do; their flag is mirrored here so every tool site leaves that view to the engine.
let isExpandedView = false

function isCompact(surface: string): boolean {
  return surface === 'terminal' && !isExpandedView
}

// MARK: Hooks

export const register: Register = on => {
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'composer' } } }, async ($, e, next) => {
    if (e.surface === 'terminal' && e.props.isExpanded !== isExpandedView) {
      isExpandedView = e.props.isExpanded
      // Tool rows keep their last answer until asked again, so the switch has to redraw them.
      $.ui.invalidate('ui.render')
    }
    if (!isCompact(e.surface)) return next(e)
    const { Box } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', marginBottom: 1, children: [await next(e)] })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!isCompact(e.surface)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const line = lineFor(e.props, e.viewport?.columns ?? FALLBACK_COLUMNS)
    const metaStyle = e.props.isErrored ? { color: 'error' } : { dimColor: true }
    return Box({
      flexDirection: 'row',
      marginLeft: 2,
      children: [
        // The dot's own column keeps wrapped rows aligned under the text, as the engine's tool rows do.
        Box({ minWidth: 2, flexShrink: 0, children: [Text({ ...dotStyle(e.props), children: ['●'] })] }),
        Box({
          flexShrink: 1,
          children: [
            Text({
              wrap: 'wrap',
              children: [
                Text({ dimColor: true, children: ['tool_call: '] }),
                Text({ bold: true, children: [line.tool] }),
                `(${line.subject})`,
                ...(line.meta === '' ? [] : [Text({ ...metaStyle, children: [` - ${line.meta}`] })]),
              ],
            }),
          ],
        }),
      ],
    })
  })

  // Unfolding hands each grouped read or search to the ToolUse hook, so it flows like every other call.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!isCompact(e.surface)) return next(e)
    return next({ ...e, props: { ...e.props, isExpanded: true } })
  })

  // The compact line already carries what the result block would say.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!isCompact(e.surface)) return next(e)
    const { Box } = $.ui.resolve(e)
    return Box({})
  })
}
