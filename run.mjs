import { writeFile } from 'node:fs/promises';

const API_BASE_URL = (process.env.LIBRA_API_BASE_URL || 'https://2libra.com').replace(/\/$/, '');
const ACCOUNTS_JSON = process.env.LIBRA_ACCOUNTS_JSON || '';
const ACCOUNT_FILTER = (process.env.ACCOUNT_FILTER || '').trim();
const DRY_RUN = isTrue(process.env.DRY_RUN);
const SUMMARY_PATH = process.env.GITHUB_STEP_SUMMARY || '';

function isTrue(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function log(tag, message) {
  console.log(`[${tag}] ${message}`);
}

function maskUsername(username) {
  if (!username || !username.includes('@')) {
    if (!username) return '';
    if (username.length <= 4) return `${username[0] || '*'}***`;
    return `${username.slice(0, 2)}***${username.slice(-2)}`;
  }

  const [name, domain] = username.split('@');
  const maskedName = name.length <= 2 ? `${name[0] || '*'}***` : `${name.slice(0, 2)}***${name.slice(-1)}`;
  return `${maskedName}@${domain}`;
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function getMessage(payload, fallback) {
  if (!payload || typeof payload !== 'object') return fallback;
  return payload.message || payload.msg || payload.error || payload.detail || fallback;
}

function normalizeAccount(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`第 ${index + 1} 个账号配置不是对象`);
  }

  const label = String(raw.label || raw.username || `account-${index + 1}`).trim();
  const username = String(raw.username || '').trim();
  const password = String(raw.password || '').trim();
  const enabled = raw.enabled !== false;

  if (!label) throw new Error(`第 ${index + 1} 个账号缺少 label`);
  if (!username) throw new Error(`账号 ${label} 缺少 username`);
  if (!password) throw new Error(`账号 ${label} 缺少 password`);

  return { label, username, password, enabled };
}

