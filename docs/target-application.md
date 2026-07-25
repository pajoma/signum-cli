# Target application profile

What we know about the Signum application `signum-cli` must work against. These facts constrain
the design more than anything in the framework itself, so they are collected here rather than
scattered across ADRs.

**Source:** stated by the project owner, 2026-07-25. Not yet verified against the running app —
testing happens later.

> The CLI must still work against **any** Signum application (REQ-075). This profile drives
> *priority*, not *capability*: mechanisms unusable here stay specified for other deployments.

## Known

| Aspect | Value | Consequence |
|---|---|---|
| Identity provider | **Microsoft Entra** | SSO/MFA/Conditional Access apply to any browser sign-in |
| `Signum.Rest` | **not installed** | No API keys at all: no `X-ApiKey` authenticator in the chain, `api/restApiKey/*` absent, `api/auth/loginFromApiKey` has nothing to authenticate with |
| `Signum.Agent` | **not installed** | No server-side MCP surface and no LLM tool layer. Agents can reach this app **only** through this CLI |
| Control over Signum config | **none** | `ExtraValidAudiences` and every other server-side opt-in is unavailable |
| User provisioning | Entra-provisioned | `PasswordHash = null` (`AzureADAuthorizer.cs:43`) ⇒ password login can never succeed, and attempting it risks account deactivation |

## Unknown — and worth resolving

| Question | Why it matters |
|---|---|
| Which module fronts Entra: `Signum.Authorization.AzureAD` or `.OpenID`? | Decides whether STORY-10 (token exchange) or STORY-01 (loopback code flow) is the eventual better path |
| `AzureADType`: `AzureAD`, `B2C`, or `ExternalID`? | Different issuer and discovery endpoint; `login.microsoftonline.com` must never be hardcoded |
| Any control over the **Entra app registration**? | Gates STORY-10 entirely (ADR 0004 Options A/C) |
| Does Conditional Access permit the device code grant? | Gates STORY-10 even with a registration change |
| Framework version | The analysis is against `74bd24693d`; a deployed app may differ |
| Which queries/types/operations matter? | Shapes which commands to build first beyond auth |

## Net effect on authentication

Exactly **one** mechanism is reachable:

**Browser token handoff** — the user signs into the web app (Entra SSO does the work), then hands
the bearer token from `sessionStorage.authToken` to the CLI.
[STORY-12](stories/auth.md) · [REQ-008](https://github.com/pajoma/signum-cli/issues/49) ·
[ADR 0004](decisions/0004-entra-primary-identity-provider.md) Decision 4.

Everything else is blocked: API keys (no `Signum.Rest`), password (null `PasswordHash`), Entra
device code and OpenID loopback (both need tenant changes).

## Net effect on MCP

`Signum.Agent` being absent **strengthens** [ADR 0002](decisions/0002-mcp-vs-http.md). That ADR
chose to depend on nothing server-side and to have the CLI expose *itself* as an MCP server. With no
`Signum.Agent` in the target app, the CLI's own MCP mode
([REQ-060](https://github.com/pajoma/signum-cli/issues/37)) is **the only way** Claude Code or any
other agent can drive this application — which is precisely why it is v1.

It also removes the concern that motivated caution there: we are not sitting downstream of
`Signum.Agent`'s prompt-injection-to-write-path problem, because it is not deployed. REQ-062's write
guardrails remain required on their own merits.

## Consequences summary

- Auth work concentrates on one flow, so that flow must be robust rather than merely possible —
  hence STORY-12's assisted capture, atomic rotation, and honest re-handoff criteria.
- No mechanism here is scriptable without a prior human browser step. **CI cannot authenticate
  unattended** unless a token is provisioned into it out of band, or `Signum.Rest` is later
  installed. This is a real limitation of the deployment, not of the CLI, and should be stated in
  the README so nobody plans a pipeline around it.
- The CLI is the sole agent-facing entry point to this application.
