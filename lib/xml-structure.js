const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 20000;

const isNameStart = c => !!c && /[A-Za-z_]/.test(c);
const isNameChar = c => !!c && /[A-Za-z0-9_.:-]/.test(c);
const isSpace = c => c === ' ' || c === '\t' || c === '\r' || c === '\n';

function readName(text, at) {
  if (!isNameStart(text[at])) throw new Error('Malformed XML name');
  let end = at + 1;
  while (end < text.length && isNameChar(text[end])) end++;
  return { name: text.slice(at, end), end };
}

function readTag(text, start) {
  let end = start + 1; let quote = '';
  for (; end < text.length; end++) {
    const c = text[end];
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') break;
  }
  if (end >= text.length || quote) throw new Error('Unclosed XML tag');
  let p = start + 1; const closing = text[p] === '/'; if (closing) p++;
  if(isSpace(text[p]))throw new Error('Whitespace before XML name');
  const parsed = readName(text, p); p = parsed.end;
  const attrs = Object.create(null);
  if (!closing) {
    for (;;) {
      const separated=isSpace(text[p]);
      while (isSpace(text[p])) p++;
      if (text[p] === '/' || p >= end) break;
      if(!separated)throw new Error('XML attributes require whitespace');
      const attr = readName(text, p); p = attr.end;
      while (isSpace(text[p])) p++;
      if (text[p] !== '=') throw new Error('XML attribute requires quoted value');
      p++; while (isSpace(text[p])) p++;
      const q = text[p]; if (q !== '"' && q !== "'") throw new Error('XML attribute requires quoted value');
      p++; const valueStart = p;
      while (p < end && text[p] !== q) { if (text[p] === '<') throw new Error('XML attribute contains bare <'); p++; }
      if (p >= end) throw new Error('Unclosed XML attribute');
      if (Object.prototype.hasOwnProperty.call(attrs, attr.name)) throw new Error('Duplicate XML attribute');
      attrs[attr.name] = text.slice(valueStart, p); p++;
    }
  }
  while (isSpace(text[p])) p++;
  const selfClosing = !closing && text[p] === '/';
  if (closing && p !== end) throw new Error('Malformed XML closing tag');
  if (!closing && selfClosing && p + 1 !== end) throw new Error('Malformed XML self-closing tag');
  if (!closing && !selfClosing && p !== end) throw new Error('Malformed XML tag');
  return { name: parsed.name, attrs, closing, selfClosing, end };
}

function scan(text) {
  const stack = []; let root = null; let rootClosed = false; let nodes = 0; let i = 0;
  while (i < text.length) {
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4); if (end < 0) throw new Error('Unclosed XML comment'); i = end + 3; continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      if (!stack.length) throw new Error('CDATA outside XML root');
      const end = text.indexOf(']]>', i + 9); if (end < 0) throw new Error('Unclosed CDATA');
      stack[stack.length - 1].text.push(text.slice(i + 9, end)); i = end + 3; continue;
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2); if (end < 0) throw new Error('Unclosed processing instruction');
      if (!stack.length && root) { rootClosed = true; }
      i = end + 2; continue;
    }
    if (text[i] !== '<') {
      let end = text.indexOf('<', i); if (end < 0) end = text.length;
      const value = text.slice(i, end);
      if (!stack.length) { if (value.trim()) throw new Error('Text outside XML root'); }
      else stack[stack.length - 1].text.push(value);
      i = end; continue;
    }
    if (text.startsWith('<!', i)) throw new Error('DTD/entity declarations rejected');
    const token = readTag(text, i); const lower = token.name.toLowerCase();
    if (token.closing) {
      if (!stack.length || stack[stack.length - 1].name !== token.name) throw new Error('Mismatched XML closing tag');
      const node = stack.pop(); node.contentEnd = i;
      if (!stack.length) rootClosed = true;
      if (lower === 'channel') node.channel = true;
      i = token.end + 1; continue;
    }
    const node = { name: token.name, attrs: token.attrs, children: [], text: [], start: i, contentStart: token.end + 1, contentEnd: token.end + 1 };
    if (!stack.length) {
      if (root) throw new Error('XML document must have one root');
      root = node;
    } else stack[stack.length - 1].children.push(node);
    if (++nodes > MAX_NODES) throw new Error('XML node limit exceeded');
    if (!token.selfClosing) {
      if (stack.length >= MAX_DEPTH) throw new Error('XML nesting depth exceeded');
      stack.push(node);
    } else if (!stack.length) rootClosed = true;
    i = token.end + 1;
  }
  if (!root || !rootClosed || stack.length) throw new Error('Unclosed XML root');
  return root;
}

export function validateXmlDocument(text, options = {}) {
  const value = String(text ?? '');
  if (Buffer.byteLength(value, 'utf8') > MAX_BODY_BYTES) throw new Error('XML body exceeds 2 MiB limit');
  const normalized = value.replace(/^\uFEFF/, '').trim();
  const documentText = normalized.replace(/^<\?xml\b[\s\S]*?\?>\s*/i, '');
  const tree = scan(documentText);
  return options.tree ? tree : undefined;
}
