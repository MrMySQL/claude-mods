import { highlight } from './highlight'
import type { Align, Block, Inline, ListItem } from './markdown'
import type { ChromaToken, StyleBlock, StyleColor, StyleConfig, StylePrimitive } from './style'

// MARK: Painted lines

/** The Text props a span is drawn with. */
export type Paint = {
  color?: string
  backgroundColor?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  inverse?: boolean
  dimColor?: boolean
}

export type Span = { text: string; paint: Paint; href?: string }

/** One terminal row, already wrapped to the width it was laid out for. */
export type Line = Span[]

// MARK: Color

// glamour sends an xterm-256 index as that palette entry, so the terminal paints it in its own palette as glamour would;
// a hex value stays hex.
export function colorOf(color: StyleColor): string {
  return /^\d{1,3}$/.test(color) ? `ansi256(${color})` : color
}

/** The style's own fields win over the parent's, as glamour cascades a style down the tree. */
export function cascade(parent: Paint, style: StylePrimitive): Paint {
  const paint = { ...parent }
  if (style.color !== undefined) paint.color = colorOf(style.color)
  if (style.background_color !== undefined) paint.backgroundColor = colorOf(style.background_color)
  if (style.bold !== undefined) paint.bold = style.bold
  if (style.italic !== undefined) paint.italic = style.italic
  if (style.underline !== undefined) paint.underline = style.underline
  if (style.crossed_out !== undefined) paint.strikethrough = style.crossed_out
  if (style.inverse !== undefined) paint.inverse = style.inverse
  if (style.faint !== undefined) paint.dimColor = style.faint
  return paint
}

/** What glamour's BaseElement writes around a token: block prefix, prefix, the formatted token, suffix, block suffix. */
function decorate(style: StylePrimitive, token: string): string {
  const text = style.format === undefined ? token : style.format.replace(/\{\{\s*\.text\s*\}\}/g, token)
  return (style.block_prefix ?? '') + (style.prefix ?? '') + text + (style.suffix ?? '') + (style.block_suffix ?? '')
}

// MARK: Cells

// Ranges the terminal draws two cells wide: CJK, Hangul, fullwidth forms and the emoji blocks.
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
]

function charCells(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  const joins = (code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || (code >= 0xfe00 && code <= 0xfe0f)
  if (joins) return 0
  return WIDE.some(([low, high]) => code >= low && code <= high) ? 2 : 1
}

export function cellsOf(text: string): number {
  let cells = 0
  for (const ch of text) cells += charCells(ch)
  return cells
}

function spansCells(spans: Span[]): number {
  return spans.reduce((cells, span) => cells + cellsOf(span.text), 0)
}

// MARK: Wrapping

type Word = { parts: Span[]; cells: number }
type Piece = { kind: 'word'; word: Word } | { kind: 'space'; span: Span } | { kind: 'newline' }

// Text that runs across spans with no space between (`foo**bar**`) is one word, so it never breaks there.
function piecesOf(spans: Span[]): Piece[] {
  const pieces: Piece[] = []
  let continues = false
  for (const span of spans) {
    for (const text of span.text.split(/(\n| +)/)) {
      if (text === '') continue
      if (text === '\n') pieces.push({ kind: 'newline' })
      else if (text.startsWith(' ')) pieces.push({ kind: 'space', span: { ...span, text } })
      else {
        const last = pieces[pieces.length - 1]
        if (continues && last?.kind === 'word') {
          last.word.parts.push({ ...span, text })
          last.word.cells += cellsOf(text)
        } else pieces.push({ kind: 'word', word: { parts: [{ ...span, text }], cells: cellsOf(text) } })
      }
      continues = text !== '\n' && !text.startsWith(' ')
    }
  }
  return pieces
}

function samePaint(a: Paint, b: Paint): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof Paint)[])
  return [...keys].every(key => a[key] === b[key])
}

// Text that looks the same joins the span before it, so a row is drawn with as few elements as it needs.
function append(line: Line, from: Span, text: string): void {
  const last = line[line.length - 1]
  if (last !== undefined && last.href === from.href && samePaint(last.paint, from.paint)) last.text += text
  else line.push({ ...from, text })
}

