## ADDED Requirements

### Requirement: Worker 入口文件保持精简
Worker 入口文件 SHALL 仅保留请求路由分发与错误处理逻辑，不得包含认证、API 客户端调用、用量计算或 HTML 渲染的实现细节。

#### Scenario: 入口文件行数限制
- **WHEN** 检查 `index.ts` 总行数
- **THEN** 其行数 SHALL 不超过 300 行

### Requirement: 服务端渲染的 HTML 安全转义
所有动态插入 HTML 模板的环境变量和用户不可信数据 SHALL 经过 HTML escape 处理，防止 XSS 注入。

#### Scenario: Platform 名称包含恶意脚本
- **WHEN** `LITELLM_PORTAL_DISPLAY_NAME` 包含 `<script>alert(1)</script>`
- **THEN** 渲染的 HTML 页面 SHALL 将脚本标签转义为纯文本显示，不得执行

### Requirement: 共享常量在前后端单一定义
USAGE_WINDOWS、DEFAULT_USAGE_WINDOWS 等前后端共享常量 SHALL 仅在单一 TS 模块中定义，前端通过运行时注入读取，禁止在多处硬编码维护。

#### Scenario: 修改时间窗口选项
- **WHEN** 开发者在 `usage.ts` 中修改 `USAGE_WINDOWS` 常量
- **THEN** 前端下拉选项 SHALL 自动同步，无需再修改 `html.ts` 中的内联 JS

### Requirement: 用量时间序列请求去重
前端用量切换控件 SHALL 在发起新请求前取消尚未完成的旧请求，避免竞态导致的旧数据覆盖新数据。

#### Scenario: 快速切换时间粒度
- **WHEN** 用户在 200ms 内连续切换三次用量粒度
- **THEN** 页面上 SHALL 仅显示最后一次请求的数据，前两次请求的结果不得覆盖最终界面

### Requirement: 团队信息并行获取
当用户属于多个 LiteLLM 团队时，系统 SHALL 并行发起所有团队信息查询，而非串行等待。

#### Scenario: 用户属于三个团队
- **WHEN** 当前用户 `teamIds` 包含三个团队 ID
- **THEN** 系统 SHALL 同时发起三个 `/team/info` 请求，总耗时 SHALL 接近单个请求耗时而非三倍

### Requirement: React 组件具备单元测试
`app.tsx` 中的 `ModelAccessCard` 组件 SHALL 具备单元测试，覆盖初始状态、Collapsible 展开/收起交互、以及 CustomEvent 模型更新。

#### Scenario: 模型数量超过预览阈值
- **WHEN** `ModelAccessCard` 接收到超过 12 个模型的事件更新
- **THEN** 组件 SHALL 默认收起模型列表，并显示展开触发器

#### Scenario: CustomEvent 更新模型列表
- **WHEN** 窗口触发 `litellm-portal:models` CustomEvent 并携带新的模型数组
- **THEN** `ModelAccessCard` SHALL 更新内部状态并重新渲染模型徽章列表