function parseAccounts(jsonText) {
  if (!jsonText.trim()) {
    throw new Error('缺少环境变量 LIBRA_ACCOUNTS_JSON');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`LIBRA_ACCOUNTS_JSON 不是合法 JSON：${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('LIBRA_ACCOUNTS_JSON 必须是非空数组');
  }

  const accounts = parsed.map(normalizeAccount);
  const labels = new Set();
  for (const account of accounts) {
    if (labels.has(account.label)) {
      throw new Error(`账号 label 重复：${account.label}`);
    }
    labels.add(account.label);
  }

  if (!ACCOUNT_FILTER) return accounts;

  const filtered = accounts.filter((account) => account.label === ACCOUNT_FILTER || account.username === ACCOUNT_FILTER);
  if (filtered.length === 0) {
    throw new Error(`未找到匹配的账号：${ACCOUNT_FILTER}`);
  }
  return filtered;
}

async function requestJson(path, options) {
  const response = await fetch(`${API_BASE_URL}${path}`, options);
  const text = await response.text();

  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  return { response, text, json };
}

async function login(account) {
  const { response, json, text } = await requestJson('/api/auth/login', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      username: account.username,
      password: account.password,
      twoFaCode: ''
    })
  });

  if (!response.ok) {
    return {
      ok: false,
      message: `登录失败，HTTP ${response.status}：${getMessage(json, text || '未知错误')}`
    };
  }

  const accessToken = json?.d?.access_token;
  if (!accessToken) {
    return {
      ok: false,
      message: '登录成功但响应中缺少 d.access_token'
    };
  }

  return { ok: true, accessToken };
}

async function checkToday(accessToken) {
  const { response, json, text } = await requestJson('/api/sign/today', {
    method: 'GET',
    headers: {
      accept: 'application/json, text/plain, */*',
      authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    return {
      ok: false,
      message: `查询签到状态失败，HTTP ${response.status}：${getMessage(json, text || '未知错误')}`
    };
  }

  if (typeof json?.d?.signed !== 'boolean') {
    return {
      ok: false,
      message: '查询签到状态成功，但响应中缺少布尔值 d.signed'
    };
  }

  return { ok: true, signed: json.d.signed };
}

async function signToday(accessToken) {
  const { response, json, text } = await requestJson('/api/sign', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    return {
      ok: false,
      message: `执行签到失败，HTTP ${response.status}：${getMessage(json, text || '未知错误')}`
    };
  }

  return {
    ok: true,
    message: getMessage(json, '签到成功')
  };
}

async function runAccount(account) {
  const maskedUser = maskUsername(account.username);

  if (!account.enabled) {
    return {
      label: account.label,
      username: maskedUser,
      login: 'skipped',
      signedToday: '-',
      action: 'skip',
      status: 'skipped',
      message: '账号已禁用',
      success: true
    };
  }

  log('INFO', `开始处理账号 ${account.label}（${maskedUser}）`);

  try {
    const loginResult = await login(account);
    if (!loginResult.ok) {
      return {
        label: account.label,
        username: maskedUser,
        login: 'failed',
        signedToday: '-',
        action: 'login',
        status: 'login_failed',
        message: loginResult.message,
        success: false
      };
    }

    const checkResult = await checkToday(loginResult.accessToken);
    if (!checkResult.ok) {
      return {
        label: account.label,
        username: maskedUser,
        login: 'ok',
        signedToday: '-',
        action: 'check',
        status: 'check_failed',
        message: checkResult.message,
        success: false
      };
    }

    if (checkResult.signed) {
      return {
        label: account.label,
        username: maskedUser,
        login: 'ok',
        signedToday: 'yes',
        action: 'none',
        status: 'already_signed',
        message: '今天已签到',
        success: true
      };
    }

    if (DRY_RUN) {
      return {
        label: account.label,
        username: maskedUser,
        login: 'ok',
        signedToday: 'no',
        action: 'dry_run',
        status: 'skipped',
        message: 'dry_run 模式，未实际执行签到',
        success: true
      };
    }

    const signResult = await signToday(loginResult.accessToken);
    if (!signResult.ok) {
      return {
        label: account.label,
        username: maskedUser,
        login: 'ok',
        signedToday: 'no',
        action: 'sign',
        status: 'sign_failed',
        message: signResult.message,
        success: false
      };
    }

    return {
      label: account.label,
      username: maskedUser,
      login: 'ok',
      signedToday: 'no',
      action: 'sign',
      status: 'signed_now',
      message: signResult.message,
      success: true
    };
  } catch (error) {
    return {
      label: account.label,
      username: maskedUser,
      login: 'failed',
      signedToday: '-',
      action: 'error',
      status: 'login_failed',
      message: error instanceof Error ? error.message : String(error),
      success: false
    };
  }
}

async function writeSummary(results) {
  if (!SUMMARY_PATH) return;

  const lines = [
    '## 2libra 自动签到结果',
    '',
    `- 执行模式：${DRY_RUN ? 'dry_run' : 'normal'}`,
    `- 账号数量：${results.length}`,
    '',
    '| 账号 | 用户名 | 登录 | 今日已签到 | 动作 | 状态 | 说明 |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  ];

  for (const result of results) {
    lines.push(`| ${escapeCell(result.label)} | ${escapeCell(result.username)} | ${escapeCell(result.login)} | ${escapeCell(result.signedToday)} | ${escapeCell(result.action)} | ${escapeCell(result.status)} | ${escapeCell(result.message)} |`);
  }

  lines.push('');
  await writeFile(SUMMARY_PATH, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const accounts = parseAccounts(ACCOUNTS_JSON);
  log('INFO', `准备处理 ${accounts.length} 个账号，模式：${DRY_RUN ? 'dry_run' : 'normal'}`);

  const results = [];
  for (const account of accounts) {
    const result = await runAccount(account);
    results.push(result);
    log(result.success ? 'OK' : 'ERROR', `${result.label} ${result.status} - ${result.message}`);
  }

  await writeSummary(results);

  const failed = results.filter((item) => !item.success);
  if (failed.length > 0) {
    log('ERROR', `共有 ${failed.length} 个账号执行失败`);
    process.exitCode = 1;
    return;
  }

  log('OK', '全部账号执行完成');
}

main().catch((error) => {
  log('ERROR', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