/** Greedy word wrap, as lipgloss.Wrap does: a space where a line breaks goes, a word wider than a line is cut. */
export function wrap(spans: Span[], width: number): Line[] {
  const lines: Line[] = [[]]
  let used = 0
  let gap: Span | undefined
  // A line glamour starts itself keeps its leading spaces (a heading's padding); one the wrap starts drops them.
  let hardStart = true
  const line = () => lines[lines.length - 1] as Line
  const newLine = (hard: boolean) => {
    lines.push([])
    used = 0
    gap = undefined
    hardStart = hard
  }
  for (const piece of piecesOf(spans)) {
    if (piece.kind === 'newline') {
      newLine(true)
      continue
    }
    if (piece.kind === 'space') {
      if (used > 0) gap = gap === undefined ? piece.span : { ...gap, text: gap.text + piece.span.text }
      else if (hardStart) {
        append(line(), piece.span, piece.span.text)
        used += cellsOf(piece.span.text)
      }
      continue
    }
    const { word } = piece
    const gapCells = gap === undefined ? 0 : cellsOf(gap.text)
    if (used > 0 && used + gapCells + word.cells > width) newLine(false)
    else if (gap !== undefined) {
      append(line(), gap, gap.text)
      used += gapCells
    }
    gap = undefined
    if (word.cells <= width - used) {
      for (const part of word.parts) append(line(), part, part.text)
      used += word.cells
      continue
    }
    for (const part of word.parts) {
      for (const ch of part.text) {
        const cells = charCells(ch)
        if (used > 0 && used + cells > width) newLine(false)
        append(line(), part, ch)
        used += cells
      }
    }
  }
  return lines
}

// Code keeps its spacing, so a long line is cut at the edge rather than at a space.
function cut(line: Line, width: number): Line[] {
  const lines: Line[] = [[]]
  let used = 0
  for (const span of line) {
    for (const ch of span.text) {
      const cells = charCells(ch)
      if (used > 0 && used + cells > width) {
        lines.push([])
        used = 0
      }
      append(lines[lines.length - 1] as Line, span, ch)
      used += cells
    }
  }
  return lines
}

// MARK: Inlines

type InlineDrawer<K extends Inline['kind']> = (node: Extract<Inline, { kind: K }>, paint: Paint, style: StyleConfig) => Span[]

function inlineSpans(nodes: Inline[], paint: Paint, style: StyleConfig): Span[] {
  return nodes.flatMap(node => (INLINE_DRAWERS[node.kind] as InlineDrawer<typeof node.kind>)(node as never, paint, style))
}

// glamour's Go config pads code with no-break spaces so the padding never wraps away from the code.
const glued = (text = '') => text.replace(/ /g, ' ')

/** How each inline kind is drawn; add an entry here to draw a new kind. */
const INLINE_DRAWERS: { [K in Inline['kind']]: InlineDrawer<K> } = {
  text: (node, paint, style) => [{ text: node.text, paint: cascade(paint, style.text) }],
  emph: (node, paint, style) => inlineSpans(node.children, cascade(paint, style.emph), style),
  strong: (node, paint, style) => inlineSpans(node.children, cascade(paint, style.strong), style),
  strike: (node, paint, style) => inlineSpans(node.children, cascade(paint, style.strikethrough), style),
  code: (node, paint, style) => [
    { text: glued(style.code.prefix) + node.text + glued(style.code.suffix), paint: cascade(paint, style.code) },
  ],
  link: (node, paint, style) => [
    ...inlineSpans(node.children, cascade(paint, style.link_text), style).map(span => ({ ...span, href: node.href })),
    { text: ' ', paint },
    { text: node.href, paint: cascade(paint, style.link), href: node.href },
  ],
  autolink: (node, paint, style) => [{ text: node.href, paint: cascade(paint, style.link), href: node.href }],
  image: (node, paint, style) => [
    ...(node.alt === '' ? [] : [{ text: decorate(style.image_text, node.alt), paint: cascade(paint, style.image_text) }, { text: ' ', paint }]),
    { text: node.href, paint: cascade(paint, style.image), href: node.href },
  ],
  break: (_, paint) => [{ text: '\n', paint }],
}

// MARK: Blocks

type Context = { style: StyleConfig; width: number; paint: Paint; depth: number }

type BlockDrawer<K extends Block['kind']> = (block: Extract<Block, { kind: K }>, context: Context) => Line[]

