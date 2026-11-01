import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSlug, pickName } from './variant-ops.js';

const letters = [...'abcdefghijklmnopqrstuvwxyz'];
for (const [slugs, opts, expected] of [
  [['default'], undefined, 'a'],
  [['default', 'a', 'b'], undefined, 'c'],
  [[...letters, 'v1', 'v3'], undefined, 'v2'],
  [['a'], { random: true, rng: () => 0 }, 'b'],
  [['a'], { random: true, rng: () => 0.9999 }, 'z'],
  [letters, { random: true, rng: () => 0.9999 }, 'v20'],
]) test(`pickSlug chooses ${expected} from ${slugs}`, () => assert.equal(pickSlug(slugs, opts), expected));

for (const [source, names, expected] of [
  [{ variant_name: 'Default', variant_slug: 'default', is_default: true }, [], 'הדף הראשי – עותק'],
  [{ variant_name: 'גרסה מקורית', variant_slug: 'default', is_default: true }, [], 'גרסה מקורית – עותק'],
  [{ variant_name: null, variant_slug: 'b', is_default: false }, [], 'b – עותק'],
  [{ variant_name: null, variant_slug: 'b', is_default: false }, ['b – עותק'], 'b – עותק 2'],
]) test(`pickName chooses ${expected}`, () => assert.equal(pickName(source, names), expected));

test('pickName truncates the base, preserving the suffix', () => {
  const name = pickName({ variant_name: 'א'.repeat(60) }, []);
  assert.ok(name.length <= 40);
  assert.ok(name.endsWith(' – עותק'));
});
