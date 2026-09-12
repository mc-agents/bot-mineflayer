/* Colour codes and runs of whitespace, but not the space at either end. */
export function stripCodes(value: string): string {
  return value.replace(/§[0-9a-fk-or]/gi, '').replace(/\s+/g, ' ');
}

export function stripFormatting(value: string): string {
  return value.replace(/§[0-9a-fk-or]/gi, '').replace(/\s+/g, ' ').trim();
}

interface ChatLike {
  text?: unknown;
  extra?: unknown;
  translate?: unknown;
  with?: unknown;
}

interface NbtLike {
  type?: unknown;
  value?: unknown;
}

/*
prismarine hands over a ChatMessage, not the component the server sent. Its instance exposes text
and extra, so the words come out, and keeps everything else -- font, colour, the nesting -- in a
`json` property that nothing else reads. A boss bar built from labels in three different fonts
therefore arrived with no fonts at all, and the font is the thing that says which number is which.
The raw component is right there, so it is what gets walked.
*/
function rawComponent(value: object): unknown {
  const wrapper = value as { json?: unknown };

  return wrapper.json !== null && typeof wrapper.json === 'object' ? wrapper.json : undefined;
}

function isNbt(value: object): value is NbtLike {
  const nbt = value as NbtLike;
  return typeof nbt.type === 'string' && 'value' in nbt;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/*
26.x writes a component whose only field is its text with the empty string as the key -- {"": "x"}
rather than {"text": "x"} -- and the server uses it for whichever pieces it feels like. A reader
that only knows "text" drops those, so an action bar of three pieces arrives as two and nothing
says a piece is missing.
*/
function ownText(node: { text?: unknown; '' ?: unknown }): unknown {
  return node.text ?? node[''];
}

function walk(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    if (!value.startsWith('{') && !value.startsWith('[')) {
      return value;
    }
    const parsed = parseJson(value);
    return typeof parsed === 'string' ? parsed : walk(parsed);
  }

  if (Array.isArray(value)) {
    return value.map(walk).join('');
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  const rawForWalk = rawComponent(value);
  if (rawForWalk !== undefined) {
    return walk(rawForWalk);
  }

  if (isNbt(value)) {
    return walk(value.value);
  }

  const chat = value as ChatLike;
  const own = `${walk(ownText(chat))}${walk(chat.extra)}`;

  return own === '' ? translated(chat) : own;
}

/*
A vanilla window title -- a chest's, a furnace's, a villager's -- is a translate key and not text, so
leaving it alone made read-window answer "container.chest" where the client plainly draws "Chest",
and made a wait-for-window pattern have to be written against a key nobody sees. The other kind of
bot is a Minecraft client and resolves it, which is how the two came to name one window two ways.

The table is minecraft-data's and the bot hands it over once, because this module has no bot. An
unknown key falls back to itself, which is what the client does too.
*/
let translations: Record<string, string> = {};

export function useTranslations(table: Record<string, string> | undefined): void {
  translations = table ?? {};
}

function translated(node: ChatLike): string {
  const key = nbtString(node.translate);

  if (key === undefined) {
    return walk(node.translate);
  }

  const pattern = translations[key];

  if (pattern === undefined) {
    return key;
  }

  return fill(pattern, asArray(node.with).map((argument) => walk(argument)));
}

function asArray(value: unknown): unknown[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (value !== null && typeof value === 'object' && isNbt(value)) {
    return asArray(value.value);
  }
  return Array.isArray(value) ? value : [value];
}

/* Both forms Minecraft's own translations use: %s in order, and %1$s by position. */
function fill(pattern: string, args: string[]): string {
  let next = 0;

  return pattern.replace(/%(?:(\d+)\$)?s/g, (_match, position: string | undefined) => {
    const index = position === undefined ? next++ : Number(position) - 1;

    return args[index] ?? '';
  });
}

export function toPlainText(value: unknown): string {
  return stripFormatting(walk(value));
}

const GLYPHS = /[\uE000-\uF8FF]|[\uDB80-\uDBBF][\uDC00-\uDFFF]/g;

export interface TextSegment {
  text: string;
  font: string | undefined;
  color: string | undefined;
}

interface StyledLike extends ChatLike {
  font?: unknown;
  color?: unknown;
}

function nbtString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (value !== null && typeof value === 'object' && isNbt(value)) {
    return typeof value.value === 'string' ? value.value : undefined;
  }
  return undefined;
}

