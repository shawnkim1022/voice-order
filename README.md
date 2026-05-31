# Voice Order

> 📖 **공개 정보 저장소**. 본 저장소는 voice-order 시스템의 개요, 책임 경계, 디렉토리 구조, 라이선스 정보만 담는다.
> 실제 소스 코드는 별도의 비공개 저장소에서 관리한다 (Proprietary / All Rights Reserved, `LICENSE` 참조).
> 코드 데모와 코드 단위 설명은 인터뷰 또는 사전 협의된 자리에서 진행한다.

---

## 무엇

한국어 음성으로 카페 주문을 받는 시스템. 시각장애인·저시력자·노년층이 터치 키오스크 대신 사용 가능.

대형 AI API 미사용 — 룰 기반 NLU, fuzzy matching, 상태머신, 학습된 sklearn 슬롯 분류기, KoELECTRA fine-tune (multi-task, ONNX) 의 조합.

주요 구성: 한국어 카페 도메인 사전, 의도 그룹 라우터, 시뮬레이터 평가 인프라.

## 책임 경계 (SDK 통합 모델)

본사 프랜차이즈 앱에 SDK 로 통합되는 모델. 본사는 자체 결제·정산·회원·포인트 시스템 보유 → voice-order 는 그 영역을 침범하지 않는다.

- **voice-order 책임**: STT, NLU, 메뉴 및 장바구니, 음성 readback, 결제 직전 음성 confirm (`pre_payment_review` / `high_value_confirm`), `order_complete` 이벤트 emit, 다중 모달리티 분기 (`readBackMode`, VoiceOver/TalkBack 호환, 2024-07-28 시행된 장애인차별금지법 시행령 제14조 6항 5호 적합).
- **본사 영역**: 결제 수단·결제 처리 (PG/POS), 영수증 발급, 포인트 적립.

---

## 디렉토리 구조

```
voice-order-project/
├── packages/voice-order-core/   # TypeScript NLU 엔진
│   ├── src/
│   │   ├── nlu/                 # 정규화, 슬롯 추출, intent 라우팅
│   │   ├── normalize/           # 한국어 발화 정규화 캐스케이드
│   │   ├── order/               # 장바구니, 상태머신, 핸들러
│   │   ├── data/lexicons/       # 한국어 카페 도메인 사전
│   │   ├── menu/                # 메뉴 데이터
│   │   ├── ml/                  # 학습된 sklearn 모델 + KoELECTRA ONNX
│   │   ├── recommendation/      # 추천 엔진
│   │   ├── simulation/          # 시뮬레이터 + fuzz + oracle
│   │   ├── feedback/            # 회귀 후보 자동 수집
│   │   └── allergy/             # 알레르기 가드
│   └── tests/
├── server/                      # FastAPI (Python) — 저장소·관리·인증
├── apps/admin/                  # 관리자 웹 UI (React + Vite)
├── apps/pilot-mobile/           # 파일럿 모바일 앱 (Expo)
├── docs/                        # 운영·정책·통합 문서
└── .github/workflows/           # CI / 자동 배포
```

---

## 공개 가능한 주요 문서

| 문서 | 용도 |
|---|---|
| `LICENSE` | 비공개·독점 라이선스 (Proprietary / All Rights Reserved) |
| `README.md` | 본 문서 (시스템 개요) |

상세 기술 문서, 운영 정책, 본사 협업 가이드, 진행 인계 자료는 비공개 저장소 안에서만 관리한다.

---

## 코드 접근

소스 코드는 본사 영업 단계의 협상 자료에 해당하므로 외부 공개를 제한한다. 라이선스도 Proprietary 로 외부 공유·재라이선스를 금하고 있다. 단, 엔지니어링 방식을 보여주는 **대표 코드 발췌**는 [`code-samples/`](code-samples/) 에 공개한다 (도메인 사전·상태머신 전이·ML 가중치 등 핵심 자산 제외).

- **대표 코드 발췌**: [`code-samples/`](code-samples/) — 자동화 파이프라인 (CI · launchd · regression alert) + property-based testing 2종
- **인터뷰 / 사전 협의**: 화면 공유 또는 실기 단말로 실제 동작 및 코드 구조 시연 가능
- **시연 범위**: NLU 파이프라인, 분류기 학습 코드, 평가 인프라 워크플로우, AI 도구 활용 (CLAUDE.md, memory/, LaunchAgent, GitHub Actions)
- **상업 라이선스 (프랜차이즈, 기업, 공공기관)**: `LICENSE` 의 연락처로 별도 협의

---

## 절대 규칙 (요약)

- 외부 AI API (OpenAI / Claude / Gemini / 클로바 등) 호출 0
- 비밀키·토큰·운영 DB 커밋 0
- 본 자산의 외부 공유·공개·재라이선스 0 (Proprietary 라이선스)
- 본사·파트너에게 소스 코드 공유 0 (API 와 통합 가이드만)
- 한국어 응답 only (영어 fallback 없음)
- 결정론적 룰 기반 (같은 입력에 같은 출력)
- Safety-first (결제·취소·직원 호출 같은 위험 동작 자동 실행 안 함, 복명복창)

---

## 라이선스

`LICENSE` 참조. **Proprietary / All Rights Reserved.** 어떠한 사용 권리도 부여되지 않음.

상업 라이선스 (프랜차이즈, 기업, 공공기관) 는 별도 계약 필요.

---

## 외부 데이터 출처 (Acknowledgement)

본 프로젝트의 시뮬레이터는 다음 외부 코퍼스의 **통계 분포 grounding** 만 사용한다. 원문 발화 0 포함 — derived statistics (filler rate, 잘린 발화 rate, 카페 도메인 매치 빈도 등) 만 추출.

### KsponSpeech (AI Hub)
- **출처**: AI Hub (https://aihub.or.kr) — 한국어 음성 전사 코퍼스, 628,545 utterance
- **derived data**: 통계 분포 JSON 12KB (모델 학습 input 아님)
- **활용**: `utteranceTemplates` HESITATION_PREFIX weight + Disfluency Extreme / STT Perturbation 시뮬 grounding
- **라이선스 (AI Hub 약관)**:
  - 학습 모델/서비스 배포 자유 (영리 활용 OK)
  - 출처 명시 필수 (본 섹션이 명시)
  - 데이터 재가공 배포는 사전 협의 필요 — 본 프로젝트는 통계 분포만 추출 → 자유 범위 안
- **사전 협의 권장 시점**: 매장 파일럿 배포 / B2B 상업화 직전 NIA / AI Hub 문의로 명확화

### 미사용 코퍼스

- **국립국어원 모두의 말뭉치**: 영리 사용 절대 금지 (이용약관 제12조 5항, 12항 / 제13조 2항). voice-order 의 use case (B2B 매장 voice ordering) 는 영리에 해당하므로 직접 충돌. 미사용 결정 (2026-05-12).
- **서울말 낭독체 / 21세기 세종계획**: 연구용만 — 상업 활용 불가.

---

## 연락처

상업 라이선스 문의 및 인터뷰 일정 협의: shawnkim1022@gmail.com
