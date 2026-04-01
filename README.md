# 2libra 自动签到

这是一个可独立推送到 GitHub 的自动签到项目。

## 文件说明

- `run.mjs`：自动签到主脚本
- `accounts.example.json`：多账号配置示例
- `.github/workflows/2libra-sign.yml`：GitHub Actions 工作流

## GitHub Secrets

请在目标 GitHub 仓库 Secrets 中新增：

- `LIBRA_ACCOUNTS_JSON`

格式示例：

```json
[
  {
    "label": "main",
    "username": "user1@example.com",
    "password": "your-password-1",
    "enabled": true
  },
  {
    "label": "backup",
    "username": "user2@example.com",
    "password": "your-password-2",
    "enabled": true
  }
]
```

## 手动触发

工作流支持两个输入：

- `account`：按 `label` 或 `username` 过滤单个账号
- `dry_run`：只检查是否已签到，不实际执行签到

## 执行逻辑

1. 读取多账号配置
2. 逐账号重新登录
3. 查询 `/api/sign/today`
4. 未签到时调用 `/api/sign`
5. 输出每个账号结果

## 本地测试

可以先用禁用账号做最小验证：

```bash
LIBRA_ACCOUNTS_JSON='[{"label":"demo","username":"demo@example.com","password":"dummy","enabled":false}]' node run.mjs
```

## 日志说明

每个账号都会输出以下结果字段：

- `label`
- `login`
- `signedToday`
- `action`
- `status`
- `message`

不会输出密码、access token 或完整 cookie。