function drawBlock(block: Block, context: Context): Line[] {
  return (BLOCK_DRAWERS[block.kind] as BlockDrawer<typeof block.kind>)(block as never, context)
}

function drawBlocks(blocks: Block[], context: Context, gap: number): Line[] {
  return blocks.flatMap((block, i) => [
    ...Array.from({ length: i > 0 ? gap : 0 }, (): Line => []),
    ...drawBlock(block, context),
  ])
}

/** A block's margin and indent tokens, as glamour's margin writer puts them around every line. */
function framed(rules: StyleBlock, context: Context, draw: (inner: Context) => Line[]): Line[] {
  const margin = rules.margin ?? 0
  const indent = (rules.indent_token ?? ' ').repeat(rules.indent ?? 0)
  const lead = ' '.repeat(margin) + indent
  const width = Math.max(context.width - margin * 2 - cellsOf(indent), 1)
  const lines = draw({ ...context, width, paint: cascade(context.paint, rules) })
  return lead === '' ? lines : lines.map(line => [{ text: lead, paint: context.paint }, ...line])
}

// The chroma classes a token falls back through when the theme leaves it unstyled.
const CHROMA_PARENT: Partial<Record<ChromaToken, ChromaToken>> = {
  keyword_reserved: 'keyword',
  keyword_namespace: 'keyword',
  keyword_type: 'keyword',
  comment_preproc: 'comment',
  name_builtin: 'name',
  name_tag: 'name',
  name_attribute: 'name',
  name_class: 'name',
  name_constant: 'name',
  name_decorator: 'name',
  name_exception: 'name',
  name_function: 'name',
  name_other: 'name',
  literal_number: 'literal',
  literal_date: 'literal',
  literal_string: 'literal',
  literal_string_escape: 'literal_string',
}

function lineageOf(kind: ChromaToken): ChromaToken[] {
  const parent = CHROMA_PARENT[kind]
  return parent === undefined ? [kind] : [...lineageOf(parent), kind]
}

function markerOf(list: Extract<Block, { kind: 'list' }>, item: ListItem, index: number, context: Context): Span {
  const { style, paint } = context
  if (item.checked !== undefined) {
    return { text: decorate(style.task, (item.checked ? style.task.ticked : style.task.unticked) ?? ''), paint: cascade(paint, style.task) }
  }
  if (list.ordered) return { text: `${list.start + index}` + decorate(style.enumeration, ''), paint: cascade(paint, style.enumeration) }
  return { text: decorate(style.item, ''), paint: cascade(paint, style.item) }
}

// The item's text hangs under its first line; a nested list keeps glamour's level indent from the list's edge.
function itemLines(item: ListItem, marker: Span, context: Context): Line[] {
  const hang = cellsOf(marker.text)
  const lines: Line[] = []
  for (const block of item.blocks) {
    if (block.kind === 'list' && lines.length > 0) {
      lines.push(...drawBlock(block, context))
      continue
    }
    for (const line of drawBlock(block, { ...context, width: Math.max(context.width - hang, 1) })) {
      lines.push([lines.length === 0 ? marker : { text: ' '.repeat(hang), paint: context.paint }, ...line])
    }
  }
  return lines.length === 0 ? [[marker]] : lines
}

function aligned(line: Line, width: number, align: Align, paint: Paint): Line {
  const room = Math.max(width - spansCells(line), 0)
  const before = align === 'right' ? room : align === 'center' ? Math.floor(room / 2) : 0
  const pad = (cells: number): Line => (cells > 0 ? [{ text: ' '.repeat(cells), paint }] : [])
  return [...pad(before), ...line, ...pad(room - before)]
}

// The widest column gives way first until the table fits, the way lipgloss shrinks a table to its width.
function fitColumns(natural: number[], room: number): number[] {
  const widths = [...natural]
  const MIN = 3
  while (widths.reduce((sum, w) => sum + w, 0) > room) {
    const widest = widths.indexOf(Math.max(...widths))
    if ((widths[widest] ?? 0) <= MIN) break
    widths[widest] = (widths[widest] ?? 0) - 1
  }
  return widths
}

