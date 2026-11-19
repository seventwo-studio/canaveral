# Native dashboard model acceptance

## Trial procedure

Use a disposable controller, dashboard and private trial directory, as in the
[dashboard build trial](dashboard-builds.md). Build the current coordination
TypeScript and use the matching dashboard assets. Configure one native host with
the `inference` section from [embedded inference](../../docs/inference.md). It
must name an operator-installed Ollama executable, its models directory and the
exact tag and digest of an already installed small model. Create two disposable
accounts: one administrator and one ordinary user.

1. In Chromium, sign in as the administrator and open **Models**. Confirm that
   the installed model identity is offered by one ready host.
2. Run a short prompt. Confirm the page reaches **Succeeded**, shows the generated
   text and nonzero token counts, then **Runtime stopped · capacity released**.
   Independently confirm that the owned Ollama process group has exited, the job
   workspace is gone and host reservations have returned to zero.
3. Run a long prompt and select **Cancel job** while it is running. Confirm the
   page holds **Capacity reserved** until the runner reports a positive stop. It
   should then show **Cancelled** with released capacity. Repeat the independent
   process and reservation checks.
4. Sign in as the ordinary user. Confirm that **Models** is absent and that
   direct `/api/v1/models` and `/api/v1/jobs` requests are denied.

Do not install a runtime or pull weights as part of the trial. Under the
[inference contract](../../docs/inference.md), model preparation is an explicit
operator action. Keep credentials, prompts with private content, raw databases
and browser profiles out of the repository.

## 2026-11-19 observations

The trial did not run. The designated ARM64 Mac Studio has no Ollama executable
on its PATH or in the usual Homebrew and application locations, and no Ollama
model directory. The embedded TypeScript inference adapter supports only Ollama.
Installing a runtime and pulling a model requires separate operator
authorization, so the native gate remains open.

Portable coverage on the same date passed. Vitest component tests covered request
replay, output, cancellation, positive-stop release, on-demand output and denial.
Playwright Chromium fixtures covered submission and output at 320 and 1440 pixels
under the dashboard CSP. They also covered ordinary-user redirection. The existing
coordination gateway and inference tests also passed. These fixtures do not
establish native model execution, real cancellation timing or measured capacity
release.
