import { plainText, type Block, type Inline } from './markdown'

// MARK: Sentence ends

// Words whose period ends the word, not the sentence, even before a capital ("e.g. Python").
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|approx|al|Mr|Mrs|Ms|Dr|St|No|Fig)\.$/i
// A lone capital before a period is an initial ("J. Smith").
const INITIAL = /(?:^|\s)\p{Lu}\.$/u
const SENTENCE_END = /[.!?]["'”’)\]]*$/

function endsSentence(before: string): boolean {
  return SENTENCE_END.test(before) && !ABBREVIATION.test(before) && !INITIAL.test(before)
}

// A lowercase word after the period reads as the same sentence going on ("approx. ten", "v2. then").
function startsSentence(ch: string | undefined): boolean {
  return ch !== undefined && !/\p{Ll}/u.test(ch)
}

function opensSentence(node: Inline | undefined): boolean {
  if (node === undefined || node.kind === 'break') return false
  if (node.kind === 'text' || node.kind === 'emph' || node.kind === 'strong' || node.kind === 'strike') {
    return startsSentence(plainText([node])[0])
  }
  // Code, a link or an image after a full stop starts the next sentence.
  return true
}

// MARK: Inlines

// The space after a sentence becomes a line break; `before` is the text the node follows, for a period it ended with.
function splitText(text: string, before: string, next: Inline | undefined): Inline[] {
  const out: Inline[] = []
  let start = 0
  for (const gap of text.matchAll(/\s+/g)) {
    const at = gap.index ?? 0
    const end = at + gap[0].length
    const opens = end < text.length ? startsSentence(text[end]) : opensSentence(next)
    if (!opens || !endsSentence(before + text.slice(0, at))) continue
    if (at > start) out.push({ kind: 'text', text: text.slice(start, at) })
    out.push({ kind: 'break' })
    start = end
  }
  if (start < text.length) out.push({ kind: 'text', text: text.slice(start) })
  return out
}

// A link's label is left whole: a break inside it would split one link over two lines.
function splitInlines(nodes: Inline[]): Inline[] {
  const out: Inline[] = []
  nodes.forEach((node, i) => {
    if (node.kind === 'emph' || node.kind === 'strong' || node.kind === 'strike') {
      out.push({ ...node, children: splitInlines(node.children) })
    } else if (node.kind === 'text') {
      out.push(...splitText(node.text, plainText(out.slice(-1)), nodes[i + 1]))
    } else out.push(node)
  })
  return out
}

// MARK: Blocks

/** Starts each sentence of the reply's prose on a line of its own; headings, tables and code keep their lines. */
export function splitSentences(blocks: Block[]): Block[] {
  return blocks.map((block): Block => {
    switch (block.kind) {
      case 'paragraph':
        return { ...block, content: splitInlines(block.content) }
      case 'quote':
        return { ...block, blocks: splitSentences(block.blocks) }
      case 'list':
        return { ...block, items: block.items.map(item => ({ ...item, blocks: splitSentences(item.blocks) })) }
      default:
        return block
    }
  })
}
