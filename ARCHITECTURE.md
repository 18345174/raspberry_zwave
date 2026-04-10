# Raspberry Pi Z-Wave 测试平台最终架构方案

## 1. 文档目标

本文档用于一次性确定本项目的最终整体架构，后续所有开发、扩展、优化、重构、接口补充、测试规则增加，均必须建立在本架构之上进行，不再改变基础架构方向。

本文档同时明确以下强约束：

1. 运行环境固定为树莓派 Ubuntu，不以 macOS 作为运行或调试环境。
2. 项目结构固定为前端 Web + 后端服务。
3. 所有 Z-Wave Controller 连接、设备添加、能力识别、测试执行，必须遵循 Z-Wave 协议规范及 `zwave-js` 官方能力模型。
4. 浏览器不直接操作底层串口，也不直接直连底层 Z-Wave 驱动；所有操作必须经由后端统一编排。

---

## 2. 最终架构结论

### 2.1 架构类型

本项目最终采用以下固定架构：

- **部署模式**：树莓派 Ubuntu 单机部署
- **应用模式**：前端 Web + 后端 Node.js 服务
- **访问模式**：局域网浏览器通过 `http://<raspberry-pi-ip>:8080` 访问
- **Z-Wave 核心实现**：后端直接集成 `zwave-js`
- **实时通信**：前端通过 HTTP + WebSocket 与后端交互
- **测试执行位置**：所有测试规则仅在后端执行
- **数据存储**：本地 SQLite + 本地文件日志

### 2.2 最终技术选型

#### 前端

- `Vue 3`
- `Vite`
- `Pinia`
- WebSocket 客户端
- 构建产物由后端静态托管

#### 后端

- `Node.js LTS`
- `TypeScript`
- `Fastify`
- `ws` 或等价 WebSocket 方案
- `zwave-js`
- `SQLite`

#### 部署与运行

- `systemd` 守护单个后端服务
- 前端打包后作为静态资源由后端统一提供
- 默认监听 `0.0.0.0:8080`

### 2.3 关于 `zwave-js` 与 `zwave-js-server` 的最终决策

本项目**最终主架构只使用 `zwave-js` 作为核心 Z-Wave 运行时**，不把 `@zwave-js/server` 作为主运行进程。

理由如下：

1. 本项目是“测试平台”，不是“通用 Z-Wave 网关转发器”。
2. 测试平台核心需求是自定义测试规则、测试步骤、断言、超时、重试、日志、结果归档，这些更适合直接建立在 `zwave-js` 的驱动、节点、值、Command Class API 之上。
3. 如果把 `@zwave-js/server` 作为核心层，会增加一层 RPC/WebSocket 封装，增加测试编排复杂度。
4. 浏览器本来就不应该直接操作底层 Z-Wave API，因此后端统一封装自己的业务接口更合理。

因此，网页中所谓“启动 Z-Wave JS 服务”，在本项目中的实际含义定义为：

- 用户在前端选择 Controller 串口
- 前端调用后端接口
- 后端在本进程内初始化并启动 `zwave-js` Driver
- 后端开始管理 Controller、节点、Inclusion 流程与测试任务

`@zwave-js/server` 仅保留为**未来可兼容的适配层候选**，不是当前也不是默认的基础架构组成部分。

---

## 3. 运行环境与开发约束

## 3.1 目标运行环境

唯一目标运行环境：

- 硬件：`Raspberry Pi 4B 4G`
- 存储：`64G SD Card`
- 系统：`Ubuntu for Raspberry Pi`
- 架构：`ARM64` 优先
- 网络：树莓派与用户设备位于同一局域网

## 3.2 开发约束

虽然当前开发电脑是 macOS，但本项目必须按照“树莓派 Ubuntu 环境开发”的原则执行，具体要求如下：

1. **不允许把 macOS 作为运行环境、调试环境或验收环境。**
2. **不允许在 macOS 上做功能联调。**
3. macOS 仅作为代码编辑、文档编写、版本管理终端使用。
4. 所有依赖安装验证、服务启动验证、接口联调、Z-Wave Controller 联调、设备入网验证、测试规则执行验证，必须在树莓派 Ubuntu 上完成。
5. 任何脚本、路径、服务配置、系统命令，必须以 Ubuntu 为基准，不以 macOS 命令习惯为准。
6. 代码中不得引入仅适用于 macOS 的路径、串口枚举方式、系统命令或运行假设。
7. 所有调试结论，以树莓派 Ubuntu 实际结果为唯一标准。

