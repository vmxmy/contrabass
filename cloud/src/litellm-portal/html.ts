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
      <div class="flex flex-wrap items-center gap-3 sm:self-auto">
        <button id="theme-toggle" class="group flex h-10 w-max shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-full border border-kumo-line bg-kumo-base px-4 text-sm font-semibold text-kumo-default shadow-none ring-0 hover:bg-kumo-tint focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand" type="button" aria-label="切换深色模式" aria-pressed="false"><span data-theme-label>浅色</span></button>
        <a class="group flex h-10 w-max shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-full border border-kumo-line bg-kumo-base px-4 text-sm font-semibold text-kumo-default shadow-none ring-0 hover:bg-kumo-tint focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand" href="/cdn-cgi/access/logout" aria-label="退出登录"><span>退出登录</span></a>
      </div>
    </header>

    <section class="mb-14 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
      <article class="overflow-hidden rounded-xl bg-kumo-base p-6 ring-1 ring-kumo-line">
        <div class="flex items-center gap-2">
          <span class="inline-block h-2 w-2 rounded-full bg-kumo-info"></span>
          <p class="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">当前身份</p>
        </div>
        <p id="email" class="mt-4 truncate text-2xl font-semibold text-kumo-strong" title="">—</p>
        <p id="litellm-user" class="mt-3 truncate font-mono text-sm text-kumo-subtle">—</p>
      </article>
      <article class="overflow-hidden rounded-xl bg-kumo-base p-6 ring-1 ring-kumo-line">
        <div class="flex items-center gap-2">
          <span class="inline-block h-2 w-2 rounded-full bg-kumo-brand"></span>
          <p class="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">累计花费</p>
        </div>
        <p id="total-spend" class="mt-4 font-mono text-3xl font-semibold leading-tight text-kumo-strong">—</p>
        <div id="budget" class="mt-3 flex min-h-[20px] items-center gap-2 text-sm text-kumo-subtle">预算 —</div>
      </article>
      <article class="overflow-hidden rounded-xl bg-kumo-base p-6 ring-1 ring-kumo-line">
        <div class="flex items-center gap-2">
          <span class="inline-block h-2 w-2 rounded-full bg-kumo-success"></span>
          <p class="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">近 30 天</p>
        </div>
        <p id="recent-spend" class="mt-4 font-mono text-3xl font-semibold leading-tight text-kumo-strong">—</p>
        <p class="mt-3 text-sm text-kumo-subtle"><span id="request-count">—</span> 次请求 · <span id="token-count">—</span> tokens</p>
      </article>
      <article class="overflow-hidden rounded-xl bg-kumo-base p-6 ring-1 ring-kumo-line">
        <div class="flex items-center gap-2">
          <span class="inline-block h-2 w-2 rounded-full bg-kumo-success"></span>
          <p class="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">权限范围</p>
        </div>
        <p class="mt-4 text-3xl font-semibold leading-tight text-kumo-strong"><span id="model-count">—</span> 模型</p>
        <p class="mt-3 text-sm text-kumo-subtle"><span id="key-count">—</span> 个 Key · <span id="team-count">—</span> 个团队</p>
      </article>
    </section>

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
      <article class="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div class="border-b border-kumo-line bg-kumo-elevated p-6">
          <p class="text-lg font-semibold text-kumo-strong">团队权限</p>
          <p class="text-sm text-kumo-subtle">只展示当前账号所属团队的信息。</p>
        </div>
        <div class="overflow-x-auto p-6">
          <table class="w-full text-left text-sm text-kumo-default">
            <thead>
              <tr class="border-b border-kumo-line">
                <th class="pb-3 pr-3 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">团队</th>
                <th class="pb-3 pr-3 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">模型</th>
                <th class="pb-3 pr-3 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">花费</th>
                <th class="pb-3 pr-3 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">预算</th>
                <th class="pb-3 pr-3 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">RPM</th>
                <th class="pb-3 pr-3 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">TPM</th>
              </tr>
            </thead>
            <tbody id="teams"><tr><td colspan="6" class="py-3 text-kumo-subtle">Loading…</td></tr></tbody>
          </table>
        </div>
      </article>

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

    <div id="portal-error-root"></div>
  </main>
