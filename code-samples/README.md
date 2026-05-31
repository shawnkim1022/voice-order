# Code Samples — 발췌 코드

> ⚠️ **선별된 발췌입니다.** voice-order 전체 소스는 비공개 저장소(Proprietary)에서 관리하며,
> 여기에는 시스템의 **엔지니어링 방식**을 보여주는 대표 코드만 담습니다.
> 도메인 사전(lexicon), 상태머신 전이 로직, ML 학습 데이터·가중치 등 핵심 자산은 제외했습니다.
>
> **개발 방식**: Claude Code 등 AI 페어 프로그래밍을 능동 활용해 1인 개발했습니다.
> 설계 결정 · 검증 전략 · 통합은 직접 수행했습니다.

전체 동작과 코드 구조는 인터뷰 / 사전 협의 자리에서 시연합니다.

---

## 1. 자동화 인프라 (`automation/`)

1인 개발이지만 매일 자동으로 품질을 측정 · 감시하는 파이프라인을 운영합니다.

| 파일 | 무엇 |
|---|---|
| `p8-nightly-simulation.yml` | **GitHub Actions** — 야간 시뮬레이터 자동 실행 + 보고서 artifact 업로드. 외부 AI API · 비밀키 0, 결정적 룰 기반. |
| `com.voice-order.nightly-matrix.plist` | **macOS launchd** — 로컬에서 매일 다차원 매트릭스 측정을 자동 실행. |
| `nightly-report.mjs` | 측정 결과 → **markdown 추세 보고서 + regression alert** 생성 (어제 대비 / 7일 평균 대비 하락을 자동 감지). 외부 의존성 0 (Node builtin only). |

**핵심 설계 — 자동 반영 안 함**: 측정 실패는 `pending_review` 상태로만 모이고,
사람이 검토한 뒤에야 반영됩니다. 자동화가 품질을 *감시*하되 *마음대로 고치지는* 않는 안전판입니다.

## 2. 검증 문화 — Property-Based Testing (`tests/`)

명시적 케이스만으로 놓치기 쉬운 회귀를, 무작위 입력 생성(`fast-check`)으로 사전 차단합니다.

| 파일 | 무엇 |
|---|---|
| `cart.pbt.test.ts` | 장바구니 **무결성 invariant 9종** 을, 무작위 조작 시퀀스(add / update / remove / split / clear) 최대 20단계 × 1,000회로 검증. |
| `slotExtractor.pbt.test.ts` | 한국어 발화 **슬롯 추출 도메인 invariant 9종** 을, 한국어 음절 · 메뉴 · 수량 · 잡음 토큰을 무작위 조합한 발화 1,000회로 검증. |

**왜 PBT 인가**: 음성 주문은 입력이 자유로워(생략 · 말바꿈 · 구어체) 케이스를 일일이 적을 수 없습니다.
"어떤 입력이든 이 속성은 항상 참" 을 정의하면, fuzzer 가 반례를 자동으로 찾아냅니다.

---

## 라이선스

상위 [`LICENSE`](../LICENSE) 참조 — Proprietary / All Rights Reserved. 본 발췌는 평가 · 참고용입니다.
