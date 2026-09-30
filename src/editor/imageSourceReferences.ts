/**
 * Source-preserving image reference spans for lookup and rename. This scans
 * supported inline Markdown images and quoted HTML img sources, excluding
 * Markdown code and comments. It never rewrites dimensions, titles or prose.
 */
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

const markdown = new MarkdownIt({ html: true });

interface ImageSourceSpan {
  start: number;
  end: number;
  syntaxEnd: number;
}

/** Locate the rich parser's narrow space-path exceptions in authored lines. */
function spacePathSpan(
  content: string,
  authoredLine: string,
  lineStart: number,
  indented: boolean
): { imageStart: number; span: ImageSourceSpan } | null {
  const candidate = content.trim();
  if (candidate.includes('\n')) return null;
  // These grammars mirror SpaceFriendlyImagePaths and IndentedImageCodeBlock:
  // only the latter accepts a title alongside an unescaped space-containing path.
  const match = indented
    ? /^(!\[[^\]]*\]\(\s*)(<[^>]+>|[^)]+?)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)\s*$/.exec(candidate)
    : /^(!\[[^\]]*\]\(\s*)([^)]*?\s+[^)]*?)\s*\)\s*$/.exec(candidate);
  if (!match || (!indented && /["']/.test(match[2]))) return null;
  const rawDestination = match[2];
  const trimmed = rawDestination.trim();
  const angleWrapped = trimmed.startsWith('<') && trimmed.endsWith('>');
  const destination = angleWrapped ? trimmed.slice(1, -1) : trimmed;
  if (!/\s/.test(destination)) return null;
  const offset = authoredLine.indexOf(candidate);
  if (offset < 0) return null;
  const imageStart = lineStart + offset;
  const start =
    imageStart + match[1].length + rawDestination.indexOf(trimmed) + (angleWrapped ? 1 : 0);
  return {
    imageStart,
    span: { start, end: start + destination.length, syntaxEnd: imageStart + candidate.length },
  };
}

/** Match the image-only indented block exception supported by the rich parser. */
function isRenderedIndentedImages(content: string): boolean {
  const lines = content.split('\n').filter(line => line.trim().length > 0);
  return (
    lines.length > 0 &&
    lines.every(line => {
      const trimmed = line.trim();
      if (
        /^!\[([^\]]*)\]\(\s*(<[^>]+>|[^)]+?)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)\s*$/.test(trimmed)
      )
        return true;
      if (!/^<img\b(?:[^>"']|"[^"]*"|'[^']*')*>\s*$/i.test(trimmed)) return false;
      // Trimming removes code indentation, so this recursive call scans one HTML
      // tag and cannot re-enter the indented-block exception.
      return findImageSourceReferences(trimmed).length === 1;
    })
  );
}

export interface ImageSourceReference {
  /** Character offsets covering only the authored image source. */
  start: number;
  end: number;
  /** Exact filename range, excluding the directory and URL suffix. */
  filenameStart: number;
  /** Filename start when raw URL delimiters belong to a legacy filename. */
  literalFilenameStart: number;
  pathEnd: number;
  /** Source after Markdown escapes/HTML entities, before URL decoding. */
  source: string;
}

/** Map decoded source characters back to authored escape/entity positions. */
function decodeImageSource(raw: string): { source: string; offsets: number[] } {
  const encoded = /\\.|&(?:#x[\da-f]+|#\d+|[a-z][a-z\d]*);/gi;
  const offsets: number[] = [];
  let decoded = '';
  let index = 0;
  for (const match of raw.matchAll(encoded)) {
    const start = match.index!;
    for (; index < start; index++) {
      offsets.push(index);
      decoded += raw[index];
    }
    const value = markdown.utils.unescapeAll(match[0]);
    for (let character = 0; character < value.length; character++) {
      offsets.push(value === match[0] ? start + character : start);
    }
    decoded += value;
    index = start + match[0].length;
  }
  for (; index < raw.length; index++) {
    offsets.push(index);
    decoded += raw[index];
  }
  offsets.push(raw.length);
  return { source: decoded, offsets };
}

/**
 * Index balanced brackets and HTML tag endings in linear passes. Malformed
 * openers must not rescan the remaining document on each failed match (I4).
 */
function indexImageDelimiters(source: string): {
  brackets: Map<number, number>;
  tagEnds: Int32Array;
} {
  const brackets = new Map<number, number>();
  const stack: number[] = [];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\\') index++;
    else if (source[index] === '[') stack.push(index);
    else if (source[index] === ']') {
      const open = stack.pop();
      if (open !== undefined) brackets.set(open, index);
    }
  }
  const tagEnds = new Int32Array(source.length + 1);
  let singleQuote = -1;
  let doubleQuote = -1;
  for (let index = source.length - 1; index >= 0; index--) {
    const character = source[index];
    if (character === '>') tagEnds[index] = index + 1;
    else if (character === '"') {
      tagEnds[index] = doubleQuote < 0 ? 0 : tagEnds[doubleQuote + 1];
      doubleQuote = index;
    } else if (character === "'") {
      tagEnds[index] = singleQuote < 0 ? 0 : tagEnds[singleQuote + 1];
      singleQuote = index;
    } else if (character !== '<') tagEnds[index] = tagEnds[index + 1];
  }
  return { brackets, tagEnds };
}

/** Return exact source spans for supported images, excluding code examples. */
export function findImageSourceReferences(source: string): ImageSourceReference[] {
  const { brackets, tagEnds } = indexImageDelimiters(source);
  const lineStarts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') lineStarts.push(index + 1);
  }
  // Only block maps and inline source are used below. Parsing inline children
  // repeats delimiter work and is costly on long runs of unmatched brackets.
  const tokens: Token[] = [];
  markdown.block.parse(source, markdown, {}, tokens);
  const spacePaths = new Map<number, ImageSourceSpan>();
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex];
    if (!token.map) continue;
    const indented = token.type === 'code_block' && isRenderedIndentedImages(token.content);
    const paragraph =
      token.type === 'inline' &&
      tokens[tokenIndex - 1]?.type === 'paragraph_open' &&
      // Tight list items parse their text inline and never invoke the rich
      // editor's standalone-paragraph space-path fallback.
      !tokens[tokenIndex - 1].hidden;
    if (!indented && !paragraph) continue;
    const lines = indented ? token.content.split('\n') : [token.content];
    lines.forEach((content, offset) => {
      const line = token.map![0] + offset;
      if (line >= token.map![1]) return;
      const lineStart = lineStarts[line];
      const authoredLine = source.slice(lineStart, lineStarts[line + 1] ?? source.length);
      const candidate = spacePathSpan(content, authoredLine, lineStart, indented);
      if (candidate) spacePaths.set(candidate.imageStart, candidate.span);
    });
  }
  const excluded = tokens
    .filter(
      token =>
        token.map &&
        (token.type === 'fence' ||
          (token.type === 'code_block' && !isRenderedIndentedImages(token.content)))
    )
    .map(token => ({
      start: lineStarts[token.map![0]],
      end: lineStarts[token.map![1]] ?? source.length,
    }));
  const results: ImageSourceReference[] = [];
  let exclusionIndex = 0;
  let index = 0;
  const add = (start: number, end: number): void => {
    if (end <= start) return;
    const decoded = decodeImageSource(source.slice(start, end));
    const suffix = decoded.source.search(/[?#]/);
    const pathEnd = suffix < 0 ? decoded.source.length : suffix;
    const pathname = decoded.source.slice(0, pathEnd);
    const separator = Math.max(pathname.lastIndexOf('/'), pathname.lastIndexOf('\\'));
    results.push({
      start,
      end,
      source: decoded.source,
      filenameStart: start + decoded.offsets[separator + 1],
      literalFilenameStart:
        start +
        decoded.offsets[
          Math.max(decoded.source.lastIndexOf('/'), decoded.source.lastIndexOf('\\')) + 1
        ],
      pathEnd: start + decoded.offsets[pathEnd],
    });
  };

  while (index < source.length) {
    while (excluded[exclusionIndex]?.end <= index) exclusionIndex++;
    const exclusion = excluded[exclusionIndex];
    if (exclusion && index >= exclusion.start) {
      index = exclusion.end;
      continue;
    }
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source.startsWith('<!--', index)) {
      const close = source.indexOf('-->', index + 4);
      index = close < 0 ? source.length : close + 3;
      continue;
    }
    if (source[index] === '`') {
      let end = index + 1;
      while (source[end] === '`') end++;
      const delimiter = source.slice(index, end);
      let close = source.indexOf(delimiter, end);
      while (
        close >= 0 &&
        (source[close - 1] === '`' || source[close + delimiter.length] === '`')
      ) {
        close = source.indexOf(delimiter, close + delimiter.length);
      }
      index = close < 0 ? end : close + delimiter.length;
      continue;
    }
    if (source[index] === '<') {
      const tagEnd = tagEnds[index + 1];
      const tag =
        tagEnd > 0
          ? /^<([a-z][a-z0-9:-]*)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/i.exec(source.slice(index, tagEnd))
          : null;
      if (tag) {
        const name = tag[1].toLowerCase();
        if (name === 'img') {
          // Consume complete attributes so text inside alt/title cannot masquerade as src.
          const attributes = /\s+([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
          let attribute: RegExpExecArray | null;
          while ((attribute = attributes.exec(tag[0])) !== null) {
            if (attribute[1].toLowerCase() !== 'src') continue;
            const value = attribute[2];
            if (value && (value[0] === '"' || value[0] === "'")) {
              const start = index + attribute.index + attribute[0].indexOf(value) + 1;
              add(start, start + value.length - 2);
            }
            break;
          }
        }
        index += tag[0].length;
        if (['script', 'style', 'textarea', 'pre'].includes(name)) {
          const close = new RegExp(`</${name}\\s*>`, 'ig');
          close.lastIndex = index;
          const match = close.exec(source);
          index = match ? close.lastIndex : source.length;
        }
        continue;
      }
    }
    if (!source.startsWith('![', index)) {
      index++;
      continue;
    }
    const spacePath = spacePaths.get(index);
    if (spacePath) {
      add(spacePath.start, spacePath.end);
      index = spacePath.syntaxEnd;
      continue;
    }
    const labelEnd = brackets.get(index + 1);
    let cursor = labelEnd === undefined ? source.length : labelEnd + 1;
    let depth = 0;
    if (source[cursor] !== '(') {
      index++;
      continue;
    }
    cursor++;
    while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++;
    let start = cursor;
    let end = cursor;
    if (source[cursor] === '<') {
      start = ++cursor;
      while (cursor < source.length && source[cursor] !== '>' && source[cursor] !== '\n') {
        cursor += source[cursor] === '\\' ? 2 : 1;
      }
      if (source[cursor] !== '>') {
        index++;
        continue;
      }
      end = cursor++;
    } else {
      depth = 0;
      while (cursor < source.length) {
        const char = source[cursor];
        if (char === '\\') {
          cursor += 2;
          continue;
        }
        if (char === '(') depth++;
        if (char === ')') {
          if (depth === 0) break;
          depth--;
        }
        if (/\s/.test(char)) break;
        cursor++;
      }
      end = cursor;
    }
    // Accept only a closing parenthesis or a supported optional Markdown title.
    const ending = /^\s*(?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))\s*)?\)/.exec(
      source.slice(cursor)
    );
    if (!ending) {
      index++;
      continue;
    }
    add(start, end);
    index = cursor + ending[0].length;
  }
  return results;
}
