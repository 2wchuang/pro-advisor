# 发布流程

本包用 **npm Trusted Publishing (OIDC)** 发布 —— 不在 GitHub 里存任何 npm token。
但有一个必须先跨过的门槛。

## 关键限制：首次发布不能用 OIDC

npm **不支持为尚不存在的包预配置 Trusted Publisher**。配置入口挂在包自己的
Settings 页（`npmjs.com/package/<name>/access`）上；包不存在，就没有那个页面，
OIDC 发布一个全新包会失败。

一手证据：npm 官方 issue
[#1926 "Missing guidance for first-time package publishing with Trusted Publishers (OIDC)"](https://github.com/npm/documentation/issues/1926)
（2026-03-26 创建，**截至 2026-09 仍为 OPEN**）原文：

> attempting to publish a package for the first time using a GitHub Actions workflow
> with OIDC **failed**. The publish step did not succeed when the package did not yet
> exist on NPM.
>
> As a workaround, we had to: **Perform the first publish manually** (outside of
> OIDC / Trusted Publishers) … After the initial release existed on npm, subsequent
> releases using the GitHub Action with Trusted Publishers **worked as expected**

对照：PyPI 和 NuGet 都支持"pending trusted publisher"（为未来的包预配置），
npm 没有。

**结论：首次手动，之后全自动。**

---

## 一次性引导（只有第一次）

### 1. 账号必须有 2FA 或带 bypass 的 token

npm 政策（[官方文档](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)）：

> All packages now require two-factor authentication (2FA) or a granular access
> tokens with bypass 2FA enabled for creating and publishing packages.

`npm profile get` 显示 `two-factor auth: disabled` 时，**手动发布也会被拒**，报：

```
403 Two-factor authentication or granular access token with bypass 2fa enabled
    is required to publish packages.
```

注意这个错误**不是**验证码问题：registry 返回 403 且**不发 `www-authenticate` 挑战头**，
所以 `npm publish --otp=<code>` 不会生效（npm 的 `otplease` 只对 `EOTP`/`E401` 提示）。
带假验证码重试会返回**完全相同**的错误 —— 该 header 从未被读取。

二选一：

- **启用 2FA**（npmjs.com → Account → Two-Factor Authentication），之后
  `npm publish` 会弹出验证码提示；或
- **新建 granular token 并勾选 "Bypass 2FA"**（npmjs.com → Access Tokens →
  Generate New Token → Granular → Read and write → 勾选 Bypass 2FA）。
  该开关**创建时**设定，事后不能改；不勾选则发布一律 403。

### 2. 手动发布首个版本

```bash
cd /path/to/pro-advisor
npm whoami          # 确认身份
npm publish         # 启用 2FA 后会提示输入 OTP
```

成功后确认：

```bash
npm view @2wchuang/pro-advisor version
```

### 3. 在 npm 上配置 Trusted Publisher

包页面 → **Settings** → **Trusted Publisher** → 选 **GitHub Actions**，填：

| 字段 | 值 |
| --- | --- |
| Organization or user | `2wchuang` |
| Repository | `pro-advisor` |
| Workflow filename | `release.yml` |

> ⚠️ **Workflow filename 必须与实际文件名完全一致**（`release.yml`，不是
> `.github/workflows/release.yml`）。填错会得到 `400 Bad Request`。

**不要**填 `Environment name` —— 本 workflow 未使用 GitHub environment，
填了会导致 OIDC 声明不匹配。

---

## 之后的每次发布（全自动）

```bash
npm version patch          # 或 minor / major，自动改 package.json 并打 tag
git push --follow-tags
```

推 tag 触发 `.github/workflows/release.yml`：

1. 校验 npm / node 版本满足 trusted publishing 要求（npm ≥ 11.5.1，node ≥ 22.14）
2. `npm ci` + `npm run check`（含 `repo-guards.test.ts` 回归护栏）
3. **校验 tag 与 `package.json` 版本一致**，不一致直接失败
4. **前置检查包是否已存在于 registry** —— 不存在则给出可执行的报错，
   而不是让 OIDC 抛一个难以理解的 400
5. `npm run pack:check` 后 `npm publish`

发布不需要任何 secret：`permissions: id-token: write` 让 GitHub 签发短期 OIDC 凭证，
npm 校验它来自配置过的 repo + workflow 文件。

## 也可以手动触发

Actions → Release → Run workflow，`dry-run` 默认 `true`（只打包校验，不发布）。
只有推 tag 才会真正 publish。

---

## 本地验证发布内容（不发布）

```bash
npm run pack:check     # = npm pack --dry-run
```

tarball 应为 23 个文件、约 37 kB，且**不含任何 `*.test.ts`**
（`package.json` 的 `files` 里已排除）。

## 为什么外部用户不一定要装 npm 包

pi 支持直接从 git 安装，完全绕开 npm：

```bash
pi install git:github.com/2wchuang/pro-advisor@v0.2.0
```

所以"发布到 npm"只是为了可发现性与 `pi.dev/packages` 收录，不是安装的必要条件。

## 未来注意

GitHub 公告（2026-07-31）称 bypass-2FA granular token 将**失去直接发布能力**，
publishing surface 收缩为"读私有包 + 暂存发布（staging）"，由维护者用 2FA 批准，
**目标时间 2027 年 1 月**。届时手动发布需转向 trusted publishing 或 staged publishing。
本仓库的 workflow 已是 OIDC，不受影响。