这意味着：

- 本地 Mac 不能作为“先跑起来再迁移”的开发路径。
- 项目从第一天开始就必须按 Linux/Ubuntu/ARM 的部署现实来设计。
- 一切与串口、systemd、路径、网络监听、权限相关的实现，都必须以树莓派为准。

---

## 4. 总体拓扑

```text
浏览器
  |
  | HTTP / WebSocket
  v
树莓派 Ubuntu 上的 Web 后端服务
  |
  | Z-Wave Runtime Adapter
  v
zwave-js Driver
  |
  | 串口连接
  v
Z-Wave Controller (USB Stick)
  |
  | Z-Wave 网络
  v
Z-Wave 设备（门锁、开关、传感器等）
```

### 4.1 通信边界

- 浏览器只与后端通信。
- 后端是唯一允许操作 `zwave-js` Driver 的进程。
- 前端不直接接触串口，不直接调用底层 Command Class。
- Controller 与设备相关的所有状态变更，都先进入后端，再由后端整理后推送给前端。

### 4.2 单实例原则

系统中只允许存在**一个活动的 Z-Wave Driver 实例**，避免：

- 同一个串口被多个进程竞争
- 状态源不一致
- 节点缓存重复维护
- inclusion/exclusion 与测试任务相互冲突

---

## 5. 模块划分

## 5.1 前端模块

前端仅负责展示与交互，不承担底层协议逻辑。

前端模块包括：

- `Controller 管理页面`
  - 扫描串口
  - 选择 Controller
  - 发起连接/断开
  - 查看驱动状态
- `设备添加页面`
  - 开始/停止 inclusion
  - 处理安全授权与 DSK/PIN 输入
  - 展示新设备 interview 进度
- `节点列表页面`
  - 展示所有节点
  - 查看节点状态、能力、值
- `测试页面`
  - 选择节点
  - 选择测试项
  - 配置测试参数
  - 查看实时日志和最终结果
- `系统页面`
  - 查看服务健康状态、版本、配置、日志摘要

前端职责限制：

1. 不保存 Controller 运行状态真相。
2. 不在浏览器中实现测试规则。
3. 不在浏览器中拼装底层 Z-Wave 命令。
4. 页面状态以服务端返回与推送为准。

## 5.2 后端模块

后端是系统核心，负责所有设备管理与测试编排。

建议固定为以下模块：

### A. `serial-discovery`
负责扫描和识别串口设备。

职责：

- 扫描 `/dev/serial/by-id/*`
- 扫描 `/dev/ttyACM*`
- 扫描 `/dev/ttyUSB*`
- 识别候选 Z-Wave Controller
- 返回给前端可选择列表
- 记录用户上次选择的稳定串口路径

规则：

- 优先使用 `/dev/serial/by-id/*` 作为长期保存的 Controller 路径。
- 不允许长期依赖 `/dev/ttyACM0` 这类可能漂移的临时路径。

### B. `zwave-runtime`
负责 Z-Wave Driver 生命周期。

职责：

- 基于选定串口初始化 `zwave-js`
- 管理 connect / disconnect / reconnect
- 维护 driver 状态
- 维护 controller 状态
- 接收 node/value/event 更新
- 向系统内部广播标准化事件

### C. `inclusion-service`
负责设备添加与移除流程。

职责：

- 开始 inclusion
- 停止 inclusion
- 开始 exclusion
- 停止 exclusion
- 处理安全等级授权
- 处理 DSK / PIN 验证
- 跟踪设备 interview 状态

### D. `node-registry`
负责节点信息管理。

职责：

- 维护节点快照
- 维护 endpoint 列表
- 维护支持的 Command Classes
- 维护 values 快照
- 提供节点查询接口

### E. `test-engine`
负责测试规则执行。

职责：

- 加载测试定义
- 创建测试任务
- 串行执行测试步骤
- 等待值变化或事件
- 执行断言
- 产生日志与结果
- 写入数据库

### F. `api-gateway`
负责对外 HTTP / WebSocket 接口。

职责：

- 暴露 REST API
- 暴露 WebSocket 事件流
- 做参数校验
- 做错误码转换
- 做鉴权预留

### G. `storage`
负责本地持久化。

职责：

- 保存系统配置
- 保存 Controller 选择记录
- 保存节点快照
- 保存测试定义元数据
- 保存测试执行结果
- 保存关键日志摘要

