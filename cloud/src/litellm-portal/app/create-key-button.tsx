import React, { useCallback, useState } from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Combobox } from "@cloudflare/kumo/components/combobox";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Field } from "@cloudflare/kumo/components/field";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input";
import { Text } from "@cloudflare/kumo/components/text";
import { useToast } from "../hooks/use-toast";
import { useCreateKey } from "../hooks/use-create-key";
import { useDashboard } from "../hooks/use-dashboard";
import {
  createKeyErrorMessage,
  durationFromSelectValue,
  selectedModelsFromValue,
  NEVER_EXPIRES_VALUE,
  DURATION_OPTIONS,
} from "./utils";
import { PanelCard } from "../ui";

export type CreateKeyResult = {
  rawKey: string;
  keyAlias: string | null;
  expires: string | null;
  keyId: string;
};

export function CreateKeyButton({ onRefresh }: { onRefresh?: () => void } = {}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [alias, setAlias] = useState("");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [budget, setBudget] = useState("");
  const [duration, setDuration] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateKeyResult | null>(null);
  const durationSelectValue = duration || NEVER_EXPIRES_VALUE;
  const createKey = useCreateKey();
  const { data: dashboardData } = useDashboard();
  const models = dashboardData?.models?.models ?? [];

  const resetForm = useCallback(() => {
    setAlias("");
    setSelectedModels([]);
    setBudget("");
    setDuration("");
    setError(null);
    setAliasError(null);
    setResult(null);
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = alias.trim();
    if (!trimmed) {
      setAliasError("请输入 Key 名称");
      return;
    }
    setError(null);
    setAliasError(null);
    const input: Parameters<typeof createKey.mutate>[0] = { keyAlias: trimmed };
    if (selectedModels.length > 0) input.models = selectedModels;
    if (budget) {
      const parsed = Number(budget);
      if (Number.isFinite(parsed) && parsed >= 0) input.maxBudget = parsed;
    }
    if (duration) input.duration = duration;

    createKey.mutate(input, {
      onSuccess: (data) => {
        setResult({
          rawKey: data.rawKey,
          keyAlias: data.keyAlias,
          expires: data.expires,
          keyId: data.keyId,
        });
        toast.success("Key 已创建", data.keyAlias ?? trimmed);
        onRefresh?.();
      },
      onError: (err: unknown) => {
        const msg = createKeyErrorMessage(err);
        setAliasError(msg);
        toast.error("创建失败", msg);
      },
    });
  }, [alias, selectedModels, budget, duration, createKey, toast, onRefresh]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      resetForm();
    }
  }, [resetForm]);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger
        render={(props) => (
          <Button {...props} variant="primary" size="sm">
            创建 Key
          </Button>
        )}
      />
      <Dialog size="base" className="space-y-6 p-8">
        <Dialog.Title>
          <Text variant="heading3" as="h2">{result ? "Key 已创建" : "创建新 API Key"}</Text>
        </Dialog.Title>
        <Dialog.Description>
          <Text variant="secondary">
            {result
              ? "请立即复制完整 Key，关闭后无法再次查看。"
              : "创建一个新的 API Key，绑定到当前登录用户。"}
          </Text>
        </Dialog.Description>

        {result ? (
          <div className="space-y-5">
            <Banner
              variant="alert"
              title="请立即复制"
              description="关闭此对话框后将无法再次查看完整 Key。"
            />

            <PanelCard>
              <div className="space-y-1">
                <Text variant="secondary" size="xs" className="font-semibold uppercase tracking-wider">Key 名称</Text>
                <Text variant="heading3" as="p">{result.keyAlias || "—"}</Text>
              </div>
              <div className="mt-4 space-y-2">
                <SensitiveInput
                  label="完整 Key"
                  size="lg"
                  readOnly
                  defaultValue={result.rawKey}
                />
              </div>
              {result.expires ? (
                <div className="mt-4 space-y-1">
                  <Text variant="secondary" size="xs" className="font-semibold uppercase tracking-wider">过期时间</Text>
                  <Text variant="mono" as="p">{result.expires}</Text>
                </div>
              ) : null}
            </PanelCard>

            <div className="flex justify-end">
              <Dialog.Close
                render={(props) => (
                  <Button {...props} variant="primary" size="lg">
                    已复制，关闭
                  </Button>
                )}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {error ? (
              <Banner variant="error" title="创建失败" description={error} />
            ) : null}

            <Field
              label="名称"
              required={true}
              error={aliasError ? { message: aliasError, match: true } : undefined}
            >
              <Input
                id="create-key-alias"
                size="lg"
                placeholder="例如：production-api"
                value={alias}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAlias(e.target.value)}
              />
            </Field>

            {models.length > 0 ? (
              <Combobox
                multiple
                items={models}
                value={selectedModels}
                onValueChange={(value) => setSelectedModels(value as string[])}
                label="允许模型"
                required={false}
                description="留空则继承当前用户可用模型"
                size="lg"
              >
                <Combobox.TriggerMultipleWithInput
                  placeholder="选择模型…"
                  renderItem={(item) => (
                    <Combobox.Chip value={item as string}>{item as string}</Combobox.Chip>
                  )}
                  value={selectedModels}
                />
                <Combobox.Content>
                  <Combobox.List>
                    {(item) => (
                      <Combobox.Item key={item as string} value={item as string}>
                        {item as string}
                      </Combobox.Item>
                    )}
                  </Combobox.List>
                  <Combobox.Empty>无匹配模型</Combobox.Empty>
                </Combobox.Content>
              </Combobox>
            ) : null}

            <Field
              label="预算上限（USD）"
              required={false}
              description="留空表示不限"
            >
              <Input
                id="create-key-budget"
                size="lg"
                type="number"
                min="0"
                step="0.01"
                placeholder="留空表示不限"
                value={budget}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBudget(e.target.value)}
              />
            </Field>

            <div className="space-y-1.5">
              <Select
                label="有效期"
                className="w-full"
                size="lg"
                value={durationSelectValue}
                onValueChange={(value) => setDuration(durationFromSelectValue(value))}
              >
                {DURATION_OPTIONS.map((opt) => (
                  <Select.Option key={opt.value} value={opt.value}>
                    {opt.label}
                  </Select.Option>
                ))}
              </Select>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Dialog.Close
                render={(props) => (
                  <Button {...props} variant="secondary" size="lg">
                    取消
                  </Button>
                )}
              />
              <Button variant="primary" size="lg" loading={createKey.isPending} onClick={handleSubmit}>
                创建
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  );
}
