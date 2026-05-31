// cart.pbt.test.ts — Property Based Testing for cart purity & invariants.
//
// 목적: cart 의 데이터 무결성을 무작위 조작 시퀀스로 검증한다 (data corruption 방어).
//
// 본 파일은 production cart 코드를 변경하지 않고 검증만 한다.
// 임의의 cart 조작 시퀀스 (addItem / updateQuantity / removeItem / updateSize 등)
// 에 대해 다음 invariant 가 유지되는지만 검증.
//
// 검증되는 invariant:
//   1. cart.totalPrice >= 0 (어떤 조작이든)
//   2. cart.totalQuantity >= 0
//   3. cart.totalQuantity = sum(items.quantity)
//   4. cart.totalPrice = sum(items.totalPrice)
//   5. 모든 line item quantity >= 1 (0 이거나 음수면 즉시 제거되어야 함)
//   6. 같은 menuItem + 같은 옵션 = 1 라인만 (병합 규칙)
//   7. lineId 는 카트 내 유일
//   8. clearCart() → items.length === 0
//   9. addItem(quantity <= 0) → 카트 동일 (불변성)

import * as fc from 'fast-check';

import {
  addItem,
  addOption,
  clearCart,
  emptyCart,
  removeItem,
  splitLineBySize,
  updateQuantity,
  updateSize,
  updateTemperature,
} from './cart';
import { MENU_ITEMS } from '../menu/menuData';
import type { Cart, MenuItem, SelectedOptions, Size, Temperature } from '../types';

// ─── 도메인 ──────────────────────────────────────────────────────────────

const ALL_MENU: readonly MenuItem[] = MENU_ITEMS;

const menuArbitrary = fc.constantFrom(...ALL_MENU);
const sizeArbitrary = fc.constantFrom<Size>('regular', 'large');
const temperatureArbitrary = fc.constantFrom<Temperature>('ice', 'hot');
const quantityArbitrary = fc.integer({ min: -3, max: 10 });

// ─── 단일 operation arbitrary ─────────────────────────────────────────────

interface AddOp { kind: 'add'; menu: MenuItem; quantity: number; size: Size; temperature: Temperature; extras: string[] }
interface UpdateQtyOp { kind: 'updateQty'; targetIdx: number; quantity: number }
interface UpdateSizeOp { kind: 'updateSize'; targetIdx: number; size: Size }
interface UpdateTempOp { kind: 'updateTemp'; targetIdx: number; temperature: Temperature }
interface RemoveOp { kind: 'remove'; targetIdx: number }
interface SplitOp { kind: 'split'; targetIdx: number; splitQty: number; newSize: Size }
interface AddOptionOp { kind: 'addOption'; targetIdx: number; option: string }
interface ClearOp { kind: 'clear' }

type CartOp =
  | AddOp
  | UpdateQtyOp
  | UpdateSizeOp
  | UpdateTempOp
  | RemoveOp
  | SplitOp
  | AddOptionOp
  | ClearOp;

const addOpArbitrary: fc.Arbitrary<AddOp> = fc.record({
  kind: fc.constant<'add'>('add'),
  menu: menuArbitrary,
  quantity: quantityArbitrary,
  size: sizeArbitrary,
  temperature: temperatureArbitrary,
  extras: fc.array(fc.constantFrom('extra_shot', 'extra_syrup'), { maxLength: 2 }),
});

const updateQtyOpArbitrary: fc.Arbitrary<UpdateQtyOp> = fc.record({
  kind: fc.constant<'updateQty'>('updateQty'),
  targetIdx: fc.integer({ min: 0, max: 5 }),
  quantity: fc.integer({ min: -2, max: 10 }),
});

const updateSizeOpArbitrary: fc.Arbitrary<UpdateSizeOp> = fc.record({
  kind: fc.constant<'updateSize'>('updateSize'),
  targetIdx: fc.integer({ min: 0, max: 5 }),
  size: sizeArbitrary,
});

const updateTempOpArbitrary: fc.Arbitrary<UpdateTempOp> = fc.record({
  kind: fc.constant<'updateTemp'>('updateTemp'),
  targetIdx: fc.integer({ min: 0, max: 5 }),
  temperature: temperatureArbitrary,
});

const removeOpArbitrary: fc.Arbitrary<RemoveOp> = fc.record({
  kind: fc.constant<'remove'>('remove'),
  targetIdx: fc.integer({ min: 0, max: 5 }),
});

