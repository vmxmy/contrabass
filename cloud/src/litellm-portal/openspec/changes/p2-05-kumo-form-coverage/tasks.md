## 1. Field 包装

- [ ] 1.1 把 CreateKey dialog 内每个 `Input` 包进 `<Field name="..." description="..." error={errors.x}>`
- [ ] 1.2 `Label showOptional={true}` 替换手写 "(可选)"
- [ ] 1.3 `Label labelTooltip="..."` 替换需要解释的字段（如 max_budget 含义）

## 2. Combobox 模型选择

- [ ] 2.1 调研当前模型选择实现（Select 多选 hack？check）
- [ ] 2.2 用 `Combobox.Root` + `.TriggerInput` + `.Chip` 改造为可过滤多选
- [ ] 2.3 模型列表来自 `useDashboard().data.models.models`

## 3. SensitiveInput 新 key 展示

- [ ] 3.1 创建成功后的 dialog 把 raw key 字段从 `ClipboardText` 换为 `SensitiveInput defaultValue={key} readOnly`
- [ ] 3.2 验证 hover 显示复制按钮、点击眼睛图标切换显隐

## 4. 提交按钮

- [ ] 4.1 `<Button loading={mutation.isPending} disabled={!canSubmit}>` 替换手写 spinner

## 5. 错误层

- [ ] 5.1 后端 422（Zod 校验失败）映射到具体字段 error
- [ ] 5.2 401/403 仍走顶层 toast（P2-06 完成后）

## 6. 测试

- [ ] 6.1 更新 RTL 选择器（Field 渲染结构变化）
- [ ] 6.2 新增：必填字段缺失 → submit 后 Field error 出现
- [ ] 6.3 新增：模型多选 chip 添加/移除
- [ ] 6.4 新增：SensitiveInput 默认掩码、点击切换可见

## 7. 验证

- [ ] 7.1 测试全过
- [ ] 7.2 浏览器：完整走一遍 创建 key → 看新 key 默认遮罩 → 复制 → 删除 流程
