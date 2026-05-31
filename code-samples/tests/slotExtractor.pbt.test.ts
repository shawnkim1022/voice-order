// slotExtractor.pbt.test.ts — Property Based Testing for slot extraction.
//
// 목적: 명시적 jest 케이스만으로 놓치기 쉬운 회귀(특히 multi-turn)를,
//       fast-check 로 1,000+ 무작위 발화 시퀀스를 생성해 사전 차단한다.
//
// 본 파일은 production NLU 코드를 변경하지 않고 검증만 한다.
// extractSlots 의 반환값에 대해 type / value 도메인 invariant 만 검증한다.
//
// 검증되는 invariant (각 1,000 runs):
//   1. quantity 도메인: null 또는 양의 정수
//   2. size 도메인: null | 'regular' | 'large'
//   3. temperature 도메인: null | 'ice' | 'hot' | 'both'
//   4. lineItems quantity 도메인: null 또는 양의 정수
//   5. lineItems size 도메인: null | 'regular' | 'large'
//   6. lineItems temperature 도메인: null | 'ice' | 'hot' | 'both'
//   7. rawText 보존: 추출 결과 rawText === 입력 그대로
//   8. lineItems 의 menuItem 은 항상 MENU_ITEMS 카탈로그에 존재
//
// 한국어 음절 / 메뉴 키워드 / digit / whitespace 를 임의 조합해 발화를 생성한다.

import * as fc from 'fast-check';

import { extractSlots } from './slotExtractor';
import { MENU_ITEMS } from '../menu/menuData';

// ─── 도메인 상수 ─────────────────────────────────────────────────────────────

const VALID_SIZES = new Set([null, 'regular', 'large']);
const VALID_TEMPERATURES = new Set([null, 'ice', 'hot', 'both']);

// 카탈로그에 등록된 menuId 집합 (lineItems.menuItem.id invariant 검증용).
const VALID_MENU_IDS = new Set(MENU_ITEMS.map((m) => m.id));

// ─── 발화 생성기 ─────────────────────────────────────────────────────────────
//
// 실제 사용자 발화에 가까운 분포를 만들기 위해 다음 4 종을 무작위 조합한다.
//   - 메뉴 토큰 (카탈로그 메뉴명 + alias 일부)
//   - 수량 한국어 단어 / 숫자
//   - 사이즈/온도 키워드
//   - 잡음 한국어 음절
//
// 너무 큰 발화는 빠른 속도 위해 길이 ≤ 80 자로 제한.

const MENU_TOKENS: readonly string[] = MENU_ITEMS.flatMap((m) => [
  m.name,
  ...m.aliases.slice(0, 3),
]).filter((s) => s.length > 0);

const QUANTITY_TOKENS: readonly string[] = [
  '하나', '한 잔', '한 개', '둘', '두 잔', '두 개',
  '셋', '세 잔', '세 개', '넷', '네 잔', '네 개', '다섯', '다섯 잔',
  '1', '2', '3', '4', '5', '10',
];

const SIZE_TOKENS: readonly string[] = [
  '레귤러', '라지', '큰 거', '작은 거', 'regular', 'large',
];

const TEMP_TOKENS: readonly string[] = [
  '아이스', '뜨거운', '따뜻한', '시원한', '핫', '아아', '뜨아',
];

const NOISE_TOKENS: readonly string[] = [
  '주세요', '좀', '으로', '로', '랑', '하고', '그리고', '말고', '아니고',
  '저기', '음', '어', '그', '이걸로',
];

// 한국어 음절 + 알파벳 + digit + 공백 + 일부 구두점.
// 너무 좁으면 fuzzer 가 invariant 빈 영역만 탐색하므로 의도적으로 다양화.
const krSyllable = fc.integer({ min: 0xac00, max: 0xd7a3 }).map((cp) => String.fromCodePoint(cp));

