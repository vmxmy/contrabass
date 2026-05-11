import type { LiteLLMPortalEnv } from "./types";
import { escapeHtml, htmlResponse } from "./utils";
import { DEFAULT_USAGE_WINDOWS, USAGE_WINDOWS } from "./timeseries";

export function portalCompanyName(env: LiteLLMPortalEnv): string {
  return env.LITELLM_PORTAL_COMPANY_NAME?.trim() || "gz-zhiyun";
}

export function portalDisplayName(env: LiteLLMPortalEnv): string {
  return env.LITELLM_PORTAL_DISPLAY_NAME?.trim() || "智云AI管理平台";
}

export function renderPortalHtml(env: LiteLLMPortalEnv): string {
  const platformName = escapeHtml(portalDisplayName(env));
  const devAuthWarning = env.LITELLM_PORTAL_DEV_AUTH === "true"
    ? "\n  <!-- WARNING: Dev Auth enabled -->"
    : "";
  const portalConfigScript = `
  <script>
    window.__PORTAL_CONFIG = {
      usageWindows: ${JSON.stringify(USAGE_WINDOWS)},
      defaultUsageWindows: ${JSON.stringify(DEFAULT_USAGE_WINDOWS)}
    };
  </script>`;
  return `<!doctype html>
<html lang="zh-CN" data-theme="kumo">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${platformName}</title>
  <link rel="stylesheet" href="/kumo.css">
  <script>
    (() => {
      try {
        const stored = localStorage.getItem('litellm-portal-mode');
        const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
        const mode = stored === 'dark' || stored === 'light' ? stored : prefersDark ? 'dark' : 'light';
        document.documentElement.dataset.mode = mode;
      } catch {
        document.documentElement.dataset.mode = 'light';
      }
    })();
  </script>
</head>
<body class="min-h-screen bg-kumo-canvas text-kumo-default">
  <main class="container mx-auto px-4 py-10 lg:px-10 lg:py-16">
    <header class="mb-12 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div class="space-y-4">
        <span class="inline-flex w-fit items-center rounded-full bg-kumo-info-tint/70 px-2.5 py-1 text-xs font-semibold text-kumo-info">Cloudflare Access 已保护</span>
        <div class="space-y-3">
          <h1 class="text-3xl font-semibold tracking-tight text-kumo-strong lg:text-4xl">${platformName}</h1>
          <p class="max-w-3xl text-base leading-relaxed text-kumo-subtle">面向智云团队的 AI 能力自助台：只读查看个人 API Key、团队可用模型、预算与近 30 天用量，数据权限自动绑定当前登录邮箱。</p>
        </div>
      </div>
      <div id="header-actions-root" class="flex flex-wrap items-center gap-3 sm:self-auto"></div>
    </header>

    <nav id="portal-tabs-root" hidden></nav>

    <div id="user-panel">
    <div id="hero-stats-root" class="mb-14"></div>

    <section id="usage-panel-root" class="mb-14">
      <article id="usage-panel" class="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line" aria-busy="true">
        <div class="border-b border-kumo-line bg-kumo-elevated p-6">
          <p class="text-lg font-semibold text-kumo-strong">Token 用量趋势</p>
          <p class="text-sm leading-relaxed text-kumo-subtle">正在加载用量面板…</p>
        </div>
        <div class="flex items-center justify-center p-8 text-sm text-kumo-subtle">Loading…</div>
      </article>
    </section>
    <section class="mb-10 grid grid-cols-1 gap-5 md:grid-cols-[1fr_2fr]">
      <div id="teams-root">
        <article class="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
          <div class="border-b border-kumo-line bg-kumo-elevated p-6">
            <p class="text-lg font-semibold text-kumo-strong">团队权限</p>
            <p class="text-sm text-kumo-subtle">只展示当前账号所属团队的信息。</p>
          </div>
          <div class="p-6 text-sm text-kumo-subtle">Loading…</div>
        </article>
      </div>

      <div id="models-root">
        <article class="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
          <div class="border-b border-kumo-line bg-kumo-elevated p-6">
            <p class="text-lg font-semibold text-kumo-strong">团队可用模型</p>
            <p class="text-sm text-kumo-subtle">模型清单会随当前账号所属团队变化。</p>
          </div>
          <div class="p-6">
            <span class="inline-flex w-fit items-center rounded-full bg-kumo-fill px-2.5 py-1 text-xs font-medium text-kumo-subtle">Loading…</span>
          </div>
        </article>
      </div>
    </section>

    <div id="keys-root">
      <section class="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div class="flex flex-wrap items-start justify-between gap-3 border-b border-kumo-line bg-kumo-elevated p-6">
          <div>
            <p class="text-lg font-semibold text-kumo-strong">API Keys</p>
            <p class="text-sm text-kumo-subtle">仅列出当前 LiteLLM 用户拥有的密钥。</p>
          </div>
        </div>
        <div class="p-6 text-sm text-kumo-subtle">Loading…</div>
      </section>
    </div>
    </div>

    <div id="admin-root" hidden></div>

    <div id="portal-error-root"></div>
  </main>
${devAuthWarning}${portalConfigScript}
  <script type="module" src="/portal.js"></script>
  <script>
    const list = (value) => Array.isArray(value) ? value : [];
    const api = (path, options) => fetch(path, { ...options, signal: options?.signal, headers: { 'content-type': 'application/json', ...(options && options.headers || {}) } }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Request failed');
      return data;
    });

    function dispatchKeys(keys) {
      window.__litellmPortalKeys = list(keys);
      window.dispatchEvent(new CustomEvent('litellm-portal:keys', { detail: window.__litellmPortalKeys }));
    }
    function dispatchTeams(teams) {
      window.__litellmPortalTeams = list(teams);
      window.dispatchEvent(new CustomEvent('litellm-portal:teams', { detail: window.__litellmPortalTeams }));
    }
    function dispatchStats(data) {
      const stats = {
        email: data.me.email,
        litellmUserId: data.user.litellmUserId,
        totalSpend: data.summary.totalSpend,
        maxBudget: data.user.maxBudget,
        keyBudget: data.summary.keyBudget,
        recentSpend: data.summary.recentSpend,
        usageAvailable: data.usage.available,
        requestCount: data.summary.requestCount,
        totalTokens: data.summary.totalTokens,
        modelCount: data.summary.availableModelCount,
        keyCount: data.summary.keyCount,
        teamCount: data.summary.teamCount,
      };
      window.__litellmPortalStats = stats;
      window.dispatchEvent(new CustomEvent('litellm-portal:stats', { detail: stats }));
    }
    function renderModels(modelAccess) {
      const models = list(modelAccess.models);
      window.__litellmPortalModelAccess = { models, source: modelAccess.source || '' };
      window.dispatchEvent(new CustomEvent('litellm-portal:models', { detail: window.__litellmPortalModelAccess }));
    }
    function showError(message) {
      window.__litellmPortalError = message;
      window.dispatchEvent(new CustomEvent('litellm-portal:error', { detail: message }));
    }
    function hideError() {
      window.__litellmPortalError = null;
      window.dispatchEvent(new CustomEvent('litellm-portal:error', { detail: null }));
    }
    function renderDashboard(data) {
      dispatchStats(data);
      renderModels(data.models);
      dispatchTeams(list(data.teams));
      dispatchKeys(list(data.keys.items));
      hideError();
    }
    async function refresh() {
      try {
        renderDashboard(await api('/api/dashboard'));
      } catch (error) {
        showError(error instanceof Error ? error.message : '页面数据加载失败');
      }
    }
    window.addEventListener('litellm-portal:refresh', () => refresh());
    refresh();
  </script>
</body>
</html>`;
}