---

## 6. 最终目录结构约束

项目目录固定建议如下：

```text
.
├── ARCHITECTURE.md
├── frontend/
│   ├── src/
│   │   ├── api/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── stores/
│   │   └── types/
│   └── dist/
├── backend/
│   ├── src/
│   │   ├── app.ts
│   │   ├── server.ts
│   │   ├── api/
│   │   ├── ws/
│   │   ├── services/
│   │   ├── adapters/
│   │   │   └── zwave/
│   │   ├── domain/
│   │   ├── storage/
│   │   ├── test-engine/
│   │   └── utils/
│   └── dist/
├── data/
│   ├── app.db
│   ├── logs/
│   └── zwave/
└── deploy/
    ├── systemd/
    └── scripts/
```

约束说明：

1. 前后端必须物理分目录。
2. 前端最终产物由后端托管。
3. 数据目录与代码目录分离。
4. 部署脚本与 systemd 配置必须单独管理。
5. Z-Wave 相关抽象必须集中在 `backend/src/adapters/zwave` 与 `backend/src/services` 中，禁止散落到页面层。

---

## 7. 核心业务流程

## 7.1 Controller 连接流程

1. 用户将 Z-Wave Controller 插入树莓派。
2. 前端请求后端扫描串口。
3. 后端返回候选串口列表。
4. 用户选择 Controller。
5. 前端请求后端连接该串口。
6. 后端初始化 `zwave-js` Driver。
7. 后端进入 `connecting -> ready` 状态。
8. 后端向前端推送 Driver/Controller 状态。

必须满足：

- 如果 Controller 未连接成功，禁止开始 inclusion。
- 如果 Driver 未 ready，禁止执行测试。
- Controller 串口选择结果必须持久化。

## 7.2 设备添加流程（Inclusion）

1. 用户在前端点击“开始添加设备”。
2. 后端启动 inclusion。
3. 如果协议要求安全授权，后端向前端发送挑战。
4. 用户在前端完成授权或输入 DSK/PIN。
5. 后端继续 inclusion。
6. 新节点加入后，后端跟踪 interview 过程。
7. 节点 interview 完成后，更新节点状态为可测试。

必须满足：

- Inclusion 过程中需要完整暴露安全相关交互。
- 设备只有在 interview 完成且满足测试前置条件后，才允许进入测试阶段。
- Inclusion 期间不得同时启动另一轮 inclusion 或测试任务。

## 7.3 设备测试流程

1. 用户选择一个节点。
2. 前端请求后端获取可执行测试项。
3. 用户选择测试项并填写参数。
4. 后端创建测试任务。
5. `test-engine` 执行步骤。
6. 后端通过 WebSocket 实时推送日志。
7. 测试完成后写入结果并返回结论。

必须满足：

- 测试执行主体只能是后端。
- 测试必须基于节点实际支持的 Command Classes 与 values 执行。
- 不允许前端绕过测试引擎直接下发“业务测试命令”。

---

## 8. Z-Wave 规范遵循原则

本项目中所有与 Z-Wave 设备相关的能力，必须遵循以下开发原则。

## 8.1 总原则

1. 所有 Controller 管理、设备添加、设备控制、值读取、值监听、网络健康相关功能，必须基于 `zwave-js` 官方能力实现。
2. 所有业务测试必须建立在 Z-Wave 设备的实际 Interview 结果之上，而不是写死设备能力。
3. 不允许假设所有设备都支持相同 Command Class、endpoint、property、propertyKey。
4. 不允许绕开 Z-Wave inclusion/security 流程进行“快捷接入”。
5. 不允许把测试逻辑写成与特定设备私有行为强耦合、且没有能力检测前置条件的脚本。

## 8.2 Controller 连接规范

1. Controller 必须通过树莓派本机可识别的串口进行连接。
2. 必须优先使用稳定设备路径（推荐 `/dev/serial/by-id/*`）。
3. 同一时刻只允许一个后端实例持有 Controller 串口。
4. Controller 的连接、断开、重连，必须由后端统一控制。
5. 任何前端页面行为都不得直接操作串口。

## 8.3 Inclusion / Exclusion 规范

1. 设备添加必须通过标准 inclusion 流程实现。
2. 设备移除必须通过标准 exclusion 流程实现。
3. 若设备接入涉及安全等级授权、DSK、PIN 输入，必须在前后端交互中完整实现。
4. 新节点加入后，必须等待 interview 达到可用状态，不能在半初始化状态下直接进入测试。
5. 若 inclusion 失败，必须保留失败原因、时间点和上下文日志。

