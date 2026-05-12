## Why

Portal 唯一的表单 — `CreateKeyButton` 里的对话框 — 仍然手写 label、describer 文本、错误提示，并未使用 kumo 的表单原语。kumo 已经提供：

- `Field`：label + description + error 三要素的统一布局
- `Label`：可选指示器、Tooltip info 图标
- `Combobox`：带 chip 与过滤的多选（替代当前可能存在的模型多选 hack）
- `SensitiveInput`：默认掩码、点击显示、内置复制按钮（适合显示新生成的 key）

## What Changes

- **CreateKey 表单**：所有 Input 用 `Field` 包装，统一 label/description/error 渲染
- **可选字段标识**：`Field` + `Label showOptional={true}` 替代手写 "(可选)" 文本
- **模型多选**：替换为 `Combobox` 配 `multi` 模式，复用 chip 与过滤
- **新建 Key 完成 dialog**：用 `SensitiveInput` 展示生成的 key（默认遮罩，hover 显示复制按钮）替代当前 `ClipboardText` 直接展示明文
- **错误展示**：mutation 错误时表单字段红框 + Field error 文案，而非顶层 banner
- **表单提交**：`Button loading={mutation.isPending}` 替换手写 disabled 状态

## Capabilities

### Modified Capabilities
- **CreateKey 表单 UX**：统一到 kumo 表单语义
- **新生成 key 展示**：默认掩码

## Impact

- **改造**：`CreateKeyButton` 组件
- **新增 import**：`Field`、`Combobox`、`SensitiveInput`
- **测试**：更新 `app.test.tsx` 中 CreateKey 相关查询（input 选择器变化）
- **Breaking**：无对外 API 变化