const splitOpArbitrary: fc.Arbitrary<SplitOp> = fc.record({
  kind: fc.constant<'split'>('split'),
  targetIdx: fc.integer({ min: 0, max: 5 }),
  splitQty: fc.integer({ min: 1, max: 5 }),
  newSize: sizeArbitrary,
});

const addOptionOpArbitrary: fc.Arbitrary<AddOptionOp> = fc.record({
  kind: fc.constant<'addOption'>('addOption'),
  targetIdx: fc.integer({ min: 0, max: 5 }),
  option: fc.constantFrom('extra_shot', 'extra_syrup', '얼음 적게'),
});

const clearOpArbitrary: fc.Arbitrary<ClearOp> = fc.record({
  kind: fc.constant<'clear'>('clear'),
});

const opArbitrary: fc.Arbitrary<CartOp> = fc.oneof(
  { weight: 4, arbitrary: addOpArbitrary },
  { weight: 2, arbitrary: updateQtyOpArbitrary },
  { weight: 1, arbitrary: updateSizeOpArbitrary },
  { weight: 1, arbitrary: updateTempOpArbitrary },
  { weight: 2, arbitrary: removeOpArbitrary },
  { weight: 1, arbitrary: splitOpArbitrary },
  { weight: 1, arbitrary: addOptionOpArbitrary },
  { weight: 1, arbitrary: clearOpArbitrary },
);

const opSequenceArbitrary = fc.array(opArbitrary, { minLength: 1, maxLength: 20 });

// ─── operation 적용기 ─────────────────────────────────────────────────────

const buildOptions = (size: Size, temperature: Temperature): SelectedOptions => ({
  size,
  temperature,
});

const applyOp = (cart: Cart, op: CartOp): Cart => {
  switch (op.kind) {
    case 'add': {
      const tempAvail = op.menu.availableTemperatures;
      const sizeAvail = op.menu.availableSizes;
      // 메뉴가 지원하지 않는 온도 = 그 메뉴 default 첫 번째 사용 (또는 무시)
      const temp = tempAvail.includes(op.temperature) ? op.temperature : tempAvail[0];
      const size = sizeAvail.includes(op.size) ? op.size : sizeAvail[0];
      // dessert 같은 메뉴는 temp 없음 — 그 경우 빈 옵션으로
      const options: SelectedOptions = tempAvail.length > 0
        ? buildOptions(size, temp)
        : { size };
      return addItem(cart, op.menu, op.quantity, options, op.extras);
    }
    case 'updateQty': {
      if (cart.items.length === 0) return cart;
      const idx = op.targetIdx % cart.items.length;
      return updateQuantity(cart, cart.items[idx].lineId, op.quantity);
    }
    case 'updateSize': {
      if (cart.items.length === 0) return cart;
      const idx = op.targetIdx % cart.items.length;
      return updateSize(cart, cart.items[idx].lineId, op.size);
    }
    case 'updateTemp': {
      if (cart.items.length === 0) return cart;
      const idx = op.targetIdx % cart.items.length;
      return updateTemperature(cart, cart.items[idx].lineId, op.temperature);
    }
    case 'remove': {
      if (cart.items.length === 0) return cart;
      const idx = op.targetIdx % cart.items.length;
      return removeItem(cart, cart.items[idx].lineId);
    }
    case 'split': {
      if (cart.items.length === 0) return cart;
      const idx = op.targetIdx % cart.items.length;
      return splitLineBySize(cart, cart.items[idx].lineId, op.splitQty, op.newSize);
    }
    case 'addOption': {
      if (cart.items.length === 0) return cart;
      const idx = op.targetIdx % cart.items.length;
      return addOption(cart, cart.items[idx].lineId, op.option);
    }
    case 'clear':
      return clearCart();
  }
};

// ─── invariant 검사 ──────────────────────────────────────────────────────

