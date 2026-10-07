import type { ChromaToken } from './style'

// MARK: Contract

export type Token = { text: string; kind: ChromaToken }

/** Splits source into tokens tagged with the chroma class glamour's theme colors them by. */
export type Lexer = (source: string) => Token[]

// MARK: Code lexer

/** What tells one C-like or script language from another; a new language is one more spec. */
export type LanguageSpec = {
  keywords?: string[]
  reserved?: string[]
  namespaces?: string[]
  types?: string[]
  builtins?: string[]
  /** Keywords whose next name is a function being declared. */
  functionAfter?: string[]
  /** Keywords whose next name is a class, struct or trait being declared. */
  classAfter?: string[]
  lineComments?: string[]
  blockComment?: [string, string]
  /** Longest first, so `"""` wins over `"`. */
  quotes?: string[]
  decorators?: boolean
  /** A whole line read as a preprocessor directive (`#include`). */
  preprocessor?: RegExp
  /** A key at the start of a line (`name:` in YAML), drawn as a tag. */
  lineKey?: RegExp
  /** A string followed by `:` is a key (JSON). */
  stringKeys?: boolean
  ignoreCase?: boolean
}

const NUMBER = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]*/
const NAME = /^[A-Za-z_$][\w$]*/
const OPERATOR = /^(?:=>|->|::|[-+*/%=<>!&|^~?:]+)/
const PUNCTUATION = /^[()[\]{};,.@#]/
const SPACE = /^\s+/

export function codeLexer(spec: LanguageSpec): Lexer {
  const fold = (word: string) => (spec.ignoreCase ? word.toLowerCase() : word)
  const setOf = (words: string[] = []) => new Set(words.map(fold))
  const classes: [Set<string>, ChromaToken][] = [
    [setOf(spec.namespaces), 'keyword_namespace'],
    [setOf(spec.reserved), 'keyword_reserved'],
    [setOf(spec.types), 'keyword_type'],
    [setOf(spec.keywords), 'keyword'],
    [setOf(spec.builtins), 'name_builtin'],
  ]
  const functionAfter = setOf(spec.functionAfter)
  const classAfter = setOf(spec.classAfter)
  const quotes = [...(spec.quotes ?? [])].sort((a, b) => b.length - a.length)

  return source => {
    const tokens: Token[] = []
    const push = (text: string, kind: ChromaToken) => tokens.push({ text, kind })
    let declaring: ChromaToken | undefined
    let atLineStart = true
    let i = 0
    while (i < source.length) {
      const rest = source.slice(i)
      const lineEnd = rest.indexOf('\n') === -1 ? rest.length : rest.indexOf('\n')
      const take = (text: string, kind: ChromaToken) => {
        push(text, kind)
        i += text.length
      }

      const space = SPACE.exec(rest)?.[0]
      if (space !== undefined) {
        take(space, 'text')
        if (space.includes('\n')) atLineStart = true
        continue
      }
      const wasLineStart = atLineStart
      atLineStart = false
      // A declaring keyword names only the token right after it, so `function (` leaves the next name alone.
      const declared = declaring
      declaring = undefined

      if (wasLineStart && spec.preprocessor?.test(rest.slice(0, lineEnd))) {
        take(rest.slice(0, lineEnd), 'comment_preproc')
        continue
      }
      const key = wasLineStart ? spec.lineKey?.exec(rest)?.[0] : undefined
      if (key !== undefined) {
        take(key, 'name_tag')
        continue
      }
      const lineComment = spec.lineComments?.find(open => rest.startsWith(open))
      if (lineComment !== undefined) {
        take(rest.slice(0, lineEnd), 'comment')
        continue
      }
      if (spec.blockComment !== undefined && rest.startsWith(spec.blockComment[0])) {
        const close = rest.indexOf(spec.blockComment[1], spec.blockComment[0].length)
        take(close === -1 ? rest : rest.slice(0, close + spec.blockComment[1].length), 'comment')
        continue
      }
      const quote = quotes.find(open => rest.startsWith(open))
      if (quote !== undefined) {
        const literal = stringAt(rest, quote)
        const isKey = spec.stringKeys === true && /^\s*:/.test(rest.slice(literal.length))
        if (isKey) take(literal, 'name_tag')
        else {
          tokens.push(...stringTokens(literal))
          i += literal.length
        }
        continue
      }
      if (spec.decorators && /^@[A-Za-z_][\w.]*/.test(rest)) {
        take(/^@[A-Za-z_][\w.]*/.exec(rest)?.[0] ?? '@', 'name_decorator')
        continue
      }
      const number = NUMBER.exec(rest)?.[0]
      if (number !== undefined) {
        take(number, 'literal_number')
        continue
      }
      const name = NAME.exec(rest)?.[0]
      if (name !== undefined) {
        const folded = fold(name)
        const kind = declared ?? classes.find(([words]) => words.has(folded))?.[1] ?? 'name'
        declaring = functionAfter.has(folded) ? 'name_function' : classAfter.has(folded) ? 'name_class' : undefined
        take(name, kind)
        continue
      }
      const operator = OPERATOR.exec(rest)?.[0]
      if (operator !== undefined) {
        take(operator, 'operator')
        continue
      }
      take(PUNCTUATION.exec(rest)?.[0] ?? rest[0] ?? '', PUNCTUATION.test(rest) ? 'punctuation' : 'text')
    }
    return tokens
  }
}

// A string runs to its closing quote, or to the line's end when it never closes (a reply still streaming).
function stringAt(rest: string, quote: string): string {
  const multiline = quote.length === 3 || quote === '`'
  for (let i = quote.length; i < rest.length; i++) {
    if (rest[i] === '\\') i++
    else if (rest.startsWith(quote, i)) return rest.slice(0, i + quote.length)
    else if (rest[i] === '\n' && !multiline) return rest.slice(0, i)
  }
  return rest
}

function stringTokens(literal: string): Token[] {
  return literal
    .split(/(\\(?:x[\da-fA-F]{2}|u\{?[\da-fA-F]{1,6}\}?|[^\n]))/)
    .filter(part => part !== '')
    .map(part => ({ text: part, kind: part.startsWith('\\') ? 'literal_string_escape' : 'literal_string' }))
}

// MARK: Line lexers

/** A lexer that colors whole lines by their opening characters, first rule that matches wins. */
export function lineLexer(rules: [RegExp, ChromaToken][]): Lexer {
  return source =>
    source.split(/(?<=\n)/).map(line => ({ text: line, kind: rules.find(([test]) => test.test(line))?.[1] ?? 'text' }))
}

const diff = lineLexer([
  [/^\+/, 'generic_inserted'],
  [/^-/, 'generic_deleted'],
  [/^@/, 'generic_subheading'],
  [/^(?:diff|index) /, 'generic_strong'],
])

// MARK: Markup lexer

const markup: Lexer = source => {
  const tokens: Token[] = []
  const pattern =
    /(<!--[\s\S]*?(?:-->|$))|(<\/?)([\w:-]+)|([\w:-]+)(?==)|("[^"]*"?|'[^']*'?)|(\/?>)|([^<>"'=\s]+|\s+|[<>=])/g
  for (const match of source.matchAll(pattern)) {
    const [, comment, open, tag, attribute, string, close] = match
    if (comment !== undefined) tokens.push({ text: comment, kind: 'comment' })
    else if (open !== undefined && tag !== undefined) tokens.push({ text: open, kind: 'punctuation' }, { text: tag, kind: 'name_tag' })
    else if (attribute !== undefined) tokens.push({ text: attribute, kind: 'name_attribute' })
    else if (string !== undefined) tokens.push({ text: string, kind: 'literal_string' })
    else if (close !== undefined) tokens.push({ text: close, kind: 'punctuation' })
    else tokens.push({ text: match[0], kind: 'text' })
  }
  return tokens
}

// MARK: Languages

const C_FAMILY: LanguageSpec = {
  keywords: [
    'break', 'case', 'catch', 'continue', 'default', 'do', 'else', 'finally', 'for', 'goto', 'if', 'new', 'return',
    'sizeof', 'switch', 'this', 'throw', 'try', 'while', 'true', 'false', 'null', 'nullptr', 'NULL', 'class',
    'struct', 'enum', 'union', 'typedef', 'const', 'static', 'extern', 'public', 'private', 'protected', 'virtual',
    'override', 'final', 'abstract', 'extends', 'implements', 'interface', 'template', 'typename', 'auto', 'inline',
    'volatile', 'throws', 'instanceof', 'super', 'var', 'val', 'fun', 'func', 'let', 'guard', 'when', 'object',
  ],
  namespaces: ['import', 'package', 'namespace', 'using'],
  types: [
    'void', 'int', 'char', 'short', 'long', 'float', 'double', 'bool', 'boolean', 'byte', 'unsigned', 'signed',
    'size_t', 'string', 'String', 'Int', 'Double', 'Float', 'Bool', 'Boolean', 'Long', 'Unit', 'Any',
  ],
  classAfter: ['class', 'struct', 'enum', 'interface', 'union', 'object'],
  functionAfter: ['fun', 'func'],
  lineComments: ['//'],
  blockComment: ['/*', '*/'],
  quotes: ['"""', '"', "'"],
  decorators: true,
  preprocessor: /^#\s*\w+/,
}

const SCRIPT: LanguageSpec = {
  keywords: [
    'break', 'case', 'catch', 'continue', 'default', 'delete', 'do', 'else', 'finally', 'for', 'if',
    'in', 'instanceof', 'new', 'return', 'switch', 'this', 'throw', 'try', 'typeof', 'void', 'while', 'with',
    'yield', 'await', 'async', 'of', 'as', 'satisfies', 'keyof', 'infer', 'is', 'var', 'let',
    'function', 'type', 'declare', 'namespace', 'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  ],
  reserved: [
    'abstract', 'class', 'const', 'debugger', 'enum', 'export', 'extends', 'implements', 'import', 'interface',
    'package', 'private', 'protected', 'public', 'readonly', 'static', 'super',
  ],
  types: ['string', 'number', 'boolean', 'any', 'unknown', 'never', 'object', 'symbol', 'bigint'],
  builtins: [
    'Array', 'Boolean', 'Date', 'Error', 'Function', 'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise', 'Proxy',
    'Reflect', 'RegExp', 'Set', 'String', 'Symbol', 'WeakMap', 'WeakSet', 'console', 'document', 'globalThis',
    'process', 'window', 'parseInt', 'parseFloat', 'setTimeout', 'clearTimeout', 'fetch',
  ],
  functionAfter: ['function'],
  classAfter: ['class', 'interface', 'enum'],
  lineComments: ['//'],
  blockComment: ['/*', '*/'],
  quotes: ['"', "'", '`'],
  decorators: true,
}

const PYTHON: LanguageSpec = {
  keywords: [
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
    'finally', 'for', 'global', 'if', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
    'try', 'while', 'with', 'yield', 'match', 'case', 'True', 'False', 'None',
  ],
  namespaces: ['import', 'from'],
  builtins: [
    'abs', 'all', 'any', 'bool', 'bytes', 'dict', 'enumerate', 'filter', 'float', 'getattr', 'hasattr', 'int',
    'isinstance', 'len', 'list', 'map', 'max', 'min', 'open', 'print', 'range', 'repr', 'reversed', 'set',
    'setattr', 'sorted', 'str', 'sum', 'super', 'tuple', 'type', 'zip', 'self', 'cls',
  ],
  functionAfter: ['def'],
  classAfter: ['class'],
  lineComments: ['#'],
  quotes: ['"""', "'''", '"', "'"],
  decorators: true,
}

const GO: LanguageSpec = {
  keywords: [
    'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go',
    'goto', 'if', 'interface', 'map', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var', 'true',
    'false', 'nil', 'iota',
  ],
  namespaces: ['package', 'import'],
  types: [
    'any', 'bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64', 'int', 'int8', 'int16', 'int32',
    'int64', 'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  ],
  builtins: ['append', 'cap', 'clear', 'close', 'copy', 'delete', 'len', 'make', 'max', 'min', 'new', 'panic', 'print', 'println', 'recover'],
  functionAfter: ['func'],
  lineComments: ['//'],
  blockComment: ['/*', '*/'],
  quotes: ['"', "'", '`'],
}

const RUST: LanguageSpec = {
  keywords: [
    'as', 'async', 'await', 'break', 'const', 'continue', 'dyn', 'else', 'enum', 'false', 'fn', 'for', 'if', 'impl',
    'in', 'let', 'loop', 'match', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super',
    'trait', 'true', 'type', 'unsafe', 'where', 'while',
  ],
  namespaces: ['use', 'mod', 'crate', 'extern'],
  types: [
    'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'f32', 'f64', 'bool',
    'char', 'str', 'String', 'Vec', 'Option', 'Result', 'Box',
  ],
  builtins: ['Some', 'None', 'Ok', 'Err'],
  functionAfter: ['fn'],
  classAfter: ['struct', 'enum', 'trait'],
  lineComments: ['//'],
  blockComment: ['/*', '*/'],
  quotes: ['"'],
}

const SHELL: LanguageSpec = {
  keywords: [
    'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'while', 'until', 'do', 'done', 'in', 'function',
    'select', 'return', 'exit', 'export', 'local', 'readonly', 'declare', 'unset',
  ],
  builtins: [
    'alias', 'awk', 'cat', 'cd', 'cp', 'curl', 'echo', 'eval', 'exec', 'find', 'git', 'grep', 'ls', 'mkdir', 'mv',
    'printf', 'pwd', 'read', 'rm', 'sed', 'set', 'shift', 'source', 'test', 'trap', 'wait',
  ],
  lineComments: ['#'],
  quotes: ['"', "'"],
}

const SQL: LanguageSpec = {
  keywords: [
    'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'drop',
    'alter', 'add', 'index', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by', 'order', 'having',
    'limit', 'offset', 'as', 'and', 'or', 'not', 'null', 'is', 'in', 'like', 'distinct', 'union', 'all', 'case',
    'when', 'then', 'else', 'end', 'primary', 'key', 'foreign', 'references', 'default', 'with', 'returning',
  ],
  types: ['int', 'integer', 'bigint', 'text', 'varchar', 'char', 'boolean', 'date', 'timestamp', 'numeric', 'real', 'serial', 'uuid', 'jsonb'],
  lineComments: ['--'],
  blockComment: ['/*', '*/'],
  quotes: ["'", '"'],
  ignoreCase: true,
}

const JSON_SPEC: LanguageSpec = { keywords: ['true', 'false', 'null'], quotes: ['"'], stringKeys: true }

const YAML: LanguageSpec = {
  keywords: ['true', 'false', 'null', 'yes', 'no', 'on', 'off'],
  lineComments: ['#'],
  quotes: ['"', "'"],
  lineKey: /^(?:- +)?[\w.-]+(?=\s*:(?:\s|$))/,
}

const TOML: LanguageSpec = {
  keywords: ['true', 'false'],
  lineComments: ['#'],
  quotes: ['"""', "'''", '"', "'"],
  lineKey: /^(?:\[\[?[^\]\n]*\]\]?|[\w.-]+(?=\s*=))/,
}

const CSS: LanguageSpec = {
  keywords: ['important', 'inherit', 'initial', 'unset', 'none', 'auto'],
  lineComments: [],
  blockComment: ['/*', '*/'],
  quotes: ['"', "'"],
  lineKey: /^[\w-]+(?=\s*:)/,
}

/** Each fence language and its aliases; unknown ones draw as plain text, as chroma's fallback lexer does. */
export const LEXERS: Record<string, Lexer> = {}

function language(lexer: Lexer, ...names: string[]): void {
  for (const name of names) LEXERS[name] = lexer
}

language(codeLexer(SCRIPT), 'js', 'javascript', 'jsx', 'mjs', 'cjs', 'ts', 'typescript', 'tsx', 'mts', 'cts')
language(codeLexer(PYTHON), 'py', 'python', 'python3')
language(codeLexer(GO), 'go', 'golang')
language(codeLexer(RUST), 'rs', 'rust')
language(codeLexer(SHELL), 'sh', 'bash', 'zsh', 'shell', 'console', 'fish')
language(codeLexer(C_FAMILY), 'c', 'h', 'cpp', 'c++', 'cc', 'hpp', 'java', 'kotlin', 'kt', 'swift', 'cs', 'csharp', 'scala', 'dart')
language(codeLexer(SQL), 'sql', 'postgres', 'postgresql', 'mysql', 'sqlite')
language(codeLexer(JSON_SPEC), 'json', 'jsonc', 'json5')
language(codeLexer(YAML), 'yaml', 'yml')
language(codeLexer(TOML), 'toml', 'ini')
language(codeLexer(CSS), 'css', 'scss', 'less')
language(markup, 'html', 'xml', 'svg', 'vue', 'svelte')
language(diff, 'diff', 'patch')

export function highlight(source: string, languageName: string): Token[] {
  const lexer = LEXERS[languageName.toLowerCase()]
  return lexer === undefined ? [{ text: source, kind: 'text' }] : lexer(source)
}
