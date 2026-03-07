# 8004scan 에이전트 점수 분석

## 1. 현재 점수 현황 (2026-03-07)

- **에이전트**: `proveragent.base.eth` on [8004scan.io](https://8004scan.io)
- **종합 점수**: 58.19 / 100 (Rank #2446)
- **비고**: Testnet과 Mainnet 동일한 점수

### 점수 구성 (5개 차원)

| 차원 | 점수 | 가중치 | 가중 기여 |
|------|------|--------|----------|
| Engagement | 6 | 30% | +1.8 |
| Service | 0 | 25% | +0.0 |
| Publisher | 6 | 20% | +1.2 |
| Compliance | 50 | 15% | +7.5 |
| Momentum | 55 | 10% | +5.5 |
| **합계** | | | **16.0** |

### Engagement 세부 지표 (전부 0)

| 지표 | 값 |
|------|---|
| Total Feedback | 0 |
| Total Validations | 0 |
| Total Chats | 0 |
| Total Messages | 0 |
| Total Stars | 0 |
| Total Watches | 0 |

---

## 2. 테스트넷 = 메인넷 동일 점수인 이유

점수 산출 기준이 사용량(usage)이 아니라 에이전트의 내재적 속성에 기반하기 때문이다.

내재적 속성에는 메타데이터 품질, 서비스 구성, publisher 프로필, 컴플라이언스, 최근 활동이 포함된다. 동일한 메타데이터, 동일한 owner, 양쪽 모두 사용자 활동 0이므로 결과적으로 동일한 점수가 산출된다.

---

## 3. 현재 구현 상태 분석

### 잘 되고 있는 것

- **Identity 등록** (ERC-721 NFT mint) — `src/identity/register.ts`
- **메타데이터 on-chain 기록** (name, description, services, tags, categories 등) — `src/identity/autoRegister.ts`
- **TEE Validation 제출** (self-validate, score=100, tee-attestation 태그) — `src/tee/validationSubmitter.ts`
- **메타데이터 drift 감지 및 자동 업데이트** — `src/identity/autoRegister.ts`

### 빠져 있는 것 (점수가 낮은 원인)

**1. Reputation/Feedback 미구현 (Engagement 30%)**

- `reputation.ts`의 `handleProofCompleted()`가 완전한 no-op 상태
- self-feedback은 컨트랙트에서 차단됨 (올바른 동작)
- 외부 피드백을 유도하는 메커니즘이 전혀 없음
- SDK/앱에서 proof 완료 후 on-chain feedback 제출 로직 없음

**2. Service endpoint 접근성 미검증 (Service 25%)**

- `services[]`에 URL 등록은 하고 있지만 8004scan이 health check 시 응답 여부 불확실
- `config.websiteUrl`, MCP endpoint, A2A endpoint 외부 접근 가능성 미확인

**3. Publisher 프로필 미완성 (Publisher 20%)**

- `proveragent.base.eth` ENS에 avatar, social links, description 등 설정 여부 불명

**4. ERC-8004 v2.0 필드 누락 가능 (Compliance 15%)**

- metadata에 `version` 필드 없음
- v2.0 스펙과의 정확한 일치 미검증

**5. 주기적 on-chain 활동 없음 (Momentum 10%)**

- 서버 시작 시 1회만 등록/업데이트, 이후 추가 TX 없음

---

## 4. Validator 현황

현재 self-validation 구현:

```typescript
validationRequest(signer.address, ...)  // 자기 주소가 validator
validationResponse(requestHash, 100, ...)  // 자기가 자기에게 100점
```

- TEE 배지는 활성화됨 (8004scan에 표시)
- Compliance 50점에서 더 올라가지 않는 원인일 수 있음
- 진짜 의미 있는 validation은 외부 validator가 해야 함

self-validation은 TEE 증명 목적으로는 타당하지만, 8004scan의 Validation 점수 산출 로직이 자기 검증을 제한적으로 인정할 가능성이 있다. 외부 validator를 통한 검증이 Compliance 점수를 끌어올리는 실질적인 방법이다.

---

## 5. Reputation 현황

- `giveFeedback` ABI는 `reputation.ts`에 존재하나 어디서도 호출하지 않음
- `handleProofCompleted()`는 빈 함수 (no-op placeholder)
- self-feedback은 컨트랙트 레벨에서 차단됨 (의도된 동작)
- 근본 문제: proof를 생성받은 고객이 feedback을 제출하는 플로우 자체가 없음

현재 Engagement 점수가 6점에 불과한 직접적인 원인이다. 가중치가 30%로 가장 높은 차원임에도 사실상 방치된 상태다.

---

## 6. 개선 로드맵

| 우선순위 | 작업 | 대상 차원 | 예상 효과 | 난이도 |
|---------|------|----------|----------|--------|
| 1 | Service endpoint 검증 및 수정 | Service | 0 -> 50+ | 낮음 (설정 확인) |
| 2 | SDK에 feedback 제출 기능 추가 | Engagement | 6 -> 30+ | 중간 |
| 3 | ENS 프로필 완성 | Publisher | 6 -> 30+ | 낮음 |
| 4 | 외부 validator 사용 | Compliance | 50 -> 80+ | 조사 필요 |
| 5 | 메타데이터 v2.0 완전 준수 | Compliance | +10 | 낮음 |
| 6 | 주기적 활동 | Momentum | 유지/상승 | 낮음 |

### 우선순위 1: Service endpoint 검증 및 수정

`websiteUrl`, MCP endpoint, A2A endpoint가 외부에서 접근 가능한지 확인한다. 8004scan이 health check를 수행할 때 응답을 받을 수 있어야 Service 점수가 올라간다. 설정 확인만으로 해결 가능하므로 투입 대비 효과가 크다.

### 우선순위 2: SDK에 feedback 제출 기능 추가

proof 완료 후 SDK가 Reputation 컨트랙트에 `giveFeedback()`을 호출하는 플로우를 구현한다. 고객 에이전트가 자동으로 피드백을 제출하게 되면 Engagement 점수가 실질적으로 상승한다. 가중치가 30%로 가장 높은 차원이므로 점수 개선 효과가 가장 크다.

### 우선순위 3: ENS 프로필 완성

`proveragent.base.eth`에 avatar, description, url, social links를 설정한다. ENS 레코드 업데이트만으로 Publisher 점수를 개선할 수 있다.

### 우선순위 4: 외부 validator 사용

self-validate 대신 8004scan 공식 validator 또는 제3자 validator를 활용한다. 8004scan이 제공하는 validator 프로그램을 먼저 조사해야 한다. Compliance 점수를 50에서 80 이상으로 끌어올리는 핵심 작업이다.

### 우선순위 5: 메타데이터 v2.0 완전 준수

`version` 필드를 추가하고 ERC-8004 v2.0 스펙에서 누락된 선택 필드를 보완한다.

### 우선순위 6: 주기적 활동

메타데이터 업데이트 또는 validation renewal을 주기적으로 실행하여 Momentum 점수를 유지하거나 상승시킨다.

---

## 7. 관련 코드 파일

| 파일 | 역할 |
|------|------|
| `src/identity/types.ts` | ERC-8004 TypeScript 타입 정의 |
| `src/identity/register.ts` | Identity 컨트랙트 클라이언트 (register, setAgentURI, tokenURI) |
| `src/identity/reputation.ts` | Reputation 컨트랙트 클라이언트 (getAverageScore, getFeedbackCount) |
| `src/identity/autoRegister.ts` | 시작 시 자동 등록 + 메타데이터 staleness 감지 |
| `src/identity/agentAuth.ts` | ERC-8128 에이전트 인증 미들웨어 |
| `src/tee/validationSubmitter.ts` | ValidationRegistry TEE attestation 제출 |
| `src/config/contracts.ts` | ERC-8004 컨트랙트 주소 (mainnet/sepolia) |

---

## 8. 컨트랙트 주소

### Mainnet (Base, chainId 8453)

| 컨트랙트 | 주소 |
|---------|------|
| Identity | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Reputation | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Validation | `0x8004C269D0A5647E51E121FeB226200ECE932d55` |

### Sepolia (Base Sepolia, chainId 84532)

| 컨트랙트 | 주소 |
|---------|------|
| Identity | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Reputation | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| Validation | `0x8004C269D0A5647E51E121FeB226200ECE932d55` |
