import type { Register } from 'claude-code'
import { cascade, layout, type Line, type Paint, type Span } from './layout'
import { parse, type Block } from './markdown'
import { splitSentences } from './sentences'
import { DARK, type StyleConfig } from './style'

// MARK: Layout

/** The style replies are drawn in; any glamour theme converted to a StyleConfig drops in here. */
const STYLE: StyleConfig = DARK

/** Reshapes the parsed reply before it is laid out, in order; add one here to change how replies read. */
const REWRITES: ((blocks: Block[]) => Block[])[] = [splitSentences]

// The engine keeps a column clear at each edge of the transcript, so a line sized to the full width would spill.
const GUTTER = 2
// The viewport is absent until the terminal has been measured.
const FALLBACK_COLUMNS = 120
const BULLET = '●'

// The bullet opening a reply sits in the document's left margin, where the engine draws its own.
function withBullet(lines: Line[], paint: Paint): Line[] {
  const [first, ...rest] = lines
  const lead = first?.[0]
  if (first === undefined || lead === undefined || !lead.text.startsWith('  ')) return lines
  return [[{ text: BULLET, paint }, { ...lead, text: lead.text.slice(1) }, ...first.slice(1)], ...rest]
}

// glamour opens a document with a blank line, drawn as the row's top margin; its closing one is left out, since
// the engine's next row opens with a blank line of its own.
const blankLines = (text = '') => text.split('\n').length - 1

// MARK: Hooks

export const register: Register = on => {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // A summary keeps the engine's faint "· summary" mark, which a tree of the mod's own would drop.
    if (e.surface !== 'terminal' || e.props.isSummary) return next(e)
    const blocks = REWRITES.reduce((tree, rewrite) => rewrite(tree), parse(e.props.text))
    if (blocks.length === 0) return next(e)

    const { Box, Text, Link } = $.ui.resolve(e)
    const columns = (e.viewport?.columns ?? FALLBACK_COLUMNS) - GUTTER
    const laidOut = layout(blocks, STYLE, columns)
    const lines = e.props.isFirstOfReply ? withBullet(laidOut, cascade({}, STYLE.document)) : laidOut

    const drawSpan = (span: Span) => {
      const text = Text({ ...span.paint, children: [span.text] })
      return span.href === undefined ? text : Link({ href: span.href, children: [text] })
    }
    return Box({
      flexDirection: 'column',
      marginTop: blankLines(STYLE.document.block_prefix),
      // An empty Text takes no height, so a blank line between blocks is drawn as one space.
      children: lines.map(line => Text({ children: line.length === 0 ? [' '] : line.map(drawSpan) })),
    })
  })
}