## 8.4 能力识别规范

1. 节点是否可测，必须根据 Interview 后的实际数据判断。
2. 节点支持哪些测试，不依赖设备名称猜测，必须依据：
   - Command Classes
   - Endpoint 列表
   - Values 列表
   - 安全能力
3. 所有测试执行前，都必须先执行前置能力检查。

## 8.5 测试实现规范

1. 门锁测试必须基于门锁相关 Command Class 能力执行，而不是仅依据节点名称中包含“lock”。
2. 开关测试必须基于开关相关 Command Class 或对应 value 实现。
3. 测试必须包含：
   - 前置条件检查
   - 操作步骤
   - 等待机制
   - 断言机制
   - 超时机制
   - 日志记录
   - 结果归档
4. 测试失败时，必须可定位失败发生在哪一步。
5. 测试日志必须记录关键上下文，例如：节点 ID、endpoint、CC、valueId、期望值、实际值、超时信息。

## 8.6 前后端边界规范

1. 前端可以发起“测试任务”，但不能直接拼装底层 Z-Wave 命令。
2. 底层 `setValue`、`invoke CC API` 等能力只能由后端持有。
3. 对终端用户暴露的接口，应优先是“业务测试动作”，而不是“原始底层透传”。
4. 若需提供调试接口，必须与正式业务接口隔离，并附带权限限制。

---

## 9. 后端核心接口抽象

后端对 Z-Wave 层固定采用适配器抽象，测试引擎只能依赖适配器接口，不能直接依赖具体 Driver 对象的任意内部细节。

推荐固定接口：

```ts
interface IZwaveAdapter {
  scanPorts(): Promise<SerialPortInfo[]>;
  connect(portPath: string): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): Promise<DriverStatus>;
  startInclusion(): Promise<void>;
  stopInclusion(): Promise<void>;
  startExclusion(): Promise<void>;
  stopExclusion(): Promise<void>;
  grantSecurity(requestId: string, payload: SecurityGrantInput): Promise<void>;
  validateDsk(requestId: string, pin: string): Promise<void>;
  listNodes(): Promise<NodeSummary[]>;
  getNode(nodeId: number): Promise<NodeDetail>;
  setValue(input: SetValueInput): Promise<void>;
  invokeCcApi(input: InvokeCcApiInput): Promise<unknown>;
  onEvent(listener: (event: ZwaveEvent) => void): () => void;
}
```

架构约束：

- 第一实现必须是 `zwave-js` 直连适配器。
- 未来如需兼容 `@zwave-js/server`，只能新增适配器实现，不得推翻业务层结构。

---

## 10. 接口草案

以下为应用层接口，不是底层 `zwave-js` 原生命令透传接口。

## 10.1 系统接口

### `GET /api/system/health`
返回服务健康状态。

### `GET /api/system/config`
读取系统配置。

### `PUT /api/system/config`
更新系统配置。

## 10.2 串口与 Controller 接口

### `GET /api/serial/ports`
扫描可用串口。

返回示例：

```json
{
  "items": [
    {
      "path": "/dev/ttyACM0",
      "stablePath": "/dev/serial/by-id/usb-0658_0200-if00",
      "manufacturer": "Silicon Labs",
      "vendorId": "0658",
      "productId": "0200",
      "serialNumber": "0001",
      "isCandidateController": true
    }
  ]
}
```

### `POST /api/serial/select`
选择并保存 Controller 路径。

请求示例：

```json
{
  "path": "/dev/serial/by-id/usb-0658_0200-if00"
}
```

### `GET /api/zwave/status`
读取当前 Z-Wave Driver 状态。

### `POST /api/zwave/connect`
连接已选择的 Controller。

### `POST /api/zwave/disconnect`
断开当前 Controller。

### `POST /api/zwave/reconnect`
重连当前 Controller。

## 10.3 Inclusion / Exclusion 接口

### `POST /api/zwave/inclusion/start`
开始 inclusion。

### `POST /api/zwave/inclusion/stop`
停止 inclusion。

### `POST /api/zwave/exclusion/start`
开始 exclusion。

### `POST /api/zwave/exclusion/stop`
停止 exclusion。

### `POST /api/zwave/inclusion/grant-security`
处理安全等级授权。

请求示例：