${devAuthWarning}${portalConfigScript}
  <script type="module" src="/portal.js"></script>
  <script>
    const byId = (id) => document.getElementById(id);
    const numberFormatter = new Intl.NumberFormat('zh-CN');
    const fmt = (n) => '$' + Number(n || 0).toFixed(2);
    const fmtInt = (n) => numberFormatter.format(Number(n || 0));
    const text = (value) => value == null || value === '' ? '—' : String(value);
    const list = (value) => Array.isArray(value) ? value : [];
    const api = (path, options) => fetch(path, { ...options, signal: options?.signal, headers: { 'content-type': 'application/json', ...(options && options.headers || {}) } }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Request failed');
      return data;
    });

    function node(tag, className, value) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (value !== undefined) element.textContent = value;
      return element;
    }
    function cell(value, align = 'left', compact = false) {
      const el = node('td', (compact ? 'py-2 ' : 'py-3 ') + 'pr-3 ' + (align === 'right' ? 'text-right font-mono ' : '') + 'text-kumo-default', text(value));
      return el;
    }
    function emptyRow(message, colSpan) {
      const row = document.createElement('tr');
      const item = node('td', 'py-3 text-kumo-subtle', message);
      item.colSpan = colSpan;
      row.append(item);
      return row;
    }

    function pillNode(type, label) {
      const span = document.createElement('span');
      span.className = 'ml-2 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ' +
        (type === 'danger' ? 'bg-kumo-danger-tint text-kumo-danger' :
         type === 'warning' ? 'bg-kumo-warning-tint text-kumo-warning' :
         type === 'success' ? 'bg-kumo-success-tint text-kumo-success' :
         'bg-kumo-info-tint text-kumo-info');
      span.textContent = label;
      return span;
    }
    function budgetPill(spend, maxBudget) {
      if (maxBudget == null) return null;
      const ratio = Number(spend || 0) / Number(maxBudget);
      if (ratio >= 1) return pillNode('danger', '超预算');
      if (ratio >= 0.8) return pillNode('warning', '即将超支');
      return pillNode('success', '正常');
    }
    function moneyCell(value, spend, maxBudget) {
      const td = document.createElement('td');
      td.className = 'py-3 pr-3 text-right font-mono text-kumo-default';
      td.textContent = text(value);
      const pill = budgetPill(spend, maxBudget);
      if (pill) td.append(pill);
      return td;
    }
    function dispatchKeys(keys) {
      window.__litellmPortalKeys = list(keys);
      window.dispatchEvent(new CustomEvent('litellm-portal:keys', { detail: window.__litellmPortalKeys }));
    }
    function renderTeams(teams) {
      if (teams.length === 0) {
        byId('teams').replaceChildren(emptyRow('当前 LiteLLM 用户未关联团队。', 6));
        return;
      }
      byId('teams').replaceChildren(...teams.map((team) => {
        const row = document.createElement('tr');
        row.className = 'border-b border-kumo-fill transition-colors hover:bg-kumo-tint';
        row.append(
          cell(team.alias || team.id),
          cell(list(team.models).length || '未限制', 'right'),
          cell(team.spend == null ? '—' : fmt(team.spend), 'right'),
          moneyCell(team.maxBudget == null ? '—' : fmt(team.maxBudget), team.spend, team.maxBudget),
          cell(team.rpmLimit == null ? '—' : fmtInt(team.rpmLimit), 'right'),
          cell(team.tpmLimit == null ? '—' : fmtInt(team.tpmLimit), 'right'),
        );
        return row;
      }));
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
    function setupThemeToggle() {
      const button = byId('theme-toggle');
      if (!button) return;
      const label = button.querySelector('[data-theme-label]');
      const applyMode = (mode) => {
        document.documentElement.dataset.mode = mode;
        button.setAttribute('aria-pressed', String(mode === 'dark'));
        button.setAttribute('aria-label', mode === 'dark' ? '切换浅色模式' : '切换深色模式');
        if (label) label.textContent = mode === 'dark' ? '深色' : '浅色';
      };
      applyMode(document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light');
      button.addEventListener('click', () => {
        const next = document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem('litellm-portal-mode', next); } catch {}
        applyMode(next);
      });
    }
    function renderDashboard(data) {
      byId('email').textContent = data.me.email;
      byId('email').title = data.me.email;
      byId('litellm-user').textContent = 'LiteLLM: ' + data.user.litellmUserId;
      byId('total-spend').textContent = fmt(data.summary.totalSpend);
      byId('recent-spend').textContent = data.usage.available ? fmt(data.summary.recentSpend) : '暂无数据';

      const userBudget = budgetPill(data.summary.totalSpend, data.user.maxBudget);
      const keyBudgetText = data.user.maxBudget == null ? '预算 ' + text(data.summary.keyBudget) : '预算 ' + fmt(data.user.maxBudget);
      byId('budget').textContent = keyBudgetText;
      if (userBudget) byId('budget').append(userBudget);

      byId('request-count').textContent = fmtInt(data.summary.requestCount);
      byId('token-count').textContent = fmtInt(data.summary.totalTokens);
      byId('key-count').textContent = fmtInt(data.summary.keyCount);
      byId('model-count').textContent = fmtInt(data.summary.availableModelCount);
      byId('team-count').textContent = fmtInt(data.summary.teamCount);
      renderModels(data.models);
      renderTeams(list(data.teams));
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
    setupThemeToggle();
    window.addEventListener('litellm-portal:refresh', () => refresh());
    refresh();
  </script>
</body>
</html>`;
}
