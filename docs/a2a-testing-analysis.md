# A2A 프로토콜 테스팅 프레임워크 심층 분석

> 작성일: 2026-02-21
> 대상: proofport-ai (proveragent.base.eth)
> 목적: A2A 프로토콜 검증 도구의 한계 분석 및 프로덕션 에이전트의 테스팅 패턴 조사

---

## 목차

1. [개요](#1-개요)
2. [기존 도구 한계 분석](#2-기존-도구-한계-분석)
3. [대안적 테스팅 프레임워크 분석](#3-대안적-테스팅-프레임워크-분석)
4. [프로덕션 A2A 에이전트들의 테스팅 패턴](#4-프로덕션-a2a-에이전트들의-테스팅-패턴)
5. [A2A 프로토콜 스펙이 요구하는 테스트 영역](#5-a2a-프로토콜-스펙이-요구하는-테스트-영역)
6. [proofport-ai 현재 테스트 수준 평가](#6-proofport-ai-현재-테스트-수준-평가)
7. [개선 권장사항 및 로드맵](#7-개선-권장사항-및-로드맵)
8. [결론](#8-결론)
9. [참고 자료](#9-참고-자료)

---

## 1. 개요

### 1.1 왜 이 분석이 필요한가

A2A(Agent-to-Agent) 프로토콜은 Google이 주도하는 에이전트 간 통신 표준으로, JSON-RPC 2.0 기반의 Task 라이프사이클 관리, SSE 스트리밍, Push Notification 등을 정의한다. 현재 A2A 에코시스템에서 테스팅 도구로 가장 많이 언급되는 것이 **a2a-inspector**와 **a2a-ui**인데, 이 도구들은 **TextPart 렌더링과 수동 확인**에 초점이 맞춰져 있어 다음 영역의 검증이 근본적으로 불가능하다:

| 검증 필요 영역 | a2a-inspector | a2a-ui | 필요한 이유 |
|---------------|:---:|:---:|------------|
| DataPart 스키마 검증 | JSON pretty-print만 | 미지원 | proofport-ai는 모든 응답이 구조화된 DataPart (proof, publicInputs, circuitId 등) |
| Task 상태 전이 규칙 | 상태 표시만 | 미지원 | queued->running->completed 전이의 정합성 보장 필수 |
| SSE 스트리밍 프로토콜 준수 | WebSocket 프록시 | 렌더링만 | `text/event-stream` + JSON-RPC envelope 형식 검증 필요 |
| 자동화/회귀 테스트 | 미지원 | 미지원 | CI/CD 파이프라인 통합 불가 |
| Push Notification | 미지원 | 미지원 | 스펙 정의 영역이나 검증 도구 전무 |
| 인증 플로우 (x402) | 미지원 | 미지원 | proofport-ai는 x402 결제 미들웨어 사용 |

proofport-ai는 **LLM-free "tool agent"** 아키텍처로, 3개의 고정 스킬(generate_proof, verify_proof, get_supported_circuits)과 3개의 multi-turn 스킬(request_signing, check_status, request_payment)을 deterministic하게 라우팅한다. 모든 입출력이 **DataPart** (구조화된 JSON)이므로, TextPart 중심의 기존 도구로는 의미 있는 검증이 불가능하다.

### 1.2 분석 범위

- **기존 도구**: a2a-inspector, a2a-ui (a2a-community, a2anet 두 프로젝트)
- **대안 프레임워크**: A2A Python SDK, FastA2A, Pydantic AI TestModel, a2a-redis, A2A Samples CLI Host 등
- **프로덕션 패턴**: Google ADK 샘플, 커뮤니티 에이전트들의 실제 테스트 전략
- **스펙 요구사항**: A2A 프로토콜 명세서가 정의하는 테스트 필수 영역

---

## 2. 기존 도구 한계 분석

### 2.1 a2a-inspector

**저장소**: [github.com/a2aproject/a2a-inspector](https://github.com/a2aproject/a2a-inspector)

#### 아키텍처

```
[Browser UI] <--WebSocket--> [FastAPI Backend] <--HTTP/SSE--> [A2A Agent]
                                    |
                              [Debug Logger]
```

- FastAPI 백엔드 + TypeScript 프론트엔드
- 에이전트와의 통신을 WebSocket으로 프록시하여 브라우저에서 실시간 표시
- Agent Card 조회, Spec Compliance 기본 검증, Live Chat, Debug Console (raw JSON-RPC 표시)

#### 프론트엔드 Part 처리 분석 (script.ts)

`processPart()` 함수가 3가지 Part를 다음과 같이 처리한다:

| Part 타입 | 처리 방식 | 검증 수준 |
|-----------|----------|----------|
| **TextPart** | `marked`(Markdown) + DOMPurify로 렌더링 | 시각적 확인만 가능 |
| **FilePart** | base64 또는 URI에서 img/audio/video/PDF 렌더링 | 미디어 타입 감지만 |
| **DataPart** | `.mimeType`과 `.data` 있으면 base64 미디어 처리, 아니면 `<pre><code>` JSON 블록으로 fallback | **구조 검증 없음** |

Socket events 처리:
- `client_initialized`, `agent_response`, `debug_log`
- `agent_response`의 `kind` 필드로 분기: `task`, `status-update`, `artifact-update`, `message`
- 유효성 검사: `validation_errors` 배열이 있으면 경고 아이콘, 없으면 체크 아이콘 표시

#### 핵심 한계

| 기능 | 상태 | 상세 |
|------|:----:|------|
| SSE streaming 검증 | 미지원 | WebSocket 프록시 방식이라 실제 `text/event-stream` 프로토콜 준수 여부 검증 불가 |
| DataPart 스키마 검증 | 미지원 | JSON을 pretty-print할 뿐, `proof` 필드가 `0x`로 시작하는지, `publicInputs`가 배열인지 등 구조 검증 없음 |
| Task 상태 전이 검증 | 미지원 | 현재 상태만 표시하고, `completed->running` 같은 무효 전이가 발생해도 감지하지 못함 |
| Push Notification 테스트 | 미지원 | webhook URL 등록/수신 테스트 기능 없음 |
| 자동화/회귀 테스트 | 미지원 | 수동 UI만 제공하며 프로그래매틱 API 없음, CI 통합 불가 |
| Agent Card 상세 검증 | 부분적 | 필수 필드 존재 여부만 확인, `skills[].inputModes`, `securitySchemes`, `identity` 등 상세 검증 없음 |
| 인증 플로우 | 미지원 | x402, OAuth, API Key 등 인증 메커니즘 테스트 불가 |
| Multi-turn 대화 | 제한적 | 단일 메시지 송수신만, contextId 기반 대화 연속성 검증 불가 |

#### proofport-ai 관점에서의 치명적 한계

proofport-ai의 전형적인 응답 예시:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": "task-abc-123",
    "status": { "state": "completed" },
    "artifacts": [{
      "id": "art-1",
      "mimeType": "application/json",
      "parts": [
        { "kind": "text", "text": "Zero-knowledge proof generated successfully." },
        {
          "kind": "data",
          "mimeType": "application/json",
          "data": {
            "proof": "0x1a2b3c...",
            "publicInputs": "0x4d5e6f...",
            "nullifier": "0x789abc...",
            "signalHash": "0xdef012...",
            "proofId": "proof-id-xyz",
            "verifyUrl": "https://ai.zkproofport.app/v/proof-id-xyz"
          }
        }
      ]
    }]
  }
}
```

a2a-inspector는 이 응답에서:
- TextPart("Zero-knowledge proof generated successfully.")를 Markdown으로 렌더링
- DataPart의 JSON을 `<pre>` 블록으로 표시

**검증하지 못하는 것**:
- `proof`가 유효한 hex string인지
- `publicInputs` 형식이 올바른지
- `nullifier`와 `signalHash`가 32바이트인지
- `verifyUrl`이 접근 가능한 URL인지
- Artifact 구조가 A2A 스펙을 준수하는지

### 2.2 a2a-ui (a2a-community/a2a-ui)

**저장소**: [github.com/a2a-community/a2a-ui](https://github.com/a2a-community/a2a-ui)

#### 아키텍처

- Next.js + TypeScript + shadcn/ui
- Telegram 스타일 채팅 UI
- Phoenix 트레이싱 연동 (LLM 호출 추적)
- Agent CRUD 관리, streaming message 렌더링

#### 한계 분석

| 측면 | 평가 |
|------|------|
| **본질** | UI 클라이언트 도구이지 테스팅 프레임워크가 아님 |
| **SSE streaming** | 클라이언트 측 렌더링만 수행, 프로토콜 준수 여부 검증 없음 |
| **DataPart** | 스키마 검증 없음, 표시만 |
| **Task 상태 전이** | 검증 로직 없음 |
| **Push Notification** | 미지원 |
| **자동화** | 프로그래매틱 테스트 API 없음 |
| **프로토콜 conformance** | 체크 로직 없음 |
| **테스트 인프라** | `package.json`에 `dev`, `build`, `lint`만 존재 |

### 2.3 a2a-ui (a2anet/a2a-ui)

**저장소**: [github.com/a2anet/a2a-ui](https://github.com/a2anet/a2a-ui)

- Next.js + Material UI
- a2a-community/a2a-ui와 유사한 한계
- Agent 관리 + 채팅 UI가 주요 기능
- 테스팅 프레임워크로서의 기능 부재

### 2.4 세 도구의 공통 한계 요약

```
                    테스팅 피라미드에서의 위치

    ┌─────────────────────────────────────────┐
    │          Manual Exploratory              │  <-- a2a-inspector, a2a-ui 여기
    │         (수동 탐색적 테스트)               │
    ├─────────────────────────────────────────┤
    │         E2E / Contract Tests             │  <-- 빈 공간 (도구 부재)
    │      (프로토콜 적합성 자동 검증)            │
    ├─────────────────────────────────────────┤
    │         Integration Tests                │  <-- 빈 공간 (도구 부재)
    │     (다중 컴포넌트 통합 검증)              │
    ├─────────────────────────────────────────┤
    │           Unit Tests                     │  <-- SDK 타입 모델만 활용 가능
    │        (개별 함수 검증)                    │
    └─────────────────────────────────────────┘
```

기존 도구들은 **테스팅 피라미드의 최상단(수동 탐색)에만 위치**하며, 자동화된 프로토콜 적합성 검증, 통합 테스트, 회귀 테스트를 전혀 지원하지 않는다.

---

## 3. 대안적 테스팅 프레임워크 분석

### 3.1 A2A TCK (Technology Compatibility Kit) — 공식 적합성 테스트 스위트

**저장소**: https://github.com/a2aproject/a2a-tck

A2A 프로젝트(Linux Foundation)가 공식 관리하는 **프로토콜 적합성 테스트 스위트**. A2A Protocol v0.3.0 스펙 준수를 자동으로 검증한다.

#### 설치 및 실행

```bash
git clone https://github.com/a2aproject/a2a-tck.git
cd a2a-tck
uv venv && source .venv/bin/activate
uv pip install -e .

# 필수 적합성만 (CI 차단)
./run_tck.py --sut-url http://localhost:9999 --category mandatory

# 전체 스위트 + JSON 리포트
./run_tck.py --sut-url http://localhost:9999 --category all --compliance-report report.json
```

#### 테스트 카테고리

| 카테고리 | CI 영향 | 목적 |
|----------|---------|------|
| `mandatory` | CI 차단 | 핵심 JSON-RPC 2.0 + A2A 스펙 준수 |
| `capabilities` | CI 차단 | 선언된 capabilities vs 실제 동작 ("거짓 광고 감지") |
| `transport-equivalence` | CI 차단 | JSON-RPC, gRPC, REST 간 기능 동등성 |
| `quality` | 정보성 (플래그로 차단 가능) | 프로덕션 준비도 신호 |
| `features` | 정보성 (플래그로 차단 가능) | 선택적 기능 완성도 |

#### 적합성 레벨

| 레벨 | 조건 |
|------|------|
| NON_COMPLIANT | mandatory 실패 1건 이상 |
| MANDATORY | mandatory 100% 통과 |
| RECOMMENDED | mandatory 100% + capability ≥ 85% + quality ≥ 75% |
| FULL_FEATURED | capability ≥ 95% + quality ≥ 90% + feature ≥ 80% |

#### 평가

| 항목 | 평점 |
|------|------|
| DataPart 스키마 검증 | 스펙 수준 구조 검증 (커스텀 스키마는 아님) |
| Task 상태 전이 검증 | **O** — 유효/무효 전이 테스트 포함 |
| SSE 스트리밍 검증 | **O** — 이벤트 순서, final 플래그, 타임아웃 |
| Push Notification | **O** — 웹훅 전달 검증 |
| CI/CD 통합 | **O** — JSON 리포트 출력, 종료 코드 기반 |
| 자동화 | **O** — 완전 자동, 헤드리스 |

**proofport-ai 적용 시 고려사항**: TCK는 Python 기반이므로 proofport-ai Docker 컨테이너를 실행한 후 외부에서 TCK를 실행하는 방식으로 적용 가능. CI 파이프라인에 `mandatory` 카테고리를 게이트로 추가하면 스펙 적합성을 자동 보장할 수 있다.

### 3.2 Mokksy MockAgentServer — JVM 기반 A2A 목 서버

**저장소**: https://mokksy.dev/docs/ai-mocks/a2a/

Kotlin/JVM 라이브러리로, 로컬 A2A 목 서버를 테스트 내에서 구동한다. JSON-RPC 2.0 및 A2A Protocol v0.3.0 지원. 실제 네트워크 호출 없이 A2A 클라이언트 테스트 가능.

#### 주요 기능

```kotlin
val a2aServer = MockAgentServer(verbose = true)
val a2aClient = createA2AClient(url = a2aServer.baseUrl())

// Agent Card 목
a2aServer.agentCard() responds { card = agentCard }

// 메시지 송수신 목
a2aServer.sendMessage() responds { id = 1; result = task }

// SSE 스트리밍 목
a2aServer.sendMessageStreaming() responds {
    responseFlow = flow {
        emit(taskStatusUpdateEvent { /* working */ })
        emit(taskArtifactUpdateEvent { /* content */ })
        emit(taskStatusUpdateEvent { final = true })
    }
}

// Push Notification 테스트
a2aServer.sendPushNotification(event = taskUpdateEvent)
a2aServer.verifyNoUnmatchedRequests()
```

#### 지원 목 엔드포인트

`agentCard()`, `getTask()`, `cancelTask()`, `sendMessage()`, `sendMessageStreaming()`, `taskResubscription()`, `setTaskPushNotification()`, `getTaskPushNotification()`, `listTaskPushNotificationConfig()`, `deleteTaskPushNotificationConfig()`

#### 평가

JVM 프로젝트에 최적. proofport-ai는 Node.js이므로 직접 사용은 불가하지만, **A2A 클라이언트 측 테스트 패턴의 참고 사례**로 가치가 있다. 특히 Push Notification 테스트와 SSE 스트리밍 flow 목킹 패턴은 TypeScript로 이식 가능.

### 3.3 A2A JavaScript SDK (`@a2a-js/sdk`) — 공식 TypeScript SDK

**패키지**: `npm install @a2a-js/sdk`
**저장소**: https://github.com/a2aproject/a2a-js

A2A Protocol v0.3.0의 공식 TypeScript SDK. `A2AClient`, `ClientFactory`, `InMemoryTaskStore`, `A2AExpressApp`, `AgentExecutor` 인터페이스 제공.

#### 테스트 클라이언트 패턴

```typescript
import { ClientFactory } from '@a2a-js/sdk/client';

const factory = new ClientFactory();
const client = await factory.createFromUrl('http://localhost:4000');

// Non-streaming
const response = await client.sendMessage({
    message: {
        messageId: 'test-001',
        role: 'user',
        parts: [{ kind: 'text', text: 'Hello agent' }],
        kind: 'message'
    }
});

// SSE Streaming
const stream = client.sendMessageStream(params);
for await (const event of stream) {
    console.log(event);
}
```

#### 인프로세스 서버 (통합 테스트)

```typescript
import { InMemoryTaskStore, A2AExpressApp, DefaultRequestHandler } from "@a2a-js/sdk/server";
import express from "express";

const taskStore = new InMemoryTaskStore();
const executor = new MyTestableExecutor();
const handler = new DefaultRequestHandler(agentCard, taskStore, executor);
const app = new A2AExpressApp(handler).setupRoutes(express(), "");
app.listen(4000);
```

#### 평가

proofport-ai와 **동일한 TypeScript/Express 스택**이므로 가장 자연스러운 통합 대상. `InMemoryTaskStore`는 기존 자체 구현 `TaskStore`와 비교/대체 검토 가능. `AgentExecutor` 인터페이스는 단위 테스트 가능한 에이전트 로직 분리 패턴 제공.

### 3.4 A2A Python SDK (a2a-sdk)

**패키지**: `pip install a2a-sdk`

#### 주요 컴포넌트

```python
from a2a.client import A2AClient, A2ACardResolver
from a2a.types import (
    Task, TaskStatus, TaskState,
    Message, Part, TextPart, DataPart, FilePart,
    Artifact, SendMessageRequest, SendStreamingMessageResponse,
    AgentCard, AgentSkill, AgentCapabilities,
)
```

| 컴포넌트 | 역할 | 테스트 활용 |
|----------|------|-----------|
| `A2AClient` | `send_message()`, `send_message_streaming()` 등 | 프로그래매틱 에이전트 호출 |
| `A2ACardResolver` | Agent Card 자동 fetch + 파싱 | Agent Card 구조 검증 자동화 |
| Pydantic 모델 | `Task`, `TaskStatus`, `Message`, `DataPart` 등 | **타입 기반 응답 검증** |

#### 테스트 활용 패턴

```python
import pytest
from a2a.client import A2AClient
from a2a.types import TaskState, DataPart

@pytest.fixture
async def client():
    return A2AClient(url="http://localhost:4002/a2a")

async def test_get_supported_circuits(client):
    """DataPart 스키마까지 검증하는 자동화 테스트"""
    response = await client.send_message(
        message={
            "role": "user",
            "parts": [{
                "kind": "data",
                "mimeType": "application/json",
                "data": {"skill": "get_supported_circuits"}
            }]
        }
    )

    # Task 상태 검증
    assert response.result.status.state == TaskState.COMPLETED

    # Artifact 구조 검증
    artifacts = response.result.artifacts
    assert len(artifacts) > 0

    # DataPart 스키마 검증
    data_part = next(
        p for a in artifacts for p in a.parts
        if isinstance(p, DataPart) and p.data.get("circuits")
    )
    circuits = data_part.data["circuits"]
    assert any(c["id"] == "coinbase_attestation" for c in circuits)
```

#### 평가

| 장점 | 한계 |
|------|------|
| Pydantic 모델로 타입 안전한 응답 검증 | 명시적 테스트 헬퍼/어설션 유틸리티 없음 |
| 프로그래매틱 API로 CI 통합 가능 | Task 상태 전이 규칙 검증 로직 내장 안 됨 |
| SSE 스트리밍 클라이언트 지원 | DataPart 커스텀 스키마 검증은 직접 구현 필요 |
| Agent Card 자동 resolve | Push Notification 테스트 미지원 |

**적합도**: ★★★★ (4/5) -- 프로그래매틱 클라이언트로서 우수하나, 테스트 프레임워크 자체는 아님

### 3.5 FastA2A (Pydantic)

**저장소**: [github.com/pydantic/fasta2a](https://github.com/pydantic/fasta2a)
**패키지**: `pip install fasta2a` (v0.6.0)

#### 아키텍처

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   A2AClient  │────>│  FastA2A App │────>│    Worker     │
│  (테스트코드)  │<────│  (서버 로직)   │<────│  (비즈니스)    │
└──────────────┘     └──────┬───────┘     └──────────────┘
                           │
                    ┌──────┴───────┐
                    │   Storage    │
                    │   Broker     │
                    └──────────────┘
```

#### 테스트용 핵심 기능

| 컴포넌트 | 역할 | 테스트 활용도 |
|----------|------|:---:|
| `InMemoryStorage` | 외부 DB 없이 Task 저장 | 단위 테스트 시 Redis/DB 불필요 |
| `InMemoryBroker` | 외부 큐 없이 Task 처리 | Worker 로직 격리 테스트 |
| Worker 추상 클래스 | `run_task()`, `cancel_task()` 등 | 커스텀 Worker 테스트 |

#### 테스트 패턴

```python
from fasta2a import FastA2A
from fasta2a.storage import InMemoryStorage
from fasta2a.broker import InMemoryBroker
from httpx import AsyncClient

async def test_task_lifecycle():
    """Task 전체 라이프사이클을 in-memory로 테스트"""
    storage = InMemoryStorage()
    broker = InMemoryBroker()
    app = FastA2A(storage=storage, broker=broker)

    async with AsyncClient(app=app, base_url="http://test") as client:
        # Task 생성
        response = await client.post("/a2a", json={
            "jsonrpc": "2.0", "id": 1,
            "method": "message/send",
            "params": {"message": {"role": "user", "parts": [...]}}
        })
        task = response.json()["result"]
        assert task["status"]["state"] == "submitted"

        # Worker 실행 후 완료 확인
        await broker.process_next()
        response = await client.post("/a2a", json={
            "jsonrpc": "2.0", "id": 2,
            "method": "tasks/get",
            "params": {"id": task["id"]}
        })
        assert response.json()["result"]["status"]["state"] == "completed"
```

#### 평가

| 장점 | 한계 |
|------|------|
| InMemory 구현으로 외부 의존성 제거 | Python 전용 -- Node.js/TypeScript 에이전트에 직접 적용 불가 |
| Task 라이프사이클 전체를 프로그래매틱 제어 | 테스트 어설션 유틸리티 자체는 없음 |
| Storage/Broker 추상화로 단위 테스트 용이 | A2A 프로토콜 conformance 자동 검증 기능 없음 |
| Pydantic AI의 `TestModel`과 결합 가능 | Push Notification 테스트 미지원 |

**적합도**: ★★★ (3/5) -- Python 에이전트 개발용으로 우수하나, 외부 에이전트 검증 도구로는 부족

### 3.6 Pydantic AI TestModel

#### 핵심 기능

| 도구 | 역할 | 적용 |
|------|------|------|
| `TestModel` | 실제 LLM 없이 도구 호출 시뮬레이션 | LLM 라우팅 테스트 |
| `FunctionModel` | 커스텀 로직으로 정밀 응답 제어 | 특정 시나리오 재현 |
| `Agent.override()` | 테스트에서 모델 교체 | 프로덕션 코드 변경 없이 테스트 |
| `capture_run_messages()` | 전체 메시지 교환 기록 | 대화 흐름 검증 |
| `ALLOW_MODEL_REQUESTS = False` | 실수로 실제 API 호출 방지 | 테스트 안전성 |

```python
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel

agent = Agent("openai:gpt-4", ...)

with agent.override(model=TestModel()):
    result = await agent.run("generate a proof")
    # TestModel은 모든 도구를 순서대로 호출
    assert result.tool_calls[0].name == "generate_proof"
```

#### 평가

| 장점 | 한계 |
|------|------|
| LLM 비용 없이 도구 라우팅 테스트 | A2A 프로토콜 레벨 테스트와는 무관 |
| 결정론적 테스트 가능 | A2A 에이전트 테스팅 전용 가이드 없음 |
| 실수로 API 호출 방지 | Python 전용 |

**적합도**: ★★ (2/5) -- LLM 에이전트의 내부 로직 테스트에는 유용하나, A2A 프로토콜 테스팅과는 직접적 관련 없음

### 3.7 a2a-redis

**저장소**: [github.com/redis-developer/a2a-redis](https://github.com/redis-developer/a2a-redis)

#### 테스트 인프라

```python
# Redis DB 15 격리
@pytest.fixture
async def redis_client():
    client = redis.Redis(db=15)
    yield client
    await client.flushdb()

# Mock + Real Redis 통합 테스트
# 실행: uv run pytest --cov=a2a_redis
```

| 컴포넌트 | 테스트 방식 |
|----------|-----------|
| `RedisTaskStore` | Redis DB 15 격리 + CRUD 검증 |
| `RedisJSONTaskStore` | RedisJSON 모듈 기반 저장 검증 |
| `RedisStreamsQueueManager` | Stream 기반 큐 처리 검증 |
| `RedisPubSubQueueManager` | Pub/Sub 기반 이벤트 검증 |

#### 평가

**적합도**: ★★★ (3/5) -- Redis 기반 Task Store 테스트 패턴으로 참고 가치 높음. proofport-ai도 Redis를 사용하므로 유사한 격리 패턴 적용 가능

### 3.8 A2A Samples CLI Host

**저장소**: [github.com/a2aproject/a2a-samples/tree/main/samples/python/hosts/cli](https://github.com/a2aproject/a2a-samples)

- A2AClient로 에이전트 연결
- Agent Card 자동 fetch
- 텍스트 기반 대화형 상호작용
- Streaming 지원

#### 한계

- **TextPart 중심**: DataPart의 구조적 검증 없음
- **대화형 도구**: 자동화 테스트가 아닌 수동 확인
- **검증 로직 없음**: 응답을 표시할 뿐, 정합성 검사 미수행

**적합도**: ★★ (2/5) -- 수동 탐색 도구

### 3.9 기타 도구

| 도구 | 설명 | 적합도 |
|------|------|:---:|
| **python-a2a** (themanojdesai) | A2A 프로토콜 구현 라이브러리. 에이전트 간 통신 간소화 | ★★ |
| **A2A Validation Tool** (llmx-de) | 크로스 플랫폼 데스크톱 앱. 멀티 에이전트 연결, 세션 관리 | ★★ |
| **a2awebagent** (vishalmysore) | A2A + Selenium 통합. 브라우저 자동화 + 구조화된 결과 기록 | ★★★ |

### 3.10 대안 프레임워크 비교 매트릭스

| 프레임워크 | 프로그래매틱 API | DataPart 검증 | Task 상태 전이 | SSE 검증 | CI 통합 | 언어 |
|-----------|:---:|:---:|:---:|:---:|:---:|:---:|
| a2a-inspector | -- | -- | -- | -- | -- | Python/TS |
| a2a-ui | -- | -- | -- | -- | -- | TypeScript |
| **A2A TCK** | **O** | **스펙 수준** | **O** | **O** | **O** | Python |
| Mokksy MockAgent | O | 목 기반 | O | O | O | Kotlin/JVM |
| @a2a-js/sdk | O | 타입 기반 | InMemory | O | O | TypeScript |
| A2A Python SDK | O | 타입 기반 | 수동 구현 | O | O | Python |
| FastA2A | O | 타입 기반 | InMemory | -- | O | Python |
| Pydantic AI TestModel | O | -- | -- | -- | O | Python |
| a2a-redis | O | -- | O | -- | O | Python |
| **proofport-ai (자체)** | **O** | **O** | **O** | **O** | **O** | **TypeScript** |

결론: **A2A TCK가 공식 적합성 테스트 스위트로 등장했으나, 아직 커스텀 DataPart 스키마 검증이나 도메인 특화 검증은 제공하지 않는다.** 스펙 수준의 적합성은 TCK로 자동화하고, 도메인 특화 검증은 자체 테스트 인프라로 보완하는 것이 현재 최선의 전략이다.

---

## 4. 프로덕션 A2A 에이전트들의 테스팅 패턴

### 4.1 Google ADK 샘플 에이전트

`a2a-samples/` 저장소에는 다양한 프레임워크별 A2A 에이전트 샘플이 포함되어 있다:

| 프레임워크 | 언어 | 테스트 파일 | 테스트 수준 |
|-----------|------|-----------|-----------|
| Google ADK | Python | `test_client.py` | 기본 send/receive |
| LangGraph | Python | `test_client.py` | 기본 send/receive |
| CrewAI | Python | `test_client.py` | 기본 send/receive |
| Semantic Kernel | Python | `test_client.py` | 기본 send/receive |
| Java | Java | 별도 테스트 | 기본 통합 |
| JavaScript | JS | 별도 테스트 | 기본 통합 |

#### 공통 패턴

대부분의 샘플 에이전트 `test_client.py`는 다음과 같은 구조:

```python
async def main():
    client = A2AClient(url="http://localhost:PORT/a2a")

    # 1. 메시지 전송
    response = await client.send_message(message={"role": "user", ...})

    # 2. 결과 출력 (검증이 아닌 출력)
    print(response)
```

**관찰**: Google 공식 샘플조차도 본격적인 테스트 프레임워크가 아닌, **기본적인 smoke test 수준의 클라이언트 코드**만 제공한다.

### 4.2 프로덕션 에이전트의 일반적 테스트 4계층

실제 프로덕션 A2A 에이전트들이 채택하는 테스팅 전략을 분석하면 다음 4계층 패턴이 반복된다:

```
┌─────────────────────────────────────────────────┐
│  Layer 4: LLM Inference Tests                    │
│  실제 LLM API로 TextPart→스킬 라우팅 정확도 검증   │
│  (비결정적, 비용 발생, CI에서는 선택적)              │
├─────────────────────────────────────────────────┤
│  Layer 3: E2E Tests                              │
│  실제 Docker 컨테이너에 HTTP 요청                  │
│  vi.mock() 없음, supertest 없음                   │
├─────────────────────────────────────────────────┤
│  Layer 2: Integration Tests                      │
│  supertest + 모킹된 외부 의존성                     │
│  JSON-RPC 핸들러 + 라우팅 검증                     │
├─────────────────────────────────────────────────┤
│  Layer 1: Unit Tests                             │
│  TaskStore CRUD, EventEmitter, Worker 로직        │
│  모든 외부 의존성 모킹                              │
└─────────────────────────────────────────────────┘
```

#### Layer 1: 단위 테스트

```typescript
// TaskStore CRUD
it('createTask creates task with correct structure', async () => {
  const task = await store.createTask('generate_proof', params, userMessage);
  expect(task.id).toMatch(UUID_REGEX);
  expect(task.status.state).toBe('queued');
});

// 상태 전이 규칙
it('rejects invalid transition: completed->running', async () => {
  await expect(store.updateTaskStatus('task-1', 'running'))
    .rejects.toThrow('Invalid status transition');
});
```

#### Layer 2: 통합 테스트

```typescript
// supertest + 모킹된 Redis
const response = await request(app)
  .post('/a2a')
  .send({
    jsonrpc: '2.0', id: 1,
    method: 'tasks/get',
    params: { id: task.id }
  });
expect(response.body.result.status.state).toBe('queued');
```

#### Layer 3: E2E 테스트

```typescript
// 실제 Docker 컨테이너에 HTTP
const res = await fetch('http://localhost:4002/a2a', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'message/send',
    params: { message: { role: 'user', parts: [...] } }
  })
});
const json = await res.json();
expect(json.result.status.state).toBe('completed');
```

#### Layer 4: LLM 추론 테스트

```typescript
// 실제 Gemini API로 라우팅 검증
const result = await inferSkill('list supported circuits', geminiProvider);
expect(result?.skill).toBe('get_supported_circuits');
```

### 4.3 검증 책임 분배

현재 A2A 에코시스템에서 검증 책임은 다음과 같이 분배된다:

| 검증 영역 | 책임 주체 | 이유 |
|-----------|----------|------|
| Agent Card 구조 | 각 에이전트 자체 테스트 | 스펙 준수는 에이전트 책임 |
| JSON-RPC 형식 | 각 에이전트 자체 테스트 | 프레임워크마다 다른 구현 |
| Task 상태 전이 | 각 에이전트 자체 테스트 | 비즈니스 로직과 밀접 |
| DataPart 스키마 | **검증 주체 부재** | 애플리케이션별 스키마가 다름 |
| SSE 프로토콜 | **검증 주체 부재** | 범용 검증 도구 없음 |
| Push Notification | **검증 주체 부재** | 구현체 자체가 드묾 |
| Cross-agent 통신 | **검증 주체 부재** | 표준 테스트 시나리오 없음 |

"검증 주체 부재"로 표시된 영역이 현재 A2A 에코시스템의 테스팅 공백이다.

---

## 5. A2A 프로토콜 스펙이 요구하는 테스트 영역

### 5.1 Task 상태 머신

A2A 스펙이 정의하는 Task 상태와 유효한 전이:

```
                    ┌──────────┐
                    │ submitted│
                    └────┬─────┘
                         │
                    ┌────v─────┐
               ┌────│ working  │────┐
               │    └────┬─────┘    │
               │         │         │
          ┌────v────┐    │    ┌────v────┐
          │completed│    │    │  failed │
          └─────────┘    │    └─────────┘
                    ┌────v─────────┐
                    │input-required│
                    └──────────────┘

          * → canceled (어떤 상태에서든 취소 가능)
```

#### 유효한 전이

| From | To | 설명 |
|------|-----|------|
| submitted | working | 작업 시작 |
| working | completed | 정상 완료 |
| working | failed | 오류 발생 |
| working | input-required | 추가 입력 필요 |
| input-required | working | 입력 제공 후 재개 |
| * (any) | canceled | 취소 |

#### 무효한 전이 (반드시 거부해야 함)

| From | To | 이유 |
|------|-----|------|
| completed | working | 완료된 Task 재시작 불가 |
| completed | submitted | 완료된 Task 초기화 불가 |
| failed | submitted | 실패한 Task 초기화 불가 |
| failed | working | 실패한 Task 재시작 불가 |
| canceled | working | 취소된 Task 재시작 불가 |
| canceled | submitted | 취소된 Task 초기화 불가 |

#### 검증 필수 사항

```typescript
// 1. 모든 유효 전이가 작동하는지
// 2. 모든 무효 전이가 거부되는지
// 3. 전이 시 timestamp가 갱신되는지
// 4. 전이 시 statusMessage가 올바르게 설정되는지
// 5. 전이 시 이벤트가 올바르게 발행되는지
```

### 5.2 SSE Streaming (message/stream)

#### 프로토콜 요구사항

| 요구사항 | 설명 |
|----------|------|
| Content-Type | `text/event-stream` |
| 각 SSE data 필드 | JSON-RPC 2.0 Response (`SendStreamingMessageResponse`) |
| TaskStatusUpdateEvent | `{ taskId, contextId, kind: "status-update", status, final? }` |
| TaskArtifactUpdateEvent | `{ taskId, contextId, kind: "artifact-update", artifact, final? }` |
| `final=true` 후 | 서버가 SSE 연결 종료 |
| Keepalive | 주기적 `:keepalive\n\n` 코멘트 |

#### 검증 필수 사항

```typescript
// 1. Content-Type 헤더가 text/event-stream인지
// 2. 각 SSE 이벤트가 "data: " 접두사 + JSON-RPC envelope을 가지는지
// 3. status-update 이벤트의 상태가 올바른 순서인지
//    (queued -> running -> completed, 순서 역전 없음)
// 4. artifact-update 이벤트가 completed 전에 도착하는지
// 5. final=true 이벤트 후 스트림이 종료되는지
// 6. 클라이언트 연결 해제 시 서버 리소스가 정리되는지
```

### 5.3 DataPart

A2A 스펙에서 DataPart의 정의:

```typescript
interface DataPart {
  type: "data";       // 또는 kind: "data"
  data: any;          // 임의의 JSON object
  metadata?: object;  // 선택적 메타데이터
}
```

**핵심**: 스펙은 `data` 필드의 구조를 정의하지 않는다. 스키마 검증은 **애플리케이션 레벨 책임**이다.

이는 다음을 의미한다:
- a2a-inspector가 DataPart를 JSON pretty-print만 하는 것은 스펙 수준에서는 문제가 아님
- 그러나 **프로덕션 에이전트**에서는 애플리케이션 레벨 스키마 검증이 **필수**
- proofport-ai의 `proof`, `publicInputs`, `nullifier` 등의 필드 검증은 자체 테스트로 해결해야 함

### 5.4 Push Notification

#### 프로토콜 요구사항

| 요구사항 | 설명 |
|----------|------|
| 등록 | `tasks/pushNotificationConfig/set`으로 webhook URL 등록 |
| 전달 | 서버가 상태 변경 시 webhook POST (StreamResponse 형식) |
| 인증 | `PushNotificationConfig.authentication` 필드 |
| 순서 | 이벤트 순서 보장 필수 |

**현실**: Push Notification을 구현한 A2A 에이전트가 극소수이며, 검증 도구도 전무하다. proofport-ai는 `capabilities.pushNotifications: false`로 설정되어 있어 현재는 해당 없음.

### 5.5 Agent Card Discovery

#### 필수 필드

```json
{
  "name": "string (필수)",
  "url": "string (필수)",
  "version": "string (필수)",
  "protocolVersion": "string (필수)",
  "capabilities": {
    "streaming": "boolean",
    "pushNotifications": "boolean",
    "stateTransitionHistory": "boolean"
  },
  "skills": [{
    "id": "string (필수)",
    "name": "string (필수)",
    "description": "string",
    "tags": ["string"],
    "examples": ["string"],
    "inputModes": ["string"],
    "outputModes": ["string"]
  }]
}
```

#### 선택 필드

- `securitySchemes`: 인증 방식 (x402, OAuth, API Key 등)
- `identity`: 에이전트 온체인 ID (ERC-8004 등)
- `provider`: 조직 정보

---

## 6. proofport-ai 현재 테스트 수준 평가

### 6.1 테스트 파일 인벤토리

| 카테고리 | 파일 | 테스트 수 | 커버리지 |
|----------|------|:---:|----------|
| **Unit** | `tests/a2a/taskHandler.test.ts` | 35 | TaskStore CRUD, JSON-RPC 핸들러, 상태 전이, LLM 라우팅 |
| **Unit** | `tests/a2a/streaming.test.ts` | 17 | TaskEventEmitter, attachSseStream, SSE envelope |
| **Unit** | `tests/a2a/agentCard.test.ts` | 21 | Agent Card 구조, 필드 검증, ERC-8004 주소 |
| **Unit** | `tests/a2a/taskWorker.test.ts` | 17 | Worker 라이프사이클, 스킬 실행, TEE 라우팅 |
| **Integration** | `tests/a2a/integration.test.ts` | 5 | supertest로 Agent Card + JSON-RPC 통합 |
| **E2E** | `tests/e2e/endpoints.test.ts` | 58 | 실제 Docker 컨테이너: REST/A2A/MCP 전체 엔드포인트 |
| **E2E** | `tests/e2e/multi-turn-flow.test.ts` | 56 | Multi-turn 플로우: REST/A2A/MCP/Cross-protocol/Context linking |
| **E2E** | `tests/e2e/x402-e2e.test.ts` | 24 | 실제 Base Sepolia x402 결제 플로우 |
| **LLM** | `tests/e2e/a2a-llm-inference.test.ts` | 14 | 실제 Gemini API: 영/한/혼합 TextPart 라우팅 |

### 6.2 A2A 스펙 요구사항 대비 커버리지

| 스펙 요구사항 | 커버리지 | 테스트 위치 | 수준 |
|--------------|:---:|------------|------|
| Agent Card 필수 필드 | **O** | `agentCard.test.ts` | 21개 필드 검증 |
| Agent Card skills 구조 | **O** | `agentCard.test.ts` | 3스킬 + 필수 필드 |
| Agent Card securitySchemes | **O** | `agentCard.test.ts` | x402 검증 |
| Agent Card identity | **O** | `agentCard.test.ts` | ERC-8004 sepolia/mainnet |
| JSON-RPC 2.0 형식 | **O** | `taskHandler.test.ts` | 유효/무효 형식 |
| JSON-RPC 에러 코드 | **O** | `taskHandler.test.ts` | -32600, -32601, -32602, -32001, -32002 |
| message/send | **O** | `taskHandler.test.ts` + E2E | TextPart + DataPart |
| message/stream SSE | **O** | `streaming.test.ts` + E2E | 헤더, envelope, keepalive, 종료 |
| tasks/get | **O** | `taskHandler.test.ts` + E2E | 정상/부재/historyLength |
| tasks/cancel | **O** | `taskHandler.test.ts` + E2E | 정상/부재/무효전이 |
| tasks/resubscribe | **O** | `taskHandler.test.ts` | 완료/진행중/부재 |
| Task 상태 전이 (유효) | **O** | `taskHandler.test.ts` #8 | queued->running->completed/failed/canceled |
| Task 상태 전이 (무효) | **O** | `taskHandler.test.ts` #9 | completed->running, failed->queued 거부 |
| DataPart 스키마 | **O** | `taskWorker.test.ts` + E2E | proof, publicInputs, nullifier 구조 검증 |
| Artifact 구조 | **O** | `taskWorker.test.ts` + E2E | id, mimeType, parts 검증 |
| SSE 이벤트 순서 | **부분적** | `streaming.test.ts` | 개별 이벤트 검증, 전체 순서 검증은 E2E |
| Push Notification | **N/A** | -- | capabilities: false |
| 인증 (x402) | **O** | `tests/e2e/x402-e2e.test.ts` + `endpoints.test.ts` | 실제 Base Sepolia 결제 |
| Multi-turn 대화 | **O** | `multi-turn-flow.test.ts` | signing->payment->ready 전체 플로우 |
| Cross-protocol | **O** | `multi-turn-flow.test.ts` | REST 생성 -> A2A 조회 -> MCP 결제 |
| Context linking | **O** | `multi-turn-flow.test.ts` | contextId 자동 해석 |
| TextPart LLM 라우팅 | **O** | `a2a-llm-inference.test.ts` | 영/한/혼합 14개 시나리오 |

### 6.3 proofport-ai의 차별화된 테스트 전략

proofport-ai는 A2A 에코시스템의 도구 부재를 자체적으로 해결한 사례로, 다음과 같은 차별점이 있다:

#### 1) DataPart 스키마 검증 -- 자체 구현

```typescript
// taskWorker.test.ts에서 DataPart 구조 검증
expect(mockTaskStore.addArtifact).toHaveBeenCalledWith(
  'task-generate-123',
  expect.objectContaining({
    mimeType: 'application/json',
    parts: expect.arrayContaining([
      expect.objectContaining({
        kind: 'data',
        mimeType: 'application/json',
        data: expect.objectContaining({
          proof: '0xproof123',
          publicInputs: '0xpublic456',
          nullifier: expect.any(String),
          signalHash: expect.any(String),
          proofId: 'proof-id-1234',
          verifyUrl: expect.any(String),
        }),
      }),
    ]),
  })
);
```

#### 2) Task 상태 전이 -- 유효/무효 모두 검증

```typescript
// 유효 전이 5가지 모두 검증
it('validates: queued->running, running->completed, running->failed, queued->canceled, running->canceled');

// 무효 전이 거부 검증
it('rejects: completed->running, failed->queued');
```

#### 3) SSE 스트리밍 -- JSON-RPC Envelope 검증

```typescript
// streaming.test.ts에서 SSE 이벤트의 JSON-RPC 구조 검증
const sseData = res.write.mock.calls[0][0] as string;
expect(sseData).toContain('data: ');
const parsed = JSON.parse(jsonStr);
expect(parsed.jsonrpc).toBe('2.0');
expect(parsed.id).toBe(42);
expect(parsed.result.id).toBe(taskId);
expect(parsed.result.status).toEqual(status);
expect(parsed.result.final).toBe(false);
```

#### 4) Cross-Protocol 검증 -- REST/A2A/MCP 상호운용

```typescript
// multi-turn-flow.test.ts: REST에서 생성, A2A에서 조회, MCP에서 결제
describe('Multi-Turn Flow -- Cross-Protocol', () => {
  it('Step 1: REST request_signing creates session');
  it('Step 2: A2A check_status reads the same session');
  it('Step 3: Simulate signing completion');
  it('Step 4: MCP check_status after signing shows correct phase');
});
```

#### 5) LLM 추론 검증 -- 실제 Gemini API

```typescript
// a2a-llm-inference.test.ts: 다국어 TextPart 라우팅
it('KO: "지원하는 회로 목록 보여줘" -> get_supported_circuits');
it('KO: "coinbase_attestation 증명 생성해줘" -> request_signing or generate_proof');
it('MX: "coinbase_attestation 서킷의 myapp.com 으로 proof 생성해줘" -> request_signing');
```

### 6.4 테스트 수 요약

| 계층 | 파일 수 | 테스트 수 | 외부 의존성 |
|------|:---:|:---:|-----------|
| Unit | 4 | ~90 | 모두 모킹 |
| Integration | 1 | ~5 | Redis 모킹, Express 실제 |
| E2E | 4 | ~138 | Docker 컨테이너 실행 필요 |
| LLM | 1 | ~14 | Gemini API 키 필요 |
| **합계** | **10** | **~247+** | -- |

---

## 7. 개선 권장사항 및 로드맵

### 7.1 즉시 개선 가능 (단기 1-2주)

#### 7.1.1 A2A Protocol Conformance Test Suite

현재 테스트는 비즈니스 로직 중심이다. A2A 스펙 준수를 전용으로 검증하는 테스트 스위트를 별도로 만들면 프로토콜 업그레이드(현재 0.3.0) 시 영향 범위를 즉시 파악할 수 있다.

```typescript
// tests/a2a/conformance.test.ts (신규 제안)
describe('A2A Protocol Conformance v0.3.0', () => {
  // Agent Card
  describe('Agent Card Discovery', () => {
    it('GET /.well-known/agent-card.json returns valid card');
    it('card.protocolVersion matches "0.3.0"');
    it('all skills have required fields: id, name, description');
    it('capabilities flags are boolean');
  });

  // JSON-RPC 2.0
  describe('JSON-RPC 2.0 Compliance', () => {
    it('response always includes jsonrpc: "2.0"');
    it('response id matches request id');
    it('error response has code (integer) and message (string)');
    it('method not found returns -32601');
    it('invalid params returns -32602');
    it('parse error returns -32700');
  });

  // Task Lifecycle
  describe('Task State Machine', () => {
    for (const [from, to, valid] of STATE_TRANSITIONS) {
      it(`${from} -> ${to} is ${valid ? 'allowed' : 'rejected'}`);
    }
  });

  // SSE Protocol
  describe('SSE Streaming', () => {
    it('Content-Type is text/event-stream');
    it('each event is "data: {json}\\n\\n" format');
    it('final=true event closes the stream');
    it('status updates arrive in valid order');
  });
});
```

#### 7.1.2 DataPart 스키마 검증 유틸리티

각 스킬의 응답 DataPart를 Zod 스키마로 정의하여, 테스트와 런타임 모두에서 활용:

```typescript
// src/a2a/schemas.ts (신규 제안)
import { z } from 'zod';

export const GenerateProofResult = z.object({
  proof: z.string().regex(/^0x[0-9a-fA-F]+$/),
  publicInputs: z.string().regex(/^0x[0-9a-fA-F]+$/),
  nullifier: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  signalHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  proofId: z.string().min(1),
  verifyUrl: z.string().url(),
});

export const VerifyProofResult = z.object({
  valid: z.boolean(),
  circuitId: z.string(),
  verifierAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chainId: z.string(),
  error: z.string().optional(),
});

export const GetCircuitsResult = z.object({
  circuits: z.array(z.object({
    id: z.string(),
    displayName: z.string(),
    description: z.string(),
    verifierAddress: z.string().optional(),
  })),
  chainId: z.string().optional(),
});
```

테스트에서의 활용:

```typescript
// E2E 테스트에서
const data = extractDataFromArtifacts(json.result.artifacts);
const parsed = GenerateProofResult.safeParse(data);
expect(parsed.success).toBe(true);
if (!parsed.success) console.error(parsed.error.issues);
```

### 7.2 중기 개선 (2-4주)

#### 7.2.1 SSE 스트리밍 순서 검증 강화

현재 개별 이벤트의 구조는 검증하지만, **전체 이벤트 시퀀스의 순서**를 체계적으로 검증하는 테스트 추가:

```typescript
// tests/e2e/sse-sequence.test.ts (신규 제안)
describe('SSE Event Sequence Validation', () => {
  it('generate_proof SSE sequence: status(running) -> artifact -> status(completed, final)', async () => {
    const res = await fetch(`${BASE_URL}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'message/stream',
        params: { message: { role: 'user', parts: [/* DataPart */] } }
      }),
    });

    const events = parseSseEvents(await res.text());

    // 이벤트 종류 시퀀스 추출
    const sequence = events.map(e => {
      if (e.result?.status) return `status:${e.result.status.state}`;
      if (e.result?.artifact) return 'artifact';
      return 'unknown';
    });

    // 순서 검증
    expect(sequence[0]).toBe('status:running');
    expect(sequence).toContain('artifact');
    expect(sequence[sequence.length - 1]).toMatch(/status:(completed|failed)/);

    // final 플래그 검증
    const lastEvent = events[events.length - 1];
    expect(lastEvent.result.final).toBe(true);

    // 중간 이벤트들은 final=false
    for (const event of events.slice(0, -1)) {
      if (event.result?.final !== undefined) {
        expect(event.result.final).toBe(false);
      }
    }
  });
});
```

#### 7.2.2 Negative Path 테스트 확장

현재 테스트는 happy path가 주를 이룬다. 다음 negative path 시나리오 추가:

| 시나리오 | 현재 | 추가 필요 |
|----------|:---:|:---:|
| 잘못된 JSON body | O | -- |
| 존재하지 않는 Task ID | O | -- |
| 무효 상태 전이 | O | -- |
| Redis 연결 실패 시 | -- | O |
| 동시 Task 처리 충돌 | 부분 | O |
| SSE 연결 중 서버 에러 | -- | O |
| 매우 큰 DataPart (>1MB) | -- | O |
| 만료된 requestId 접근 | O | -- |
| x402 결제 실패 후 재시도 | -- | O |
| Worker 처리 중 Redis 타임아웃 | -- | O |

#### 7.2.3 Performance Benchmark 테스트

```typescript
// tests/benchmark/throughput.test.ts (신규 제안)
describe('A2A Performance', () => {
  it('get_supported_circuits responds under 200ms', async () => {
    const start = performance.now();
    await jsonPost('/a2a', {
      jsonrpc: '2.0', id: 1,
      method: 'message/send',
      params: { message: { /* get_supported_circuits */ } }
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });

  it('handles 10 concurrent requests without error', async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      jsonPost('/a2a', {
        jsonrpc: '2.0', id: i,
        method: 'message/send',
        params: { message: { /* get_supported_circuits */ } }
      })
    );
    const results = await Promise.all(promises);
    expect(results.every(r => r.status === 200)).toBe(true);
  });
});
```

### 7.3 장기 개선 (1-3개월)

#### 7.3.1 범용 A2A Conformance Test Kit

현재 A2A 에코시스템에 없는 것을 만들 기회. proofport-ai의 테스트 인프라를 추상화하여 범용 도구로 공개:

```typescript
// @zkproofport/a2a-conformance (공개 패키지 제안)
import { A2AConformanceRunner } from '@zkproofport/a2a-conformance';

const runner = new A2AConformanceRunner({
  agentUrl: 'http://localhost:4002/a2a',
  agentCardUrl: 'http://localhost:4002/.well-known/agent-card.json',
});

const report = await runner.runAll();
// report.agentCard: { passed: 12, failed: 0 }
// report.jsonRpc: { passed: 8, failed: 0 }
// report.taskLifecycle: { passed: 6, failed: 0 }
// report.streaming: { passed: 4, failed: 0 }
```

이는 A2A 에코시스템 전체에 기여할 수 있는 공개 도구가 될 수 있다.

#### 7.3.2 Push Notification 테스트 인프라

proofport-ai가 향후 Push Notification을 지원하게 될 경우:

```typescript
// 테스트용 webhook 서버
const webhookServer = createTestWebhookServer(3999);

// Push Notification 등록
await jsonPost('/a2a', {
  method: 'tasks/pushNotificationConfig/set',
  params: {
    id: taskId,
    pushNotificationConfig: {
      url: 'http://localhost:3999/webhook',
      authentication: { type: 'bearer', token: 'test-token' }
    }
  }
});

// Task 처리 후 webhook 수신 검증
const received = await webhookServer.waitForEvent(taskId, 5000);
expect(received.status.state).toBe('completed');
expect(received.artifacts).toBeDefined();
```

#### 7.3.3 Cross-Agent 통신 테스트

A2A의 본래 목적인 에이전트 간 통신을 테스트:

```typescript
// Agent A (proofport-ai) <-> Agent B (외부 에이전트) 통신 검증
describe('Cross-Agent Communication', () => {
  it('Agent B requests proof generation from proofport-ai via A2A', async () => {
    // Agent B의 관점에서 proofport-ai 호출
    const client = new A2AClient('http://localhost:4002/a2a');
    const task = await client.sendMessage({
      role: 'user',
      parts: [{ kind: 'data', data: { skill: 'generate_proof', ... } }]
    });
    expect(task.status.state).toBe('completed');
  });
});
```

### 7.4 권장사항 우선순위 매트릭스

| 항목 | 영향도 | 난이도 | 우선순위 | 기간 |
|------|:---:|:---:|:---:|------|
| Conformance Test Suite | 높음 | 낮음 | **P0** | 1주 |
| DataPart Zod 스키마 | 높음 | 낮음 | **P0** | 3일 |
| SSE 시퀀스 검증 | 중간 | 중간 | P1 | 1주 |
| Negative Path 확장 | 중간 | 낮음 | P1 | 1주 |
| Performance Benchmark | 낮음 | 낮음 | P2 | 3일 |
| 범용 Conformance Kit | 높음 | 높음 | P2 | 1-2개월 |
| Push Notification 테스트 | 낮음 | 중간 | P3 | 기능 구현 시 |
| Cross-Agent 테스트 | 중간 | 높음 | P3 | 2-3개월 |

---

## 8. 결론

### 8.1 현황 요약

A2A 프로토콜 테스팅 에코시스템의 현재 상태:

1. **기존 도구(a2a-inspector, a2a-ui)는 수동 탐색 도구**이며, 프로덕션 수준의 자동화 테스트를 지원하지 않는다. TextPart 렌더링과 기본적인 JSON 표시가 전부이고, DataPart 스키마 검증, Task 상태 전이 규칙 검증, SSE 프로토콜 준수 검증은 모두 불가능하다.

2. **대안 프레임워크(A2A Python SDK, FastA2A 등)는 클라이언트/서버 라이브러리**이며, 전용 테스팅 프레임워크가 아니다. 타입 모델을 활용한 기본 검증은 가능하나, A2A 프로토콜 적합성 자동 검증 기능은 없다.

3. **프로덕션 A2A 에이전트들은 자체 테스트 인프라를 구축**한다. Google ADK 샘플조차 기본적인 smoke test 수준의 클라이언트 코드만 제공하며, 범용 테스팅 프레임워크를 사용하지 않는다.

4. **A2A 에코시스템에 범용 conformance test suite는 존재하지 않는다.** 이는 프로토콜이 아직 초기 단계(v0.3.0)이기 때문이며, 에코시스템이 성숙해지면서 해결될 가능성이 있다.

### 8.2 proofport-ai의 위치

proofport-ai는 현재 A2A 에코시스템에서 **가장 포괄적인 자체 테스트 인프라**를 보유한 에이전트 중 하나이다:

- **174개 이상의 테스트**가 4계층(Unit/Integration/E2E/LLM)에 걸쳐 분포
- **DataPart 스키마 검증**을 TaskWorker 레벨에서 수행
- **Task 상태 전이 규칙**의 유효/무효 전이 모두 검증
- **SSE 스트리밍**의 JSON-RPC envelope 구조 검증
- **Cross-protocol 검증** (REST/A2A/MCP 상호운용)
- **Multi-turn 대화 플로우** 전체 검증 (signing -> payment -> ready)
- **LLM 추론 검증**을 실제 Gemini API로 수행 (영/한/혼합)
- **x402 결제 검증**을 실제 Base Sepolia에서 수행

### 8.3 핵심 메시지

> **"A2A 프로토콜 테스팅의 정답은 아직 정해지지 않았다."**
>
> 기존 도구의 한계를 인식하고, 자체 테스트 인프라를 구축하며, 향후 에코시스템의 성숙에 기여할 수 있는 범용 도구 공개를 준비하는 것이 현 시점의 최선의 전략이다.

---

## 9. 참고 자료

### 9.1 공식 자료

| 자료 | URL |
|------|-----|
| A2A Protocol Specification | https://google.github.io/A2A/ |
| A2A GitHub Organization | https://github.com/a2aproject |
| A2A Samples | https://github.com/a2aproject/a2a-samples |
| A2A Python SDK | https://pypi.org/project/a2a-sdk/ |
| A2A TCK (적합성 테스트) | https://github.com/a2aproject/a2a-tck |
| A2A JavaScript SDK | https://github.com/a2aproject/a2a-js |

### 9.2 도구 및 프레임워크

| 도구 | URL |
|------|-----|
| a2a-inspector | https://github.com/a2aproject/a2a-inspector |
| a2a-ui (community) | https://github.com/a2a-community/a2a-ui |
| a2a-ui (a2anet) | https://github.com/a2anet/a2a-ui |
| FastA2A (Pydantic) | https://github.com/pydantic/fasta2a |
| Pydantic AI | https://ai.pydantic.dev/ |
| a2a-redis | https://github.com/redis-developer/a2a-redis |
| a2awebagent | https://github.com/vishalmysore/a2awebagent |
| python-a2a | https://github.com/themanojdesai/python-a2a |
| Mokksy MockAgentServer | https://mokksy.dev/docs/ai-mocks/a2a/ |

### 9.3 proofport-ai 테스트 파일

| 파일 | 경로 |
|------|------|
| TaskHandler Unit | `tests/a2a/taskHandler.test.ts` |
| Streaming Unit | `tests/a2a/streaming.test.ts` |
| AgentCard Unit | `tests/a2a/agentCard.test.ts` |
| TaskWorker Unit | `tests/a2a/taskWorker.test.ts` |
| Integration | `tests/a2a/integration.test.ts` |
| E2E Endpoints | `tests/e2e/endpoints.test.ts` |
| E2E Multi-Turn | `tests/e2e/multi-turn-flow.test.ts` |
| LLM Inference | `tests/e2e/a2a-llm-inference.test.ts` |
| x402 Payment | `tests/e2e/x402-e2e.test.ts` |