```json
{
  "requestId": "inc_req_001",
  "grant": ["S2_AccessControl", "S2_Authenticated"],
  "clientSideAuth": false
}
```

### `POST /api/zwave/inclusion/validate-dsk`
提交 DSK/PIN。

请求示例：

```json
{
  "requestId": "inc_req_002",
  "pin": "12345"
}
```

## 10.4 节点接口

### `GET /api/nodes`
查询节点列表。

### `GET /api/nodes/:nodeId`
查询节点详情。

### `GET /api/nodes/:nodeId/values`
查询节点 values。

### `POST /api/nodes/:nodeId/refresh`
刷新节点信息。

### `POST /api/nodes/:nodeId/ping`
检查节点可达性。

### `POST /api/nodes/:nodeId/heal`
执行节点网络修复。

### `POST /api/nodes/:nodeId/set-value`
受控地写入一个 value，仅限后端允许的调试场景。

### `POST /api/nodes/:nodeId/invoke-cc`
受控地调用一个 CC API，仅限后端允许的调试场景。

## 10.5 测试接口

### `GET /api/tests/definitions`
获取测试定义列表。

### `GET /api/tests/definitions/:id`
获取测试定义详情。

### `POST /api/tests/run`
创建测试任务。

请求示例：

```json
{
  "testDefinitionId": "lock-basic-v1",
  "nodeId": 12,
  "inputs": {
    "repeat": 3,
    "lockTimeoutMs": 15000,
    "unlockTimeoutMs": 15000
  }
}
```

### `GET /api/tests/runs`
查询测试任务列表。

### `GET /api/tests/runs/:runId`
查询单个测试任务详情。

### `GET /api/tests/runs/:runId/logs`
查询测试日志。

### `POST /api/tests/runs/:runId/cancel`
取消测试任务。

---

## 11. WebSocket 事件草案

前端通过统一 WebSocket 通道接收实时状态。

建议固定为：

- `GET /ws/events`

事件类型固定建议如下：

- `system.health`
- `zwave.status.changed`
- `zwave.driver.log`
- `zwave.controller.updated`
- `zwave.inclusion.started`
- `zwave.inclusion.stopped`
- `zwave.inclusion.challenge`
- `zwave.node.added`
- `zwave.node.updated`
- `zwave.node.removed`
- `zwave.value.updated`
- `test.run.created`
- `test.run.started`
- `test.run.log`
- `test.run.finished`

事件示例：

```json
{
  "type": "zwave.inclusion.challenge",
  "timestamp": "2026-04-10T10:00:00Z",
  "payload": {
    "requestId": "inc_req_001",
    "challengeType": "grant_security_classes",
    "nodeId": 14,
    "requested": ["S2_AccessControl", "S2_Authenticated"]
  }
}
```

---

## 12. 数据模型草案

## 12.1 Controller 选择记录

- `id`
- `selectedPortPath`
- `selectedStablePath`
- `lastConnectedAt`
- `lastStatus`

## 12.2 节点表

- `nodeId`
- `name`
- `manufacturer`
- `product`
- `productCode`
- `firmwareVersion`
- `status`
- `interviewStage`
- `securityClasses`
- `lastSeenAt`
- `isSecure`
- `isListening`

## 12.3 节点 Values 表

- `nodeId`
- `endpoint`
- `commandClass`
- `property`
- `propertyKey`
- `value`
- `unit`
- `label`
- `lastUpdatedAt`

## 12.4 测试定义表

- `id`
- `key`
- `name`
- `deviceType`
- `version`
- `enabled`
- `inputSchemaJson`

## 12.5 测试运行表

- `id`
- `testDefinitionId`
- `nodeId`
- `status`
- `startedAt`
- `finishedAt`
- `durationMs`
- `summaryJson`
- `resultJson`

## 12.6 测试日志表

- `id`
- `testRunId`
- `timestamp`
- `level`
- `stepKey`
- `message`
- `payloadJson`

---

## 13. 测试规则架构要求

测试规则必须采用“后端定义、后端执行、结果可追踪”的架构，不做浏览器侧脚本化执行。

### 13.1 规则定义方式

第一原则：测试规则使用 TypeScript 编写。

原因：

- 可维护性高
- 类型明确
- 适合复杂逻辑
- 便于做超时、重试、断言和上下文记录

### 13.2 单个测试定义必须包含

- 基本信息
- 适配设备判断逻辑
- 前置条件检查
- 步骤序列
- 断言逻辑
- 超时控制
- 失败处理
- 日志记录
- 最终结果输出