const tokenArbitrary = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...MENU_TOKENS) },
  { weight: 3, arbitrary: fc.constantFrom(...QUANTITY_TOKENS) },
  { weight: 2, arbitrary: fc.constantFrom(...SIZE_TOKENS) },
  { weight: 2, arbitrary: fc.constantFrom(...TEMP_TOKENS) },
  { weight: 2, arbitrary: fc.constantFrom(...NOISE_TOKENS) },
  { weight: 1, arbitrary: krSyllable },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 4 }) },
);

const utteranceArbitrary = fc
  .array(tokenArbitrary, { minLength: 1, maxLength: 8 })
  .map((tokens) => tokens.join(' ').slice(0, 80));

// ─── 1. global quantity 도메인 ───────────────────────────────────────────────

describe('PBT: slotExtractor 도메인 invariant', () => {
  test('어떤 발화든 globalSlots.quantity 는 null 또는 양의 정수', () => {
    fc.assert(
      fc.property(utteranceArbitrary, (utterance) => {
        const result = extractSlots(utterance);
        const q = result.globalSlots.quantity;
        if (q === null) return true;
        return Number.isInteger(q) && q >= 1;
      }),
      { numRuns: 1000 },
    );
  });

  test('어떤 발화든 globalSlots.size 는 null/regular/large', () => {
    fc.assert(
      fc.property(utteranceArbitrary, (utterance) => {
        const result = extractSlots(utterance);
        return VALID_SIZES.has(result.globalSlots.size);
      }),
      { numRuns: 1000 },
    );
  });

  test('어떤 발화든 globalSlots.temperature 는 null/ice/hot/both', () => {
    fc.assert(
      fc.property(utteranceArbitrary, (utterance) => {
        const result = extractSlots(utterance);
        return VALID_TEMPERATURES.has(result.globalSlots.temperature);
      }),
      { numRuns: 1000 },
    );
  });

  test('어떤 발화든 lineItems[*].quantity 는 null 또는 양의 정수', () => {
    fc.assert(
      fc.property(utteranceArbitrary, (utterance) => {
        const result = extractSlots(utterance);
        return result.lineItems.every((li) => {
          if (li.quantity === null) return true;
          return Number.isInteger(li.quantity) && li.quantity >= 1;
        });
      }),
      { numRuns: 1000 },
    );
  });

  test('어떤 발화든 lineItems[*].size 는 null/regular/large', () => {
    fc.assert(
      fc.property(utteranceArbitrary, (utterance) => {
        const result = extractSlots(utterance);
        return result.lineItems.every((li) => VALID_SIZES.has(li.size));
      }),
      { numRuns: 1000 },
    );
  });

  test('어떤 발화든 lineItems[*].temperature 는 null/ice/hot/both', () => {
    fc.assert(
      fc.property(utteranceArbitrary, (utterance) => {
        const result = extractSlots(utterance);
        return result.lineItems.every((li) => VALID_TEMPERATURES.has(li.temperature));
      }),
      { numRuns: 1000 },
    );
  });

  test('lineItems 의 menuItem.id 는 항상 카탈로그에 존재', () => {
    fc.assert(
      fc.property(utteranceArbitrary, (utterance) => {
        const result = extractSlots(utterance);
        return result.lineItems.every((li) => VALID_MENU_IDS.has(li.menuItem.id));
      }),
      { numRuns: 1000 },
    );
  });

  test('rawText 는 입력 발화를 손실 없이 보존한다', () => {
    fc.assert(
      fc.property(utteranceArbitrary, (utterance) => {
        const result = extractSlots(utterance);
        return result.rawText === utterance;
      }),
      { numRuns: 1000 },
    );
  });

  test('declaredAllergies 는 항상 string 배열', () => {
    fc.assert(
      fc.property(utteranceArbitrary, (utterance) => {
        const result = extractSlots(utterance);
        const arr = result.globalSlots.declaredAllergies;
        return Array.isArray(arr) && arr.every((s) => typeof s === 'string');
      }),
      { numRuns: 1000 },
    );
  });
});
