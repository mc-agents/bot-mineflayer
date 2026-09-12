import assert from 'node:assert/strict';
import test from 'node:test';
import { describeSegments, stripFormatting, toPlainText, toSegments, useTranslations } from '../src/minecraft/text.ts';

test('plain strings come back trimmed and without colour codes', () => {
  assert.equal(toPlainText('Village Shop'), 'Village Shop');
  assert.equal(toPlainText('§6Shop  §lButton '), 'Shop Button');
  assert.equal(toPlainText(''), '');
  assert.equal(toPlainText(null), '');
  assert.equal(toPlainText(undefined), '');
});

test('the NBT shape the server actually sends is unwrapped', () => {
  assert.equal(
    toPlainText({
      type: 'compound',
      value: {
        color: { type: 'string', value: 'gold' },
        text: { type: 'string', value: 'Shop Button' },
      },
    }),
    'Shop Button',
  );
  assert.equal(toPlainText({ type: 'string', value: 'Click to buy' }), 'Click to buy');
});

test('a translate key is resolved once the table is there, and falls back to itself when it is not', () => {
  const chest = { type: 'compound', value: { translate: { type: 'string', value: 'container.chest' } } };

  useTranslations(undefined);
  assert.equal(toPlainText(chest), 'container.chest');

  useTranslations({ 'container.chest': 'Chest' });
  assert.equal(toPlainText(chest), 'Chest');
  assert.equal(toPlainText({ translate: 'nothing.knows.this' }), 'nothing.knows.this');
});

/*
The arguments a key takes are how a vanilla chat line is built, and a window title that names its
owner uses the same shape. Both forms Minecraft's own translations use are asserted.
*/
test('translation arguments are filled in order and by position', () => {
  useTranslations({ 'chat.type.text': '<%s> %s', 'reversed': '%2$s then %1$s' });

  assert.equal(toPlainText({ translate: 'chat.type.text', with: [{ text: 'Steve' }, { text: 'hello' }] }),
    '<Steve> hello');
  assert.equal(toPlainText({ translate: 'reversed', with: [{ text: 'one' }, { text: 'two' }] }),
    'two then one');
});

test('plain chat components and their extra parts are joined', () => {
  assert.equal(toPlainText({ text: 'Test', extra: [{ text: 'Server' }, { text: ' dev' }] }), 'TestServer dev');
  assert.equal(toPlainText([{ text: 'a' }, { text: 'b' }]), 'ab');
});

test('a JSON string is parsed before being walked', () => {
  assert.equal(toPlainText('{"text":"Auction House"}'), 'Auction House');
  assert.equal(toPlainText('{not json'), '{not json');
});

test('stripFormatting collapses whitespace so lore lines stay one line', () => {
  assert.equal(stripFormatting('  Costs   10   coins '), 'Costs 10 coins');
});

function nbtString(value: string): unknown {
  return { type: 'string', value };
}

function nbtList(values: unknown[]): unknown {
  return { type: 'list', value: { type: 'compound', value: values } };
}

const HUD_ACTION_BAR = {
  type: 'compound',
  value: {
    extra: nbtList([
      { font: nbtString('server:space'), text: nbtString('') },
      {
        extra: nbtList([
          { font: nbtString('server:hud/bars'), text: nbtString('') },
          { font: nbtString('server:hud/bars_text'), text: nbtString('20/20') },
        ]),
        text: nbtString(''),
      },
      { font: nbtString('server:hud/bars_text'), text: nbtString('18/20') },
      { font: nbtString('server:hud/money_text'), color: nbtString('#F04A46'), text: nbtString('1,250') },
    ]),
    text: nbtString(''),
  },
};

test('a HUD drawn in custom fonts keeps its labels apart instead of running them together', () => {
  const segments = toSegments(HUD_ACTION_BAR);

  assert.deepEqual(segments.map((segment) => segment.text), ['20/20', '18/20', '1,250']);
  assert.deepEqual(segments.map((segment) => segment.font), [
    'server:hud/bars_text',
    'server:hud/bars_text',
    'server:hud/money_text',
  ]);
  assert.equal(segments[2]?.color, '#F04A46');
});

test('the flattened form is exactly the ambiguity this replaces', () => {
  assert.match(toPlainText(HUD_ACTION_BAR), /20\/2018\/20/);
  assert.equal(
    describeSegments(toSegments(HUD_ACTION_BAR)),
    '[hud/bars_text] 20/20 | [hud/bars_text] 18/20 | [hud/money_text] 1,250',
  );
});

test('a piece that is nothing but glyphs carries no text and is dropped', () => {
  assert.deepEqual(toSegments({ text: '', font: 'server:space' }), []);
  assert.deepEqual(toSegments({ text: '󰀀' }), []);
});

test('a child keeps the font its parent set until it sets its own', () => {
  const segments = toSegments({
    font: 'server:panel',
    extra: [{ text: 'inherited' }, { font: 'server:other', text: 'own' }],
  });

  assert.deepEqual(segments.map((segment) => [segment.text, segment.font]), [
    ['inherited', 'server:panel'],
    ['own', 'server:other'],
  ]);
});

test('plain chat with no styling stays a single unadorned segment', () => {
  assert.deepEqual(toSegments('hello'), [{ text: 'hello', font: undefined, color: undefined }]);
  assert.equal(describeSegments(toSegments('hello')), 'hello');
});

/*
26.x writes a component whose only field is its text with the empty string as the key. Paper uses
it for whichever pieces it feels like: an action bar of three sent as JSON arrived as
{"text":"uno", extra:[{color:"red","text":"dos"},{"":"tres"}]}, and a reader that only knows
"text" dropped the third without saying so.
*/
test('a component that names its text with the empty key is read', () => {
  assert.equal(toPlainText({ '': 'tres' }), 'tres');
  assert.equal(toPlainText({ text: 'uno', extra: [{ color: 'red', text: 'dos' }, { '': 'tres' }] }), 'unodostres');

  assert.deepEqual(
    toSegments({ text: 'uno', extra: [{ color: 'red', text: 'dos' }, { '': 'tres' }] })
      .map((segment) => segment.text),
    ['uno', 'dos', 'tres'],
  );
});

/* text wins when both are there, because that is the field the component actually declares. */
test('an explicit text field is preferred to the empty key', () => {
  assert.equal(toPlainText({ text: 'named', '': 'shorthand' }), 'named');
});

/*
prismarine hands over a ChatMessage rather than the component the server sent: the instance exposes
text and extra and keeps font and colour in a `json` property. Walking the instance got the words
and lost the fonts, and a real server's boss bar -- three labels in three fonts -- came back with
none. The raw component is what carries the style.
*/
test('the raw component inside a prismarine wrapper is what is read', () => {
  const wrapper = {
    json: {
      text: '',
      extra: [
        { text: 'Somewhere', font: 'hyperfarm:hud/boss_text' },
        { text: 'Winter', font: 'hyperfarm:hud/clock_text' },
      ],
    },
    text: '',
    extra: [{ text: 'Somewhere' }, { text: 'Winter' }],
  };

  assert.deepEqual(toSegments(wrapper).map((piece) => [piece.text, piece.font]), [
    ['Somewhere', 'hyperfarm:hud/boss_text'],
    ['Winter', 'hyperfarm:hud/clock_text'],
  ]);
  assert.equal(toPlainText(wrapper), 'SomewhereWinter');
});
