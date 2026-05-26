import { writeFile } from 'node:fs/promises';

const API_BASE_URL = (process.env.LIBRA_API_BASE_URL || 'https://2libra.com').replace(/\/$/, '');
const ACCOUNTS_JSON = process.env.LIBRA_ACCOUNTS_JSON || '';
const ACCOUNT_FILTER = (process.env.ACCOUNT_FILTER || '').trim();
const DRY_RUN = isTrue(process.env.DRY_RUN);
const BADGE_RESTORE_WAIT_MINUTES = parsePositiveInteger(process.env.BADGE_RESTORE_WAIT_MINUTES, 11);
const SUMMARY_PATH = process.env.GITHUB_STEP_SUMMARY || '';
// 固定触发徽章：仅当当前已佩戴该徽章时，才执行徽章摘除与恢复流程。
const BADGE_FLOW_TRIGGER_BADGE_ID = 'e78fbfa8-628e-4e97-9ec1-7216c24091d5';

function isTrue(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function parsePositiveInteger(value, defaultValue) {
  const text = String(value || '').trim();
  if (!text) return defaultValue;
  const numberValue = Number(text);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new Error(`环境变量 BADGE_RESTORE_WAIT_MINUTES 必须是正整数，当前值：${text}`);
  }
  return numberValue;
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
  return payload.message || payload.msg || payload.m || payload.error || payload.detail || payload?.d?.message || fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAccount(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`第 ${index + 1} 个账号配置不是对象`);
  }

  const label = String(raw.label || raw.username || `account-${index + 1}`).trim();
  const username = String(raw.username || '').trim();
  const password = String(raw.password || '').trim();
  const accessToken = String(raw.accessToken || raw.access_token || '').trim();
  const enabled = raw.enabled !== false;

  if (!label) throw new Error(`第 ${index + 1} 个账号缺少 label`);
  if (!username) throw new Error(`账号 ${label} 缺少 username`);
  if (!accessToken && !password) throw new Error(`账号 ${label} 需要提供 password 或 accessToken`);

  return { label, username, password, accessToken, enabled };
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

  const filtered = !ACCOUNT_FILTER
    ? accounts
    : accounts.filter((account) => account.label === ACCOUNT_FILTER || account.username === ACCOUNT_FILTER);

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

async function getUserInfo(accessToken) {
  const { response, json, text } = await requestJson('/api/users/info?fields=info,exp,coins', {
    method: 'GET',
    headers: {
      accept: 'application/json, text/plain, */*',
      authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    return {
      ok: false,
      message: `查询用户信息失败，HTTP ${response.status}：${getMessage(json, text || '未知错误')}`
    };
  }

  if (typeof json?.c === 'number' && json.c !== 0) {
    return {
      ok: false,
      message: `查询用户信息失败：${getMessage(json, '未知错误')}`
    };
  }

  return {
    ok: true,
    info: json?.d || {}
  };
}

function hasEquippedBadge(userInfo, badgeId) {
  if (!badgeId || !Array.isArray(userInfo?.equipped_badges)) return false;

  return userInfo.equipped_badges.some((item) => {
    const equippedBadgeId = String(item?.badge_id || item?.badge?.id || '').trim();
    return equippedBadgeId === badgeId;
  });
}

async function equipBadge(accessToken, badgeId, equip) {
  const actionText = equip ? '佩戴' : '摘下';
  const { response, json, text } = await requestJson('/api/badges/equip', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      badge_id: badgeId,
      equip
    })
  });

  if (!response.ok) {
    return {
      ok: false,
      message: `${actionText}徽章失败，HTTP ${response.status}：${getMessage(json, text || '未知错误')}`
    };
  }

  if (typeof json?.c === 'number' && json.c !== 0) {
    return {
      ok: false,
      message: `${actionText}徽章失败：${getMessage(json, '未知错误')}`
    };
  }

  return {
    ok: true,
    message: getMessage(json, `${actionText}徽章成功`)
  };
}