/** How each block kind is drawn; add an entry here to draw a new kind. */
const BLOCK_DRAWERS: { [K in Block['kind']]: BlockDrawer<K> } = {
  paragraph: (block, context) => wrap(inlineSpans(block.content, cascade(context.paint, context.style.paragraph), context.style), context.width),

  heading: (block, context) => {
    const { style } = context
    const level = style[`h${block.level}` as 'h1'] ?? {}
    const rules = { ...style.heading, ...level }
    const paint = cascade(cascade(context.paint, style.heading), level)
    const lines = wrap([{ text: rules.prefix ?? '', paint }, ...inlineSpans(block.content, paint, style)], context.width)
    // glamour writes the suffix after the wrapped text, so it never moves to a line of its own.
    const last = lines[lines.length - 1]
    if (rules.suffix && last !== undefined) append(last, { text: rules.suffix, paint }, rules.suffix)
    return lines
  },

  code: (block, context) =>
    framed(context.style.code_block, context, inner => {
      const { chroma } = context.style.code_block
      const base = chroma === undefined ? inner.paint : [chroma.background, chroma.text].reduce<Paint>((paint, rules) => cascade(paint, rules ?? {}), {})
      const tokens = chroma === undefined ? [{ text: block.text, kind: 'text' as const }] : highlight(block.text, block.language)
      const lines: Line[] = [[]]
      for (const token of tokens) {
        const paint = chroma === undefined ? base : lineageOf(token.kind).reduce((p, kind) => cascade(p, chroma[kind] ?? {}), base)
        token.text.split('\n').forEach((text, i) => {
          if (i > 0) lines.push([])
          if (text !== '') append(lines[lines.length - 1] as Line, { text, paint }, text)
        })
      }
      return lines.flatMap(line => cut(line, inner.width))
    }),

  quote: (block, context) => framed(context.style.block_quote, context, inner => drawBlocks(block.blocks, inner, 1)),

  list: (block, context) => {
    const { list } = context.style
    // glamour indents a list by level_indent only when it sits inside another list.
    const rules = { ...list, indent: context.depth > 0 ? list.level_indent ?? 0 : list.indent ?? 0 }
    return framed(rules, { ...context, depth: context.depth + 1 }, inner =>
      block.items.flatMap((item, i) => itemLines(item, markerOf(block, item, i, inner), inner)),
    )
  },

  hr: (_, context) => {
    const rule = decorate(context.style.hr, '').replace(/^\n+|\n+$/g, '')
    const paint = cascade(context.paint, context.style.hr)
    return rule.split('\n').map(text => [{ text, paint }])
  },

  table: (block, context) => {
    const { style } = context
    const paint = cascade(context.paint, style.table)
    const head = block.head.map(cell => inlineSpans(cell, paint, style))
    const rows = block.rows.map(row => row.map(cell => inlineSpans(cell, paint, style)))
    const natural = block.align.map((_, c) => Math.max(1, ...[head, ...rows].map(row => spansCells(row[c] ?? []))))
    // Each cell has a space on either side, and a separator stands between columns.
    const frame = block.align.length * 3 - 1
    const widths = fitColumns(natural, context.width - frame)
    const separator = style.table.column_separator ?? '│'
    const rowLines = (cells: Span[][]): Line[] => {
      const wrapped = widths.map((width, c) => wrap(cells[c] ?? [], width))
      const height = Math.max(...wrapped.map(lines => lines.length))
      return Array.from({ length: height }, (_, r) =>
        widths.flatMap((width, c): Line => [
          ...(c > 0 ? [{ text: separator, paint }] : []),
          { text: ' ', paint },
          ...aligned(wrapped[c]?.[r] ?? [], width, block.align[c] ?? 'none', paint),
          { text: ' ', paint },
        ]),
      )
    }
    const rule = widths.map(width => (style.table.row_separator ?? '─').repeat(width + 2)).join(style.table.center_separator ?? '┼')
    return [...rowLines(head), [{ text: rule, paint }], ...rows.flatMap(rowLines)]
  },
}

// MARK: Document

/** Lays a parsed reply out as glamour would print it at `columns` cells wide. */
export function layout(blocks: Block[], style: StyleConfig, columns: number): Line[] {
  return framed(style.document, { style, width: columns, paint: {}, depth: 0 }, inner => drawBlocks(blocks, inner, 1))
}