function collect(value: unknown, inherited: TextSegment, into: TextSegment[]): void {
  if (value === null || value === undefined) {
    return;
  }

  if (typeof value === 'string') {
    if (!value.startsWith('{') && !value.startsWith('[')) {
      into.push({ ...inherited, text: value });
      return;
    }
    const parsed = parseJson(value);
    if (typeof parsed === 'string') {
      into.push({ ...inherited, text: parsed });
      return;
    }
    collect(parsed, inherited, into);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collect(item, inherited, into);
    }
    return;
  }

  if (typeof value !== 'object') {
    into.push({ ...inherited, text: String(value) });
    return;
  }

  const raw = rawComponent(value);
  if (raw !== undefined) {
    collect(raw, inherited, into);
    return;
  }

  if (isNbt(value)) {
    collect(value.value, inherited, into);
    return;
  }

  const node = value as StyledLike;
  const style: TextSegment = {
    text: '',
    font: nbtString(node.font) ?? inherited.font,
    color: nbtString(node.color) ?? inherited.color,
  };

  const own = walk(ownText(node));
  if (own !== '') {
    into.push({ ...style, text: own });
  }

  collect(node.extra, style, into);

  if (own === '' && into.length === 0) {
    const fromKey = translated(node);
    if (fromKey !== '') {
      into.push({ ...style, text: fromKey });
    }
  }
}

/*
Servers draw HUDs by stacking pieces in custom fonts: a bar glyph, a negative-space glyph that
moves the cursor, then a label. Flattening that to one string runs the labels together, so a
health bar and a food bar both reading "20/20" arrive as "20/2020/20". The pieces are kept apart.

Glyph characters live in the Unicode private use area and mean nothing as text, so a piece that
holds only those is dropped.
*/
export function toSegments(value: unknown): TextSegment[] {
  const collected: TextSegment[] = [];
  collect(value, { text: '', font: undefined, color: undefined }, collected);

  /*
  Not trimmed: "Wave " and "Wave" are different pieces. A server that writes a label and a number
  as two components puts the space in one of them, and trimming it makes this bot and the fabric
  one describe a HUD they both read correctly in two different ways. Colour codes and glyphs still
  go, because those are game knowledge and mean nothing as text.
  */
  return collected
    .map((segment) => ({ ...segment, text: stripCodes(segment.text.replace(GLYPHS, '')) }))
    .filter((segment) => segment.text.trim() !== '');
}

/*
How many pieces held nothing but glyphs. On a HUD those are spacers and dropping them is right; on
a display entity a piece made only of glyphs is an icon -- something is there and there is nothing
to read -- which is a different thing from an empty display.
*/
export function glyphPieces(value: unknown): number {
  const collected: TextSegment[] = [];
  collect(value, { text: '', font: undefined, color: undefined }, collected);

  return collected
    .filter((segment) => segment.text.trim() !== '')
    .filter((segment) => stripCodes(segment.text.replace(GLYPHS, '')).trim() === '')
    .length;
}

/*
The component as the server sent it, for mcp-server to flatten itself. prismarine keeps it on the
wrapper it hands over, so this is a pass-through rather than a reconstruction: nothing here has to
be right about fonts, nesting or the shorthand, which is where every bug in this file came from.
*/
export function rawComponentOf(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value ?? null;
  }

  const wrapper = value as { json?: unknown };

  return wrapper.json !== null && typeof wrapper.json === 'object' ? wrapper.json : value;
}

/* The readable pieces joined, for the plain-text field a DTO keeps beside its segments. */
export function plainSegments(segments: TextSegment[]): string {
  return segments.map((segment) => segment.text).join(' ');
}

function shortFont(font: string): string {
  const [, path] = font.split(':', 2);
  return path ?? font;
}

/*
The font name is usually the only thing that says which number is which, so it rides along
whenever the server bothered to set one.
*/
export function describeSegments(segments: TextSegment[]): string {
  return segments
    .map((segment) => (segment.font === undefined ? segment.text : `[${shortFont(segment.font)}] ${segment.text}`))
    .join(' | ');
}
