// MARK: Tree

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'emph'; children: Inline[] }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'strike'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'autolink'; href: string }
  | { kind: 'image'; href: string; alt: string }
  | { kind: 'break' }

export type Align = 'left' | 'center' | 'right' | 'none'

/** `checked` is present only on a task item (`- [x] done`). */
export type ListItem = { checked?: boolean; blocks: Block[] }

export type Block =
  | { kind: 'heading'; level: number; content: Inline[] }
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'hr' }
  | { kind: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }

// MARK: Blocks

const BLANK = /^\s*$/
const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)/
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}> ?(.*)$/
const ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

type Hit = { block: Block; next: number }

/** Each rule claims the block starting at `at`, or passes; add one here to read a new block kind. */
type BlockRule = (lines: string[], at: number) => Hit | undefined

const fence: BlockRule = (lines, at) => {
  const open = FENCE.exec(lines[at] ?? '')
  if (open === null) return undefined
  const [, indent = '', marker = '', language = ''] = open
  const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`)
  const body: string[] = []
  let i = at + 1
  // A fence still streaming in has no closer yet, so the rest of the reply is its body.
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (close.test(line)) {
      i++
      break
    }
    body.push(dropColumns(line, Math.min(indent.length, leadingColumns(line))))
  }
  return { block: { kind: 'code', language, text: body.join('\n') }, next: i }
}

const heading: BlockRule = (lines, at) => {
  const match = ATX.exec(lines[at] ?? '')
  if (match === null) return undefined
  const [, hashes = '', text = ''] = match
  return { block: { kind: 'heading', level: hashes.length, content: parseInline(text.trim()) }, next: at + 1 }
}

const rule: BlockRule = (lines, at) => (HR.test(lines[at] ?? '') ? { block: { kind: 'hr' }, next: at + 1 } : undefined)

const quote: BlockRule = (lines, at) => {
  if (!QUOTE.test(lines[at] ?? '')) return undefined
  const body: string[] = []
  let i = at
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const match = QUOTE.exec(line)
    if (match !== null) body.push(match[1] ?? '')
    // A lazy line carries on the quoted paragraph without its own `>`.
    else if (!BLANK.test(line) && !BLANK.test(body[body.length - 1] ?? '') && !startsBlock(lines, i)) body.push(line)
    else break
  }
  return { block: { kind: 'quote', blocks: parseBlocks(body) }, next: i }
}

const list: BlockRule = (lines, at) => {
  const first = ITEM.exec(lines[at] ?? '')
  if (first === null) return undefined
  const marker = first[2] ?? ''
  const ordered = /\d/.test(marker)
  const items: ListItem[] = []
  let i = at
  while (i < lines.length) {
    const match = ITEM.exec(lines[i] ?? '')
    if (match === null || !sameList(marker, match[2] ?? '')) break
    const [, indent = '', bullet = '', gap = ' ', rest = ''] = match
    // Content sits after the marker and its gap; a gap of five or more starts the content after one space.
    const column = indent.length + bullet.length + (gap.length > 4 || rest === '' ? 1 : gap.length)
    const body = [rest]
    for (i++; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (BLANK.test(line)) body.push('')
      else if (leadingColumns(line) >= column) body.push(dropColumns(line, column))
      else if (!BLANK.test(body[body.length - 1] ?? '') && !startsBlock(lines, i)) body.push(line.trim())
      else break
    }
    const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(body[0] ?? '')
    if (task !== null) body[0] = (body[0] ?? '').slice(task[0].length)
    items.push({ ...(task !== null && { checked: task[1] !== ' ' }), blocks: parseBlocks(body) })
  }
  const start = ordered ? Number.parseInt(marker, 10) : 1
  return { block: { kind: 'list', ordered, start, items }, next: i }
}

const table: BlockRule = (lines, at) => {
  const head = lines[at] ?? ''
  const delimiters = lines[at + 1] ?? ''
  if (!head.includes('|') || !DELIMITER_ROW.test(delimiters)) return undefined
  const align = cellsOf(delimiters).map(alignOf)
  const headCells = cellsOf(head)
  if (headCells.length !== align.length) return undefined
  const rows: Inline[][][] = []
  let i = at + 2
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (BLANK.test(line) || !line.includes('|') || startsBlock(lines, i)) break
    const cells = cellsOf(line)
    rows.push(align.map((_, column) => parseInline(cells[column] ?? '')))
  }
  return { block: { kind: 'table', align, head: headCells.map(parseInline), rows }, next: i }
}

const BLOCK_RULES: BlockRule[] = [fence, heading, rule, quote, list, table]

// The rules that may cut a paragraph short; a table needs a paragraph line as its header, so it is checked apart.
const INTERRUPTS: BlockRule[] = [fence, heading, rule, quote, nonEmptyItem]

function nonEmptyItem(lines: string[], at: number): Hit | undefined {
  return ITEM.exec(lines[at] ?? '')?.[4]?.trim() ? list(lines, at) : undefined
}

function startsBlock(lines: string[], at: number): boolean {
  return INTERRUPTS.some(read => read([lines[at] ?? ''], 0) !== undefined)
}

function paragraph(lines: string[], at: number): Hit {
  const body = [lines[at] ?? '']
  let i = at + 1
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (BLANK.test(line)) break
    const underline = SETEXT.exec(line)
    if (underline !== null) {
      const level = underline[1]?.startsWith('=') ? 1 : 2
      return { block: { kind: 'heading', level, content: parseInline(body.join('\n').trim()) }, next: i + 1 }
    }
    if (startsBlock(lines, i) || table(lines, i) !== undefined) break
    body.push(line)
  }
  // Only leading space goes: two trailing spaces mark a hard break.
  const text = body.map(line => line.trimStart()).join('\n').trimEnd()
  return { block: { kind: 'paragraph', content: parseInline(text) }, next: i }
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    if (BLANK.test(lines[i] ?? '')) {
      i++
      continue
    }
    const hit = BLOCK_RULES.reduce<Hit | undefined>((found, read) => found ?? read(lines, i), undefined) ?? paragraph(lines, i)
    blocks.push(hit.block)
    i = hit.next
  }
  return blocks
}

export function parse(markdown: string): Block[] {
  return parseBlocks(markdown.replace(/\r\n?/g, '\n').split('\n').map(expandLeadingTabs))
}

// MARK: Block helpers

function expandLeadingTabs(line: string): string {
  const lead = /^[ \t]*/.exec(line)?.[0] ?? ''
  let columns = 0
  for (const ch of lead) columns = ch === '\t' ? columns + 4 - (columns % 4) : columns + 1
  return ' '.repeat(columns) + line.slice(lead.length)
}

function leadingColumns(line: string): number {
  return line.length - line.trimStart().length
}

function dropColumns(line: string, columns: number): string {
  return line.slice(Math.min(columns, leadingColumns(line)))
}

function sameList(first: string, next: string): boolean {
  const ordered = /\d/.test(first)
  return ordered ? /\d/.test(next) && first.slice(-1) === next.slice(-1) : first === next
}

function cellsOf(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  return trimmed.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'))
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  return left && right ? 'center' : right ? 'right' : left ? 'left' : 'none'
}

// MARK: Inlines

type Delimiter = { kind: 'delimiter'; char: string; count: number; canOpen: boolean; canClose: boolean }
type Piece = Inline | Delimiter

const ESCAPABLE = /[!-/:-@[-`{-~]/
const PUNCTUATION = /[\p{P}\p{S}]/u
const AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/
const BARE_URL = /^(?:https?:\/\/|www\.)[^\s<]*/
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function parseInline(source: string): Inline[] {
  const pieces: Piece[] = []
  let text = ''
  const flush = () => {
    if (text !== '') pieces.push({ kind: 'text', text })
    text = ''
  }
  let i = 0
  while (i < source.length) {
    const ch = source[i] ?? ''
    const rest = source.slice(i)

    if (ch === '\\' && source[i + 1] === '\n') {
      flush()
      pieces.push({ kind: 'break' })
      i += 2
      continue
    }
    if (ch === '\\' && ESCAPABLE.test(source[i + 1] ?? '')) {
      text += source[i + 1]
      i += 2
      continue
    }
    if (ch === '`') {
      const run = /^`+/.exec(rest)?.[0] ?? '`'
      const end = closingRun(source, i + run.length, run)
      if (end === -1) {
        text += run
        i += run.length
        continue
      }
      flush()
      pieces.push({ kind: 'code', text: codeSpanText(source.slice(i + run.length, end)) })
      i = end + run.length
      continue
    }
    if (ch === '!' && source[i + 1] === '[') {
      const link = linkAt(source, i + 1)
      if (link !== undefined) {
        flush()
        pieces.push({ kind: 'image', href: link.href, alt: plainText(parseInline(link.label)) })
        i = link.end
        continue
      }
    }
    if (ch === '[') {
      const link = linkAt(source, i)
      if (link !== undefined) {
        flush()
        pieces.push({ kind: 'link', href: link.href, children: parseInline(link.label) })
        i = link.end
        continue
      }
    }
    if (ch === '<') {
      const auto = AUTOLINK.exec(rest)
      if (auto !== null) {
        flush()
        pieces.push({ kind: 'autolink', href: auto[1] ?? '' })
        i += auto[0].length
        continue
      }
    }
    if ((ch === 'h' || ch === 'w') && /^$|[\s*_~(]$/.test(source[i - 1] ?? '')) {
      const url = BARE_URL.exec(rest)?.[0]
      if (url !== undefined) {
        const href = trimUrl(url)
        flush()
        pieces.push({ kind: 'autolink', href })
        i += href.length
        continue
      }
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      const run = new RegExp(`^\\${ch}+`).exec(rest)?.[0] ?? ch
      flush()
      pieces.push(delimiterOf(ch, run.length, source[i - 1] ?? ' ', source[i + run.length] ?? ' '))
      i += run.length
      continue
    }
    if (ch === '\n') {
      // A soft break flows into the paragraph as a space, as glamour joins lines unless told to keep them.
      const hard = text.endsWith('  ')
      text = text.trimEnd()
      if (hard) {
        flush()
        pieces.push({ kind: 'break' })
      } else text += ' '
      i++
      while (source[i] === ' ') i++
      continue
    }
    if (ch === '&') {
      const entity = /^&(#\d{1,7}|#[xX][\da-fA-F]{1,6}|[a-zA-Z]+);/.exec(rest)
      const decoded = entity === null ? undefined : decodeEntity(entity[1] ?? '')
      if (entity !== null && decoded !== undefined) {
        text += decoded
        i += entity[0].length
        continue
      }
    }
    text += ch
    i++
  }
  flush()
  return resolveEmphasis(pieces)
}

// MARK: Inline helpers

function closingRun(source: string, from: number, run: string): number {
  for (let at = source.indexOf(run, from); at !== -1; at = source.indexOf(run, at + 1)) {
    const longer = source[at + run.length] === '`' || source[at - 1] === '`'
    if (!longer) return at
  }
  return -1
}

function codeSpanText(raw: string): string {
  const flat = raw.replace(/\n/g, ' ')
  return /^ .*[^ ].* $/.test(flat) ? flat.slice(1, -1) : flat
}

type LinkMatch = { label: string; href: string; end: number }

function linkAt(source: string, open: number): LinkMatch | undefined {
  let depth = 0
  let close = -1
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') i++
    else if (ch === '`') i = Math.max(i, closingRun(source, i + 1, '`'))
    else if (ch === '[') depth++
    else if (ch === ']' && --depth === 0) {
      close = i
      break
    }
  }
  if (close === -1 || source[close + 1] !== '(') return undefined
  const target = /^\(\s*(?:<([^<>\n]*)>|((?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/.exec(
    source.slice(close + 1),
  )
  if (target === null) return undefined
  return { label: source.slice(open + 1, close), href: target[1] ?? target[2] ?? '', end: close + 1 + target[0].length }
}

// Trailing punctuation reads as the sentence's, and a closing paren only belongs to the URL when it opened one.
function trimUrl(url: string): string {
  let href = url.replace(/[?!.,:*_~'"]+$/, '')
  while (href.endsWith(')') && (href.match(/\(/g)?.length ?? 0) < (href.match(/\)/g)?.length ?? 0)) {
    href = href.slice(0, -1).replace(/[?!.,:*_~'"]+$/, '')
  }
  return href
}

function decodeEntity(name: string): string | undefined {
  if (name.startsWith('#')) {
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : undefined
  }
  return ENTITIES[name]
}

// Flanking follows CommonMark: `_` also refuses to open or close inside a word, so snake_case stays plain.
function delimiterOf(char: string, count: number, before: string, after: string): Delimiter {
  const spaceBefore = /\s/.test(before)
  const spaceAfter = /\s/.test(after)
  const punctBefore = PUNCTUATION.test(before)
  const punctAfter = PUNCTUATION.test(after)
  const leftFlanking = !spaceAfter && (!punctAfter || spaceBefore || punctBefore)
  const rightFlanking = !spaceBefore && (!punctBefore || spaceAfter || punctAfter)
  if (char !== '_') return { kind: 'delimiter', char, count, canOpen: leftFlanking, canClose: rightFlanking }
  return {
    kind: 'delimiter',
    char,
    count,
    canOpen: leftFlanking && (!rightFlanking || punctBefore),
    canClose: rightFlanking && (!leftFlanking || punctAfter),
  }
}

function isDelimiter(piece: Piece | undefined): piece is Delimiter {
  return piece?.kind === 'delimiter'
}

function opens(opener: Delimiter, closer: Delimiter): boolean {
  if (opener.char !== closer.char || !opener.canOpen) return false
  if (closer.char === '~') return opener.count === closer.count && opener.count <= 2
  // CommonMark's rule of three keeps `*a**b*` from pairing the wrong runs.
  const both = opener.canClose || closer.canOpen
  return !(both && (opener.count + closer.count) % 3 === 0 && !(opener.count % 3 === 0 && closer.count % 3 === 0))
}

function resolveEmphasis(input: Piece[]): Inline[] {
  const pieces = [...input]
  for (let c = 0; c < pieces.length; c++) {
    const closer = pieces[c]
    if (!isDelimiter(closer) || !closer.canClose) continue
    let o = c - 1
    while (o >= 0 && !(isDelimiter(pieces[o]) && opens(pieces[o] as Delimiter, closer))) o--
    if (o < 0) continue
    const opener = pieces[o] as Delimiter
    const used = closer.char === '~' ? closer.count : opener.count >= 2 && closer.count >= 2 ? 2 : 1
    const kind = closer.char === '~' ? 'strike' : used === 2 ? 'strong' : 'emph'
    const node: Inline = { kind, children: toInlines(pieces.slice(o + 1, c)) }
    const left = opener.count > used ? [{ ...opener, count: opener.count - used }] : []
    const right = closer.count > used ? [{ ...closer, count: closer.count - used }] : []
    pieces.splice(o, c - o + 1, ...left, node, ...right)
    // The closer's leftover may close an earlier opener, so the scan resumes right after the new node.
    c = o + left.length
  }
  return toInlines(pieces)
}

// Unmatched delimiters fall back to text and join their neighbours, so `snake_case` stays one text node.
function toInlines(pieces: Piece[]): Inline[] {
  const inlines: Inline[] = []
  for (const piece of pieces) {
    const node: Inline = isDelimiter(piece) ? { kind: 'text', text: piece.char.repeat(piece.count) } : piece
    const last = inlines[inlines.length - 1]
    if (node.kind === 'text' && last?.kind === 'text') inlines[inlines.length - 1] = { kind: 'text', text: last.text + node.text }
    else inlines.push(node)
  }
  return inlines
}

export function plainText(inlines: Inline[]): string {
  return inlines
    .map(node => {
      switch (node.kind) {
        case 'text':
        case 'code':
          return node.text
        case 'autolink':
          return node.href
        case 'image':
          return node.alt
        case 'break':
          return '\n'
        default:
          return plainText(node.children)
      }
    })
    .join('')
}
