import React from "react";
import { Field } from "@cloudflare/kumo/components/field";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Radio } from "@cloudflare/kumo/components/radio";
import { Select } from "@cloudflare/kumo/components/select";
import { Switch } from "@cloudflare/kumo/components/switch";
import { Text } from "@cloudflare/kumo/components/text";
import { Trans } from "@lingui/react/macro";
import type { UserPreferences, UserPreferencesPatch } from "./schemas";

type PreferencesFormProps = {
  preferences: UserPreferences;
  pending?: boolean;
  title: React.ReactNode;
  description: React.ReactNode;
  onChange: (patch: UserPreferencesPatch) => void;
};

export function PreferencesForm({ preferences, pending = false, title, description, onChange }: PreferencesFormProps) {
  return (
    <LayerCard className="space-y-8 p-6">
      <div className="space-y-2">
        <Text variant="heading2" as="h2">{title}</Text>
        <Text variant="secondary" as="p">{description}</Text>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Radio.Group
          legend="主题"
          value={preferences.theme}
          onValueChange={(value) => {
            if (isTheme(value)) onChange({ theme: value });
          }}
          description={<Trans>选择自动时会跟随系统深色/浅色设置。</Trans>}
        >
          <Radio.Item value="auto" label="自动" />
          <Radio.Item value="light" label="浅色" />
          <Radio.Item value="dark" label="深色" />
        </Radio.Group>

        <Radio.Group
          legend="默认入口"
          value={preferences.defaultTab}
          onValueChange={(value) => {
            if (isDefaultTab(value)) onChange({ defaultTab: value });
          }}
          description={<Trans>登录后优先进入个人视图或管理员视图。</Trans>}
        >
          <Radio.Item value="user" label="个人视图" />
          <Radio.Item value="admin" label="全局管理" />
        </Radio.Group>

        <Select
          label={<Trans>默认用量窗口</Trans>}
          value={preferences.defaultUsageWindow}
          onValueChange={(value) => {
            if (isUsageWindow(value)) onChange({ defaultUsageWindow: value });
          }}
          description={<Trans>用量图表首次打开时使用的时间范围。</Trans>}
        >
          <Select.Option value="24h"><Trans>近 24 小时</Trans></Select.Option>
          <Select.Option value="7d"><Trans>近 7 天</Trans></Select.Option>
          <Select.Option value="30d"><Trans>近 30 天</Trans></Select.Option>
          <Select.Option value="12mo"><Trans>近 12 个月</Trans></Select.Option>
        </Select>

        <Select
          label={<Trans>语言</Trans>}
          value={preferences.language}
          onValueChange={(value) => {
            if (isLanguage(value)) onChange({ language: value });
          }}
          description={<Trans>自动会使用浏览器首选语言。</Trans>}
        >
          <Select.Option value="auto"><Trans>自动</Trans></Select.Option>
          <Select.Option value="zh-CN"><Trans>简体中文</Trans></Select.Option>
          <Select.Option value="en"><Trans>English</Trans></Select.Option>
        </Select>

        <Field label={<Trans>显示密度</Trans>} description={<Trans>紧凑模式会减少列表和卡片留白。</Trans>}>
          <Switch
            checked={preferences.density === "compact"}
            transitioning={pending}
            onCheckedChange={(checked) => onChange({ density: checked ? "compact" : "comfortable" })}
            label={preferences.density === "compact" ? <Trans>紧凑</Trans> : <Trans>舒适</Trans>}
          />
        </Field>

        <Field label={<Trans>预算提醒阈值</Trans>} description={<Trans>达到预算比例后，每个日历日最多发送一次提醒。</Trans>}>
          <Select
            aria-label="预算提醒阈值"
            value={String(preferences.notifications.budgetThreshold)}
            onValueChange={(value) => {
              if (isBudgetThreshold(value)) onChange({ notifications: { budgetThreshold: Number(value) } });
            }}
          >
            <Select.Option value="0.5">50%</Select.Option>
            <Select.Option value="0.8">80%</Select.Option>
            <Select.Option value="0.9">90%</Select.Option>
            <Select.Option value="1">100%</Select.Option>
          </Select>
        </Field>
      </div>

      <Switch.Group legend="邮件通知" description={<Trans>通知会通过 MailChannels 发送到当前登录邮箱。</Trans>}>
        <Switch.Item
          label="预算阈值提醒"
          checked={preferences.notifications.budgetThresholdEnabled}
          transitioning={pending}
          onCheckedChange={(checked) => onChange({ notifications: { budgetThresholdEnabled: checked } })}
        />
        <Switch.Item
          label="Key 即将过期"
          checked={preferences.notifications.keyExpirySoon}
          transitioning={pending}
          onCheckedChange={(checked) => onChange({ notifications: { keyExpirySoon: checked } })}
        />
        <Switch.Item
          label="Key 创建确认"
          checked={preferences.notifications.keyCreation}
          transitioning={pending}
          onCheckedChange={(checked) => onChange({ notifications: { keyCreation: checked } })}
        />
      </Switch.Group>
    </LayerCard>
  );
}

function isTheme(value: string): value is UserPreferences["theme"] {
  return value === "auto" || value === "light" || value === "dark";
}

function isDefaultTab(value: string): value is UserPreferences["defaultTab"] {
  return value === "user" || value === "admin";
}

function isUsageWindow(value: unknown): value is UserPreferences["defaultUsageWindow"] {
  return value === "6h" || value === "24h" || value === "48h" || value === "7d" || value === "30d" || value === "12mo";
}

function isLanguage(value: unknown): value is UserPreferences["language"] {
  return value === "auto" || value === "zh-CN" || value === "en";
}

function isBudgetThreshold(value: unknown): value is string {
  return value === "0.5" || value === "0.8" || value === "0.9" || value === "1";
}