### 13.3 示例测试类型

- 门锁基础开关测试
- 二进制开关通断测试
- 传感器上报验证测试
- 节点健康检查测试
- Lifeline 上报验证测试

### 13.4 门锁测试强约束

门锁测试必须遵循以下规则：

1. 必须先确认节点实际支持门锁相关 CC。
2. 必须在执行前确认节点在线或处于可交互状态。
3. 必须记录 lock 与 unlock 两个方向的执行和回报。
4. 必须区分“命令下发成功”和“设备状态已确认变更”两个概念。
5. 必须支持超时失败。
6. 必须输出失败所在步骤与上下文值。

---

## 14. 并发与任务约束

为了降低树莓派资源压力并避免状态竞争，固定采用以下约束：

1. 同一时刻只允许一个 Z-Wave Driver 实例。
2. 同一时刻只允许一个 inclusion/exclusion 流程。
3. 同一时刻只允许一个正式测试任务运行。
4. inclusion/exclusion 期间不允许运行正式测试。
5. Controller 重连期间所有测试任务必须阻塞或失败返回。

这是架构级限制，不作为可选优化项。

---

## 15. 安全与网络约束

### 15.1 网络访问模型

- 服务监听：`0.0.0.0:8080`
- 使用范围：同一局域网
- 默认访问入口：`http://<raspberry-pi-ip>:8080`

### 15.2 安全要求

第一版即纳入架构的最低安全要求：

1. 系统必须预留登录或 Token 校验机制。
2. WebSocket 连接必须支持鉴权。
3. 调试型底层接口必须与普通业务接口隔离。
4. 不允许直接向浏览器暴露原始 `zwave-js` 控制能力。

---

## 16. 部署与运行约束

### 16.1 服务运行方式

固定采用：

- 一个后端服务进程
- 一个静态前端资源目录
- 一个 SQLite 数据库文件
- 一个 `systemd` 服务配置

### 16.2 systemd 约束

必须提供：

- 开机自动启动
- 崩溃自动重启
- 固定工作目录
- 日志输出到 journald 或本地文件
- 环境变量加载能力

### 16.3 路径约束

建议部署路径固定如下：

- 应用目录：`/opt/zwave-test-platform`
- 数据目录：`/var/lib/zwave-test-platform`
- 日志目录：`/var/log/zwave-test-platform`

---

## 17. 不可违反的架构红线

以下内容属于架构红线，后续开发中不得突破：

1. 不得把浏览器改造成直接控制底层 Z-Wave Runtime 的客户端。
2. 不得把 macOS 作为功能调试或联调环境。
3. 不得把 `@zwave-js/server` 替换成新的主架构中心而推翻现有后端设计。
4. 不得让测试规则直接散落在前端页面代码里。
5. 不得在未完成 interview 的节点上直接执行正式测试。
6. 不得以节点名称猜测设备能力替代真实能力检测。
7. 不得同时运行多个 Z-Wave Driver 实例争抢 Controller。
8. 不得把串口临时路径当作唯一稳定标识长期保存。

---

## 18. 最终架构一句话定义

**本项目是一个运行在树莓派 Ubuntu 上、通过局域网网页访问、以前端展示 + 后端编排为核心、以后端直连 `zwave-js` 为唯一 Z-Wave Runtime、并严格遵循 Z-Wave 标准接入与测试流程的设备测试平台。**

---

## 19. 参考依据

以下资料用于支撑本架构决策：

1. `zwave-js` 官方仓库：核心 Z-Wave 驱动，说明其基于 Node.js、支持已知 500/700/800 系列控制器，并适用于低算力且具备串口的设备。  
   https://github.com/zwave-js/zwave-js
2. `zwave-js-server` 官方仓库：官方将其定位为“包裹在 Z-Wave JS 之外、通过 WebSocket 提供访问的小型服务包装层”，适合作为包装层而不是测试平台主业务层。  
   https://github.com/zwave-js/zwave-js-server
3. `zwave-js-server` 官方 README：列出了 `start_listening`、`controller.begin_inclusion`、`node.set_value`、`endpoint.invoke_cc_api` 等能力，并明确指出默认不处理认证。  
   https://github.com/zwave-js/zwave-js-server
4. `zwave-js-ui` 官方仓库：表明完整 UI、HTTPS、用户认证等能力属于应用层/控制台层，而不是底层驱动层。  
   https://github.com/zwave-js/zwave-js-ui

