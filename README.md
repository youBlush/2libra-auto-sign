# 2libra 自动签到

每天自动为 2libra 账号签到，基于 GitHub Actions 定时运行。

## 快速开始

### 1. Fork 本仓库

将此仓库 Fork 到你的 GitHub 账号。

### 2. 配置账号密码

进入你 Fork 后的仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

添加以下 Secret：

| Secret 名称 | 值 |
|---|---|
| `LIBRA_ACCOUNTS_JSON` | 你的账号配置（JSON 格式） |

值的内容示例：

```json
[
  {
    "label": "主账号",
    "username": "your-email@example.com",
    "password": "your-password",
    "enabled": true
  }
]
```

- `label`：账号备注名称（必填）
- `username`：登录邮箱（必填）
- `password`：登录密码（必填）
- `enabled`：是否启用该账号，设为 `false` 可临时禁用

执行逻辑：每次运行都用用户名密码登录获取 token，再进行签到。

支持配置多个账号，每个账号会依次执行签到。

### 3. 等待自动运行

配置完成后，脚本会**每天 UTC 4:00（北京时间 12:00）**自动执行签到。

## 手动触发

进入仓库 → **Actions** → 选择 **2libra Auto Sign** → **Run workflow**

可选参数：

- **account**：指定运行某个账号（填 `label` 或 `username`），留空则运行全部
- **dry_run**：仅检查是否已签到，不实际执行签到

## 常见问题

**Q: 如何临时禁用某个账号？**  
A: 将该账号的 `enabled` 设为 `false`，重新更新 Secret 即可。

**Q: 签到失败怎么办？**  
A: 在 Actions 页面查看运行日志，检查账号密码是否正确。
