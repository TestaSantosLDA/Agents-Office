/**
 * The mailbox (Agent Office): every mailbox in the layout shows its "on" state
 * while a task is unseen, and a click on its tiles opens the tasks. This is
 * the OfficeState half; the light is decoration, the state change is instant.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeAll, test } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

type CatalogAsset = LoadedAssetData['catalog'][number];

const mailbox = (id: string, extra: Partial<CatalogAsset>): CatalogAsset => ({
  id,
  label: id,
  category: 'misc',
  width: 16,
  height: 32,
  footprintW: 1,
  footprintH: 2,
  isDesk: false,
  groupId: 'MAILBOX',
  orientation: 'front',
  ...extra,
});

beforeAll(() => {
  const catalog = [
    mailbox('MAILBOX_FRONT_OFF', { state: 'off' }),
    mailbox('MAILBOX_FRONT_ON_1', { state: 'on', animationGroup: 'MAILBOX_FRONT_ON', frame: 0 }),
    mailbox('MAILBOX_FRONT_ON_2', { state: 'on', animationGroup: 'MAILBOX_FRONT_ON', frame: 1 }),
  ];
  const sprites = Object.fromEntries(catalog.map((a) => [a.id, [['']]]));
  assert.ok(buildDynamicCatalog({ catalog, sprites }));
});

function layout(): OfficeLayout {
  return {
    version: 1,
    cols: 6,
    rows: 6,
    tiles: new Array<TileType>(36).fill(TileType.FLOOR_1),
    furniture: [{ uid: 'mb', type: 'MAILBOX_FRONT_OFF', col: 2, row: 1 }],
  };
}

const shownType = (os: OfficeState) => os.furniture[0]?.sprite;

test('lights while a task is unseen and goes dark when all are seen', () => {
  const os = new OfficeState(layout());
  const off = shownType(os);
  os.setMailboxLit(true);
  assert.notEqual(shownType(os), off, 'on sprite shown');
  os.setMailboxLit(false);
  assert.equal(shownType(os), off, 'back to off');
});

test('a click on any of its tiles is a mailbox click', () => {
  const os = new OfficeState(layout());
  assert.equal(os.isMailboxAt(2, 1), true);
  assert.equal(os.isMailboxAt(2, 2), true);
  assert.equal(os.isMailboxAt(3, 1), false);
});