const checkCartInvariants = (cart: Cart): { ok: boolean; reason?: string } => {
  if (!Array.isArray(cart.items)) return { ok: false, reason: 'items not array' };
  if (typeof cart.totalQuantity !== 'number') return { ok: false, reason: 'totalQuantity not number' };
  if (typeof cart.totalPrice !== 'number') return { ok: false, reason: 'totalPrice not number' };
  if (cart.totalQuantity < 0) return { ok: false, reason: 'negative totalQuantity' };
  if (cart.totalPrice < 0) return { ok: false, reason: 'negative totalPrice' };

  const qtySum = cart.items.reduce((acc, it) => acc + it.quantity, 0);
  if (qtySum !== cart.totalQuantity) {
    return { ok: false, reason: `qtySum=${qtySum} vs totalQuantity=${cart.totalQuantity}` };
  }
  const priceSum = cart.items.reduce((acc, it) => acc + it.totalPrice, 0);
  if (priceSum !== cart.totalPrice) {
    return { ok: false, reason: `priceSum=${priceSum} vs totalPrice=${cart.totalPrice}` };
  }
  if (cart.items.some((it) => it.quantity <= 0)) {
    return { ok: false, reason: 'line item quantity <= 0' };
  }
  if (cart.items.some((it) => it.totalPrice < 0)) {
    return { ok: false, reason: 'line item totalPrice < 0' };
  }

  // lineId 중복 검사
  const lineIds = cart.items.map((it) => it.lineId);
  if (new Set(lineIds).size !== lineIds.length) {
    return { ok: false, reason: 'duplicate lineIds' };
  }
  return { ok: true };
};

// ─── tests ───────────────────────────────────────────────────────────────

describe('PBT: cart 무결성 invariant', () => {
  test('어떤 단일 operation 도 cart invariant 유지', () => {
    fc.assert(
      fc.property(opArbitrary, (op) => {
        const cart0 = emptyCart();
        const cart1 = applyOp(cart0, op);
        return checkCartInvariants(cart1).ok;
      }),
      { numRuns: 1000 },
    );
  });

  test('어떤 operation 시퀀스도 cart invariant 유지', () => {
    fc.assert(
      fc.property(opSequenceArbitrary, (ops) => {
        let cart = emptyCart();
        for (const op of ops) {
          cart = applyOp(cart, op);
          const inv = checkCartInvariants(cart);
          if (!inv.ok) {
            return false;
          }
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });

  test('addItem(quantity <= 0) → 카트 동일 (불변성)', () => {
    fc.assert(
      fc.property(
        menuArbitrary,
        fc.integer({ min: -10, max: 0 }),
        sizeArbitrary,
        temperatureArbitrary,
        (menu, qty, size, temp) => {
          const cart0 = emptyCart();
          const tempAvail = menu.availableTemperatures;
          const t = tempAvail.includes(temp) ? temp : tempAvail[0];
          const opts: SelectedOptions = tempAvail.length > 0 ? { size, temperature: t } : { size };
          const cart1 = addItem(cart0, menu, qty, opts);
          return cart1 === cart0; // 변경 없음 → 동일 참조
        },
      ),
      { numRuns: 500 },
    );
  });

  test('clearCart 후 items.length === 0', () => {
    fc.assert(
      fc.property(opSequenceArbitrary, (ops) => {
        let cart = emptyCart();
        for (const op of ops) {
          cart = applyOp(cart, op);
        }
        const cleared = clearCart();
        return cleared.items.length === 0 &&
          cleared.totalQuantity === 0 &&
          cleared.totalPrice === 0;
      }),
      { numRuns: 200 },
    );
  });

  test('같은 menuItem + 같은 옵션 추가는 1 라인으로 병합 (수량 합산)', () => {
    fc.assert(
      fc.property(
        menuArbitrary,
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        sizeArbitrary,
        temperatureArbitrary,
        (menu, q1, q2, size, temp) => {
          const tempAvail = menu.availableTemperatures;
          const sizeAvail = menu.availableSizes;
          if (tempAvail.length === 0 || sizeAvail.length === 0) return true; // skip
          const t = tempAvail.includes(temp) ? temp : tempAvail[0];
          const s = sizeAvail.includes(size) ? size : sizeAvail[0];
          const opts: SelectedOptions = { size: s, temperature: t };

          let cart = emptyCart();
          cart = addItem(cart, menu, q1, opts, []);
          cart = addItem(cart, menu, q2, opts, []);

          // 정확히 1 라인 + quantity 합 = q1+q2
          if (cart.items.length !== 1) return false;
          if (cart.items[0].quantity !== q1 + q2) return false;
          return cart.totalQuantity === q1 + q2;
        },
      ),
      { numRuns: 500 },
    );
  });
});