function appendMessage(current, suffix) {
  if (!current) return suffix;
  return `${current}；${suffix}`;
}

function mergeResultMessage(primary, existing) {
  if (!existing || existing === '待执行') return primary;
  return `${primary}；${existing}`;
}

function createContext(account) {
  const username = maskUsername(account.username);
  if (!account.enabled) {
    return {
      account,
      username,
      accessToken: '',
      active: false,
      result: {
        label: account.label,
        username,
        login: 'skipped',
        signedToday: '-',
        action: 'skip',
        status: 'skipped',
        message: '账号已禁用',
        success: true
      }
    };
  }

  return {
    account,
    username,
    accessToken: '',
    active: true,
    needsReequip: false,
    result: {
      label: account.label,
      username,
      login: '-',
      signedToday: '-',
      action: 'pending',
      status: 'pending',
      message: '待执行',
      success: true
    }
  };
}

function markFailure(context, action, status, message) {
  const mergedMessage = mergeResultMessage(message, context.result.message);
  context.result.action = action;
  context.result.status = status;
  context.result.message = mergedMessage;
  context.result.success = false;
  context.active = false;
}

async function writeSummary(results, badgeFlowEnabled) {
  if (!SUMMARY_PATH) return;

  const badgeModeText = DRY_RUN
    ? 'dry_run 模式下不执行'
    : badgeFlowEnabled
      ? `自动开启（检测到已佩戴触发徽章后，签到后等待 ${BADGE_RESTORE_WAIT_MINUTES} 分钟再佩戴）`
      : '关闭';

  const lines = [
    '## 2libra 自动签到结果',
    '',
    `- 执行模式：${DRY_RUN ? 'dry_run' : 'normal'}`,
    `- 徽章流程：${badgeModeText}`,
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
  const badgeFlowEnabled = !DRY_RUN && accounts.some((account) => account.enabled);
  log('INFO', `准备处理 ${accounts.length} 个账号，模式：${DRY_RUN ? 'dry_run' : 'normal'}，徽章流程：${badgeFlowEnabled ? 'on' : 'off'}`);

  const contexts = accounts.map(createContext);

  // 第一阶段：统一登录，拿到后续操作所需 token。
  for (const context of contexts) {
    if (!context.account.enabled) continue;

    if (context.account.accessToken) {
      context.accessToken = context.account.accessToken;
      context.result.login = 'token';
      log('INFO', `账号 ${context.account.label}（${context.username}）使用预置 accessToken，跳过登录`);
      continue;
    }

    log('INFO', `开始登录账号 ${context.account.label}（${context.username}）`);
    try {
      const loginResult = await login(context.account);
      if (!loginResult.ok) {
        markFailure(context, 'login', 'login_failed', loginResult.message);
        log('ERROR', `${context.account.label} login_failed - ${loginResult.message}`);
        continue;
      }

      context.accessToken = loginResult.accessToken;
      context.result.login = 'ok';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markFailure(context, 'login', 'login_failed', message);
      log('ERROR', `${context.account.label} login_failed - ${message}`);
    }
  }

  // 第二阶段：可选统一摘除指定徽章（失败只记录，不影响后续签到）。
  if (badgeFlowEnabled) {
    const badgeContexts = contexts.filter((context) => context.active);
    for (const context of badgeContexts) {
      try {
        const userInfoResult = await getUserInfo(context.accessToken);
        if (!userInfoResult.ok) {
          context.result.message = appendMessage(context.result.message, userInfoResult.message);
          log('WARN', `${context.account.label} badge_info_warn - ${userInfoResult.message}`);
          continue;
        }

        if (!hasEquippedBadge(userInfoResult.info, BADGE_FLOW_TRIGGER_BADGE_ID)) {
          context.result.message = appendMessage(context.result.message, `当前佩戴徽章不匹配触发ID（${BADGE_FLOW_TRIGGER_BADGE_ID}），已跳过徽章处理`);
          log('INFO', `${context.account.label} badge_skip - 触发徽章未佩戴`);
          continue;
        }

        const unequipResult = await equipBadge(context.accessToken, BADGE_FLOW_TRIGGER_BADGE_ID, false);
        if (!unequipResult.ok) {
          context.result.message = appendMessage(context.result.message, `摘除徽章失败：${unequipResult.message}`);
          log('WARN', `${context.account.label} badge_unequip_warn - ${unequipResult.message}`);
        } else {
          context.needsReequip = true;
          context.result.message = appendMessage(context.result.message, '已摘除徽章');
          log('OK', `${context.account.label} badge_unequip_ok - ${unequipResult.message}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        context.result.message = appendMessage(context.result.message, `摘除徽章失败：${message}`);
        log('WARN', `${context.account.label} badge_unequip_warn - ${message}`);
      }
    }
  }

  // 第三阶段：统一执行签到。
  for (const context of contexts) {
    if (!context.active) continue;

    try {
      const checkResult = await checkToday(context.accessToken);
      if (!checkResult.ok) {
        markFailure(context, 'check', 'check_failed', checkResult.message);
        log('ERROR', `${context.account.label} check_failed - ${checkResult.message}`);
        continue;
      }

      if (checkResult.signed) {
        context.result.signedToday = 'yes';
        context.result.action = 'none';
        context.result.status = 'already_signed';
        context.result.message = mergeResultMessage('今天已签到', context.result.message);
        context.result.success = true;
        log('OK', `${context.account.label} already_signed - 今天已签到`);
        continue;
      }

      context.result.signedToday = 'no';

      if (DRY_RUN) {
        context.result.action = 'dry_run';
        context.result.status = 'skipped';
        context.result.message = mergeResultMessage('dry_run 模式，未实际执行签到', context.result.message);
        context.result.success = true;
        log('OK', `${context.account.label} skipped - dry_run 模式，未实际执行签到`);
        continue;
      }

      const signResult = await signToday(context.accessToken);
      if (!signResult.ok) {
        markFailure(context, 'sign', 'sign_failed', signResult.message);
        log('ERROR', `${context.account.label} sign_failed - ${signResult.message}`);
        continue;
      }

      context.result.action = 'sign';
      context.result.status = 'signed_now';
      context.result.message = mergeResultMessage(signResult.message, context.result.message);
      context.result.success = true;
      log('OK', `${context.account.label} signed_now - ${signResult.message}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markFailure(context, 'sign', 'sign_failed', message);
      log('ERROR', `${context.account.label} sign_failed - ${message}`);
    }
  }

  // 第四阶段：统一佩戴指定徽章（失败只记录，不影响签到结果）。
  if (badgeFlowEnabled) {
    const contextsNeedEquip = contexts.filter((context) => context.active && context.needsReequip);
    if (contextsNeedEquip.length > 0) {
      log('INFO', `签到完成，等待 ${BADGE_RESTORE_WAIT_MINUTES} 分钟后再佩戴徽章`);
      await sleep(BADGE_RESTORE_WAIT_MINUTES * 60 * 1000);
    }

    for (const context of contextsNeedEquip) {
      try {
        const equipResult = await equipBadge(context.accessToken, BADGE_FLOW_TRIGGER_BADGE_ID, true);
        if (!equipResult.ok) {
          context.result.message = appendMessage(context.result.message, `佩戴徽章失败：${equipResult.message}`);
          log('WARN', `${context.account.label} badge_equip_warn - ${equipResult.message}`);
          continue;
        }

        context.result.message = appendMessage(context.result.message, '已佩戴徽章');
        log('OK', `${context.account.label} badge_equip_ok - ${equipResult.message}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        context.result.message = appendMessage(context.result.message, `佩戴徽章失败：${message}`);
        log('WARN', `${context.account.label} badge_equip_warn - ${message}`);
      }
    }
  }

  const results = contexts.map((context) => context.result);
  await writeSummary(results, badgeFlowEnabled);

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
