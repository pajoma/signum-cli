# Signum.Utilities — Deep Architecture Analysis

Repo: `/home/patrick.maue/git/sfcl/signum-framework` (read-only).
Scope: `Signum.Utilities/` — the dependency-light utility layer, with emphasis on CLI-relevant infrastructure.
Sibling repo `/home/patrick.maue/git/sfcl/signum-cli` currently contains **only a `.git` directory** — i.e. the CLI is greenfield, and this report is effectively a "what can we build on" survey.

---

## 0. Executive summary / verdict up front

`Signum.Utilities` contains a **mature but deliberately minimal interactive-console toolkit**, not a CLI framework. What exists:

| Concern | Status in Signum.Utilities |
|---|---|
| Interactive menu / option picker | **Built and battle-tested** (`ConsoleSwitch<K,V>`), incl. fuzzy "did you mean" |
| Coloured output, prompts, y/n, remembered answers | **Built** (`SafeConsole`) |
| Same-line status / elapsed-seconds spinner | **Built** (`SafeConsole.WriteSameLine`, `WaitExecute`) |
| ETA/percentage progress computation | **Built** (`ProgressEnumerator` + `IProgressInfo`) |
| Progress *bar* rendering | **Absent** — only a one-line `"12.34% | 120/1000 | Elap … Rem …"` string |
| Table rendering to console | **Built** (`EnumerableExtensions.ToConsoleTable` / `FormatTable`) |
| CSV/TSV read+write, plus C# class inference from a CSV | **Built** (`Csv`, `Tsv`) |
| Argument/verb/flag parsing (`--foo`, subcommands, `--help`) | **Completely absent** anywhere in the repo |
| Config binding, DI, logging host, exit codes | **Absent** |
| Ambient per-invocation state ("session") without ASP.NET | **Built** (`Statics` + `SingletonSessionFactory`) |

**Bottom line:** roughly *"an interactive REPL-menu console app kit"* is already built and is exactly the style Signum's own tools (`Signum.Upgrade`, `CodeGenerator`, migration runners) use. A modern non-interactive `signum <verb> --flags` CLI has **zero** existing infrastructure and must be added (`System.CommandLine` or hand-rolled). Detail in §1.8.

---

## 1. Console / CLI infrastructure (highest priority)

### 1.1 `ConsoleSwitch.cs` + `ConsoleSwitch.md`

Files: `Signum.Utilities/ConsoleSwitch.cs` (311 lines), `Signum.Utilities/ConsoleSwitch.md`.

`ConsoleSwitch<K, V>` is an `IEnumerable<KeyValuePair<string, WithDescription<V>>>` designed **specifically for collection-initializer syntax**, so a menu reads like a data literal. Keys are stored as `string` in a `Dictionary<string, WithDescription<V>>` with `StringComparer.InvariantCultureIgnoreCase` (`ConsoleSwitch.cs:9`).

**Canonical usage pattern** — the doc's example (`ConsoleSwitch.md:41-48`) and the real one in `Signum/CodeGeneration/CodeGenerator.cs:15-25`:

```csharp
var action = new ConsoleSwitch<string, Action>("What do you want to generate today?")
{
    {"E", Entities.GenerateEntitiesFromDatabaseTables, "Entities (from Database tables)"},
    {"L", Logic.GenerateLogicFromEntities,             "Logic (from entites)"},
    {"R", React.GenerateReactFromEntities,             "React (from entites)"},
}.Choose();

if (action == null)   // null == user pressed Enter == "exit"
    return;

action();
```

Key API and behaviours:

- `Add(K key, V value)` / `Add(K key, V value, string description)` (`:29`, `:34`) — `AddOrThrow` guards duplicate keys.
- `Add(string value)` (`:24`) — a bare single-arg `Add` inserts a **separator/section heading** at the current position (`separators` dictionary keyed by index). Slightly surprising overload: `Add("Foo")` is a separator, `Add(key, value)` is an option.
- `V? Choose(int? numberOfOptions = null)` (`:39`) and `WithDescription<V>? ChooseTuple(...)` (`:49`) — paged single selection. `numberOfOptions` sets a page size; typing `+` shows the next page (`:59-65`).
- `V[]? ChooseMultiple(string[]? args = null)` (`:112`) and `ChooseMultipleWithDescription` (`:129`, `:134`) — comma- and **range**-separated multi-select. `GetValuesRange` (`:165-187`) understands `3-7`, `-7` (take through 7) and `3-` (skip to end).
- **Non-interactive escape hatch**: `ChooseMultipleWithDescription(endMessage, args)` short-circuits the prompt entirely when `args != null` (`:136-137`) — `args.ToString(" ").SplitNoEmpty(',')`. This is the *only* place in the whole framework where `string[] args` feeds a console abstraction, and it's a very thin hook.
- **Fuzzy matching / "Did you mean?"** — `TryGetValue` (`:198-213`) falls back to Levenshtein distance ≤ 2 via `StringDistance` and asks for confirmation:

```csharp
var sd = new StringDistance();
var best = dictionary.Keys.MinBy(a => sd.LevenshteinDistance(input.ToLowerInvariant(), a.ToLowerInvariant()));
if (best != null && sd.LevenshteinDistance(input.ToLowerInvariant(), best.ToLowerInvariant()) <= 2)
{
    if (SafeConsole.Ask($"Did you mean '{best}'?"))
        return dictionary.GetOrThrow(best);
}
```

- `public Action<string, WithDescription<V>> PrintOption` (`:106`) — mutable field, the one extensibility point for rendering (default: white key, then `" - " + Description`).
- `WithDescription<T>` (`:249-278`) auto-derives a label when none is given: `Delegate` → `d.Method.Name.SpacePascal(true)`, `Enum` → `NiceToString()`, else `ToString()`. So `{"L", Logic.GenerateLogicFromEntities}` displays as "Generate Logic From Entities" for free.
- `ConsoleSwitchExtensions` (`:280-310`): `collection.ChooseConsole(getString, message)`, `collection.ChooseConsoleMultiple(...)`, and `cs.Load(list, getString)` for the "index-keyed list of objects" case. Used e.g. in `Signum.Upgrade/CodeUpgradeRunner.cs:51` and `Signum/CodeGeneration/CodeGenerator.cs:49-51`.
- `ConsoleMessage` enum (`:235-247`) is **localized** through `DescriptionManager.NiceToString()` (see §2.2) — translations for the five strings live in `Signum.Utilities/Translations/Signum.Utilities.{de,es,fr,it,pt}.xml` (e.g. `Signum.Utilities.de.xml:9-15` "Wählen Sie eine der folgenden Optionen:").

Known rough edges: typo `"Plase choose a valid option!"` (`:75`); `ChooseMultipleWithDescription` uses `goto retry` with `Console.Clear()` on empty input (`:139-162`) which is aggressive for a scripted CLI; the `.md` is stale (documents `Choose(string endMessage)` overloads that no longer exist, and `ConsoleSwitch<K,V>` now has `where K : notnull`).

**Real consumers**: `Signum/CodeGeneration/CodeGenerator.cs`, `Signum/CodeGeneration/ReactCodeGenerator.cs`, `Extensions/Signum.Authorization/AuthLogic.cs`, `Extensions/Signum.Help/HelpExportImport.cs`, `Extensions/Signum.Mailing/Templates/EmailTemplateLogic.cs`, plus indirectly `SafeConsole.AskSwitch`.

### 1.2 `SafeConsole.cs` + `SafeConsole.md`

File: `Signum.Utilities/SafeConsole.cs` (314 lines). Static class. Full useful API surface:

**Synchronisation**
- `public static readonly Lock SyncKey` (`:9`) — a .NET 9+ `System.Threading.Lock`. The convention across the framework is `lock (SafeConsole.SyncKey) { … }` around multi-write blocks (see `Signum/Engine/ProgressExtensions.cs:179`, `:215`, `:272`).

**Same-line output (the closest thing to a progress bar)**
- `WriteSameLine(string? str)` (`:17`) / `WriteSameLine(string format, params object?[])` (`:12`)
- `WriteSameLineColor(ConsoleColor, string?)` (`:70`)
- `ClearSameLine()` (`:30`)

Implementation detail worth knowing — it writes a full line then moves the cursor back up, padding/truncating to `Console.BufferWidth - 1`:

```csharp
public static void WriteSameLine(string? str)
{
    if (needToClear)
        str = str?.PadTruncateRight(Console.BufferWidth - 1);
    else
        str = str?.TryStart(Console.BufferWidth - 1)!;

    Console.WriteLine(str);
    Console.SetCursorPosition(Console.CursorLeft, Console.CursorTop == 0 ? 0 : Console.CursorTop - 1);
    needToClear = true;
}
```

`needToClear` is a **static non-thread-local flag** (`:10`) — hence the `SyncKey` convention. It touches `Console.BufferWidth`/`SetCursorPosition`, so callers must guard with `Console.IsOutputRedirected` themselves (`SafeConsole` does *not* do it here; `ProgressExtensions` does, e.g. `Signum/Engine/ProgressExtensions.cs:120`, `:150`, `:153`).

**Colour**
- `WriteColor(ConsoleColor, string)` / `(…, char)` / `(…, format, params object[])` (`:41-53`)
- `WriteLineColor(ConsoleColor, string?)` / `(…, format, params object?[])` (`:57-68`)

Both save/restore `Console.ForegroundColor`. There is **no background-colour helper, no ANSI/VT support, no `NO_COLOR`/`--no-color` awareness, and no "is a TTY" gate on colour**.

**Prompts**
- `string AskString(string question, Func<string,string?>? stringValidator = null)` (`:78`) — loops until the validator returns `null`; validator returns the error message.
- `bool Ask(string question)` (`:93`) — yes/no sugar over `Ask(question, "yes","no")`.
- `string? Ask(string question, params string[] answers)` (`:113`) — prints `question (yes/no) `, prefix-matches the answer case-insensitively, returns `null` on empty input (= cancel).
- `bool AskRetry(string)` / `string AskRetry(string, params string[])` (`:98`, `:103`) — same but won't accept cancel.
- `bool Ask(ref bool? rememberedAnswer, string question)` (`:170`) and `string? Ask(ref string? rememberedAnswer, string question, params string[] answers)` (`:189`) — the **"use `!` for all"** pattern: appending `!` to the answer stores it in the caller's `ref` variable so subsequent questions auto-answer. Prompt reads `question (yes/no - use '!' for all) `. This one takes `lock (SyncKey)` internally (`:194`).
- `string? AskMultiLine(string question, params string[] answers)` (`:140`) / `AskMultilineRetry` (`:130`) — same semantics but options listed one per line.
- `string? AskSwitch(string question, List<string> options)` (`:221`) — delegates to a `ConsoleSwitch<int,string>`.

**"Working…" indicators for operations with no progress info**
- `void WaitExecute(Action action)` (`:262`) — spawns a `Task` that repaints ` (0h 00m 12s)` once per second next to the cursor while `action()` runs on the calling thread. **Returns early without any spinner when `Console.IsOutputRedirected`** (`:264-268`) — the one place redirection is handled internally.
- `void WaitExecute(string startingText, Action action)` (`:256`)
- `T WaitQuery<T>(string startingText, Func<T> query)` (`:248`) — yellow text, returns the value.
- `int WaitRows(string startingText, Func<int> updateOrDelete)` (`:231`) — gray text, then `" {n} rows afected"`.

Doc example (`SafeConsole.md:85`): `SafeConsole.WaitRows("Removing all exceptions", () => Database.Query<ExceptonEntity>().UnsafeDelete());`

**Portability caveat**
```csharp
[DllImport("Kernel32")]
public static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);   // :300-301
public delegate bool ConsoleCtrlHandler(CtrlType sig);
public enum CtrlType { CTRL_C_EVENT = 0, CTRL_BREAK_EVENT = 1, CTRL_CLOSE_EVENT = 2, CTRL_LOGOFF_EVENT = 5, CTRL_SHUTDOWN_EVENT = 6 }
```
This is a **Windows-only P/Invoke** exposed as public API. It is not called anywhere in the repo. A cross-platform CLI must ignore it and use `Console.CancelKeyPress` / `PosixSignalRegistration` instead. (No `[SupportedOSPlatform]` annotation, so it's a latent runtime `DllNotFoundException` on Linux if anyone calls it.)

**What SafeConsole does NOT have**, despite the task brief: no progress *bar* drawing, no cursor-hiding, no spinner glyph animation, no box drawing, no `Console.SetCursorPosition` abstraction beyond the two same-line methods, no width-aware word wrap, no ANSI styles (bold/dim/underline), no stderr routing.

### 1.3 Progress reporting: `ProgressProxy.cs`, `Extensions/ProgressEnumerator.cs`

Two independent mechanisms.

**(a) `ProgressProxy` (`Signum.Utilities/ProgressProxy.cs`, 179 lines)** — a *UI-agnostic push* model, explicitly designed so business logic can report progress without knowing whether the consumer is Console/WinForms/WPF (`ProgressProxy.md:1-4`).
- State: `Min`/`Max`/`Position` (`:24-45`), `CurrentTask` (`:53`), `event EventHandler<ProgressArgs>? Changed` (`:15`), `CancellationToken CancellationToken` (`:17`).
- `Start(int max)` / `Start(string currentTask)` / `Start(int max, string currentTask)` / `Start(int min, int max, string currentTask, int? position = null)` (`:58-95`).
- `NextTask(string)` / `NextTask(int position, string)` (`:97-109`), `IncrementPosition()` (`:48` — exists purely because `pp?.Position++` doesn't compile), `Reset()` (`:111`).
- `OnChanged` calls `CancellationToken.ThrowIfCancellationRequested()` on **every** notification (`:121`) — so progress reporting doubles as the cancellation checkpoint.
- `ProgressAction` is a `[Flags]`-style enum (`Interval=1, Position=2, Task=4`, `:126-131`) though not attributed as such.
- Also in this file: `WaitHandleExtension.WaitOneAsync(this WaitHandle, …)` overloads (`:142-179`) — unrelated to progress, an async bridge over `ThreadPool.RegisterWaitForSingleObject`.

**(b) `ProgressEnumerator<T>` (`Signum.Utilities/Extensions/ProgressEnumerator.cs`, 165 lines)** — a *pull* model: an `IEnumerable<T>`/`IEnumerator<T>` decorator that also implements `IProgressInfo`. Never constructed directly; you get it via `EnumerableExtensions.ToProgressEnumerator` (`Extensions/EnumerableExtensions.cs:1058`):

```csharp
public static IEnumerable<T> ToProgressEnumerator<T>(this IEnumerable<T> source, out IProgressInfo pi)
```

`IProgressInfo` (`ProgressEnumerator.cs:155-165`): `Percentage`, `Ratio`, `Elapsed`, `Remaining`, `EstimatedFinish`. `Remaining` uses a **two-sample sliding window** (`lastLastTick`/`lastLastCurrent`, refreshed every `0xFF` or `0xFFF` items — see `GetCountStep`, `:33-39`) rather than a naive average, so ETA reacts to rate changes. Timing uses `PerfCounter.Ticks` from `Profiler/HeavyProfiler.cs:587`.

`ToString()` (`:141-152`) is the de-facto progress line format:

```csharp
return "{0:0.00}% | {1}/{2} | Elap: {3} + Rem: {4} = Total: {5} -> Finish: {6:u}".FormatWith(
    me.Percentage, current, count,
    ela.NiceToString(DateTimePrecision.Seconds),
    rem.NiceToString(DateTimePrecision.Seconds),
    (ela + rem).NiceToString(DateTimePrecision.Seconds),
    (DateTime.UtcNow + rem).ToLocalTime());
```

Caveats: `count` must be supplied up-front (`ToProgressEnumerator` calls `source.Count()`, materialising/enumerating twice); `Reset()` throws `NotImplementedException` (`:84-87`); `object IEnumerator.Current` returns the **index**, not the item (`:56-59`) — a real bug if anyone uses the non-generic interface.

**The composition of the two lives *outside* Signum.Utilities**, in `Signum/Engine/ProgressExtensions.cs` (287 lines) — `ProgressForeach`/`ProgressSelect`, sequential and `Parallel.ForEach` variants, per-item transactions, error logging via a `LogWriter` delegate, and console painting:

```csharp
var enumerator = collection.ToProgressEnumerator(out IProgressInfo pi);
if (!Console.IsOutputRedirected && showProgress)
    SafeConsole.WriteSameLine(pi.ToString());
foreach (var item in enumerator) { … SafeConsole.WriteSameLine(pi.ToString()); }
if (!Console.IsOutputRedirected && showProgress)
    SafeConsole.ClearSameLine();
```
(`Signum/Engine/ProgressExtensions.cs:110-156`, plus `GetConsoleWriter()`/`GetFileWriter()` at `:257-283`.)

**This is the single most valuable CLI pattern in the framework, and it is NOT in Signum.Utilities** — it lives in `Signum` (which drags in ASP.NET + SQL). A new CLI wanting `ProgressForeach` over non-DB work must reimplement the ~60 non-transactional lines on top of `ToProgressEnumerator` + `SafeConsole`.

### 1.4 `StartParameters.cs`

`Signum.Utilities/StartParameters.cs` (35 lines). Not a CLI-arguments class despite the name — it is a **global "degrade instead of crash at startup" switch**:

```csharp
public static List<Exception>? IgnoredDatabaseMismatches;  // :9  Initialize to enable
public static List<Exception>? IgnoredCodeErrors;          // :12 Initialize to enable
```

Plus `SelectCatch<T,R>(this IEnumerable<T>, Func<T,R>)` (`:15-34`), which swallows per-element exceptions **only when `IgnoredDatabaseMismatches != null`** (via an exception filter) and collects them. Intent documented in the comments: green/blue deployments where app and DB schema legitimately mismatch for a while, and dynamic-code scenarios. Irrelevant to a CLI except as a knob you may want to set before booting a Signum schema.

### 1.5 `DebugTextWriter.cs`

`Signum.Utilities/DebugTextWriter.cs` (26 lines). A 20-line `TextWriter` that forwards to `System.Diagnostics.Debug.Write` and counts `Lines`. Used to route framework output (e.g. generated SQL) to the VS Output window. Marginal for a CLI; `Console.Out`/a real `ILogger` is the better target.

### 1.6 `Statics.cs` — and why it matters for a non-web host

`Signum.Utilities/Statics.cs` (353 lines) + `Statics.md` (157 lines). This is the framework's **ambient-context abstraction**, and it is the piece a non-web host most needs to get right.

Two flavours:

**`ThreadVariable<T>` → `AsyncThreadVariable<T>`** (`:143-167`). Created by `Statics.ThreadVariable<T>(string name, bool avoidExportImport = false)` (`:17-22`), which registers it in a static `ConcurrentDictionary<string, IThreadVariable>` (`:9`) — duplicate names throw. Backed by `AsyncLocal<T>` (`:145`), so it flows across `await`. The idiomatic use is scoped override returning `IDisposable`:

```csharp
static readonly AsyncThreadVariable<int?> scopeTimeout = Statics.ThreadVariable<int?>("scopeTimeout");
public IDisposable Override(T newValue)          // Statics.cs:161-166
{
    var oldValue = Value;
    Value = newValue;
    return new Disposable(() => { Value = oldValue; });
}
```
Because every variable is registered centrally, the class can offer `ExportThreadContext(bool force = false)` / `ImportThreadContext(Dictionary<string,object>)` (`:24-48`) to marshal the whole ambient context onto another thread, and `CleanThreadContextAndAssert()` (`:50-61`) to assert at the end of a request/command that everything was properly `using`-scoped.

**`SessionVariable<T>`** (`:169-187`) — a *logical* session whose meaning is pluggable via `Statics.SessionFactory` (`:73-83`). Implementations shipped here:
- `SingletonSessionFactory` (`:223-263`) — one process-wide `Dictionary<string, object?>`. **This is the right one for a CLI / loading app / tests** (`Statics.md:146`: "Enough for Load applications and Tests").
- `ScopeSessionFactory` (`:265-353`) — decorator adding `ScopeSessionFactory.OverrideSession()` (`:281-293`) to swap the whole session inside a block; internally a `ThreadVariable<Dictionary<string,object?>>`.
- `VoidSessionFactory` (`:195-221`) — reads return `default`, writes throw.
- (`AspNetSessionFactory` lives in the web layer, not here.)
- Default is `new ScopeSessionFactory(new SingletonSessionFactory())` (`:72`).

`SessionVariable<T>.ValueFactory` (`:171`) makes it lazily initialised per session (`GetDefaulValue()`, `:178-186`).

**Why it matters for a CLI:** framework features assume ambient state — most importantly the current user (`Statics.md:121-129` shows `UserHolder.CurrentUserVariable = Statics.SessionVariable<IUserEntity>("user")`), plus culture, transaction scope, command timeouts. In a web host ASP.NET supplies per-request isolation. In a console host **the default `ScopeSessionFactory(SingletonSessionFactory)` gives you one global session for the whole process** — fine for a single-shot CLI verb, but if the CLI runs work in parallel or serves multiple logical identities it must either wrap each unit in `ScopeSessionFactory.OverrideSession()` or install a different factory. Getting this wrong manifests as "the current user leaks between operations".

### 1.7 `Csv.cs` / `Tsv.cs` — tabular I/O

**`Csv`** (`Signum.Utilities/Csv.cs`, 679 lines) + `Csv.md`. Uses public **fields and properties in declaration order** as columns (via `MemberEntryFactory`, see §2.3), not names — `Csv.md:83` warns about this explicitly.

Writing: `ToCsvFile<T>(this IEnumerable<T>, string fileName, …)` (`:17`), `ToCsvBytes<T>` (`:26`), `ToCsv<T>(…, Stream, …)` (`:36`). Common parameters: `encoding`, `culture`, `writeHeaders`, `autoFlush`, `append`, and a `toStringFactory` hook for per-column formatting. Special cases: if `T : IList` the rows are written positionally (`:44-65`); a trailing `List<X>` member becomes "all remaining columns" (`:94-106`, validated in `CsvMemberCache<T>`'s static ctor, `:551-573`).

Reading: `ReadFile<T>` (`:159`), `ReadBytes<T>` (`:168`), `ReadStream<T>` (`:174`, deferred), `ReadLine<T>` (`:269`), and untyped `ReadUntypedFile/Bytes/Stream` → `List<string[]>` (`:353-444`). Options via `CsvReadOptions<T>` (`:620-633`): `AsumeSingleLine` (default `true`), `SkipError(Exception, Match?) → bool`, `RegexTimeout`, `ListSeparator`, `ParserFactory`, `Constructor`. Errors surface as `ParseCsvException` carrying `Row`/`Member`/`Value` (`:658-678`).

Two **gotchas that matter a lot for a CLI**:
1. The separator is derived from the culture: `culture.TextInfo.ListSeparator.SingleEx()` (`:546-549`). Under `de-DE` that is `;`, under `en-US` `,`. Default culture is `Csv.DefaultCulture ?? CultureInfo.CurrentCulture` (`:446-449`). A CLI must pin culture or `ListSeparator` explicitly or output differs per machine locale.
2. Parsing is **regex-based** (`:536-544`, one cached `Regex` per separator, `RegexOptions.Multiline | ExplicitCapture`), not a streaming state machine — `AsumeSingleLine = false` reads the **entire file into a string** (`:233`).

Header names round-trip `_`↔space via `HandleSpaces` (`:154-157`; `__` escapes a literal underscore).

Genuinely nice CLI feature: **`InferClassFromFile` / `InferClassFromBytes` / `InferClassFromStream`** (`:451-533`) emit ready-to-paste C#:

```csharp
public class MyFileCSV
{
    public required int Id;
    public required string? Name;
    public required DateOnly? Signed;
}
```
Type inference order is `int/long → DateOnly → TimeOnly → DateTime → decimal → string`, with `?` when any value is empty (`:499-521`). This is exactly the kind of thing a `signum csv scaffold` verb would want.

**`Tsv`** (`Signum.Utilities/Tsv.cs`, ~300 lines) mirrors the API (`ToTsvFile`, `ToTsvBytes`, `ToTsv`, `ReadFile/ReadBytes/ReadStream/ReadLine`, `TsvReadOptions<T>`) with two differences: `DefaultCulture = CultureInfo.InvariantCulture` (`:12`, vs Csv's `null` → CurrentCulture — an inconsistency to be aware of) and an extra `ToTsvFile<T>(T[,] collection, …)` 2-D-array overload (`:14`). There is **no `Tsv.md`**.

### 1.8 `CRLFChecker.cs`

`Signum.Utilities/CRLFChecker.cs` (78 lines). A one-purpose developer-environment fixer: `CheckGitCRLF()` (`:12`) looks `../../../..` up from `Environment.CurrentDirectory` for a `Framework` folder, checks three known-stable `package.json` files for `\r\n` (`:19-26`), and if found offers — via `SafeConsole.Ask` — to run `git rm --cached -r .` + `git reset --hard` in both the app and `Framework` repos (`:30-43`). `ExecuteCommand` (`:47-77`) is a compact **`Process.Start` + capture stdout/stderr + colour-print** helper (gray output, red errors) that is a reasonable template for shelling out from a CLI, but it is `private static` and reads both streams to end before `WaitForExit` (deadlock-prone pattern for large output). The hardcoded Windows-style relative path `@"..\..\..\.."` and hardcoded file list make the class itself throwaway; its own doc-comment says "Feel [free to] remove this call once…".

### 1.9 Honest verdict: how much of a CLI is already built?

**Already built, reuse as-is:**
- `SafeConsole` colour + prompt primitives (`WriteColor`, `WriteLineColor`, `Ask`, `Ask(ref …)`, `AskString`, `AskRetry`, `AskMultiLine`) — small, dependency-free, and matching them keeps the CLI stylistically consistent with `Signum.Upgrade` and the code generators.
- `ConsoleSwitch<K,V>` for any interactive menu, including the paged/multi-select/range cases and the fuzzy-key confirmation.
- `SafeConsole.SyncKey` + `WriteSameLine`/`ClearSameLine` as the single-line status channel.
- `SafeConsole.WaitExecute`/`WaitQuery`/`WaitRows` for indeterminate operations.
- `ToProgressEnumerator` + `IProgressInfo` for ETA maths — don't recompute percentages.
- `EnumerableExtensions.ToConsoleTable` / `ToFormattedTable` / `FormatTable` (`Extensions/EnumerableExtensions.cs:635-666`) for tabular output — reflection-driven, header-aware, column-width-aligned. Genuinely useful and easy to miss.
- `Csv` / `Tsv` for data in/out, and `Csv.InferClassFromFile` if scaffolding is in scope.
- `Statics` + `SingletonSessionFactory` (or an explicit `OverrideSession` per unit of work) as the ambient-context host.
- `Disposable`, `ResetLazy`, `CultureInfoUtils.ChangeBothCultures` (§6) for scoping.

**Must be built new (nothing to reuse):**
- **Argument parsing.** Verified: `grep -rn "System.CommandLine|Environment.GetCommandLineArgs|CommandLineArgs"` across the repo finds **nothing**; the only `args` handling anywhere is `args[0]` string comparison in `Signum.MSBuildTask/Program.cs:21`, `Signum.TSGenerator/Program.cs:25` and `Utils/CheckUrl/CheckUrl/Program.cs:18-20`. No verbs, no flags, no `--help`, no usage text, no exit-code convention.
- Non-interactive / CI mode. Every existing abstraction is interactive-first (`Console.ReadLine`, `goto retry`, `Console.Clear()`). Only two concessions exist: `ConsoleSwitch.ChooseMultiple(args)` and `Console.IsOutputRedirected` checks.
- Structured logging / `ILogger` wiring. `Signum.Utilities` references `Microsoft.Extensions.Logging.Abstractions` but only `HeavyProfiler` uses it (`Profiler/HeavyProfiler.cs:15-16`).
- Configuration binding, DI container, host lifetime, cancellation on Ctrl+C (the only Ctrl handler present is the Windows-only P/Invoke, §1.2).
- Progress *bar* rendering, spinners, ANSI styling, `NO_COLOR` support, terminal-width-aware wrapping.
- `ProgressForeach`-equivalent without the `Signum` (ASP.NET + SQL) dependency.

**Reference implementations to copy the *shape* of** (they are the framework's own CLIs, all built on exactly these primitives):
- `Signum.Upgrade/Program.cs` (43 lines) + `Signum.Upgrade/CodeUpgradeRunner.cs` (211 lines) — banner, `WriteLineColor(DarkGray, …)` explanatory text, a `Draw()` list with per-item state colours (`:185-210`), `SafeConsole.Ask("Run next Upgrade ({0})?")`, `SafeConsole.Ask("What should we do next?", "commit", "retry", "exit")` (`:150`), and `UnexpectedValueException` on an unhandled enum (`:143`). Its only extra NuGet dependency is `LibGit2Sharp` (`Signum.Upgrade/Signum.Upgrade.csproj`).
- `Extensions/Signum.Migrations/CSharpMigrationRunner.cs` and `SqlMigrationRunner.cs` — same `Run/SetExecuted/Prompt/Draw/Execute` skeleton, plus an `autoRun` boolean that is the framework's *entire* notion of non-interactive mode.
- `Signum/CodeGeneration/CodeGenerator.cs` — the canonical `ConsoleSwitch` + `ChooseMultiple` + `Console.ReadLine().DefaultText(default)` idiom (`:15-25`, `:49-59`).

---

## 2. Reflection & metadata helpers

### 2.1 `Reflection/ReflectionTools.cs` (~920 lines)

The framework's reflection swiss-army knife. Highlights:

- **Lambda → MemberInfo** (the pattern that makes Signum refactor-safe): `GetPropertyInfo<R>(Expression<Func<R>>)` (`:95`), `GetPropertyInfo<T,R>(Expression<Func<T,R>>)` (`:100`), plus `GetFieldInfo` (`:144`, `:149`), `GetMemberInfo` (`:173`, `:178`), `GetMethodInfo` (`:199-214`, incl. `Expression<Action>` forms), `GetConstuctorInfo` (`:123`, sic), and the `BaseXxxInfo(LambdaExpression)` primitives (`:105`, `:128`, `:154`, `:183`, `:219`).
- **Structural member equality**: `FieldEquals`, `PropertyEquals`, `MethodEqual`, `MemeberEquals` (`:41-56`, sic) — needed because `MemberInfo` identity differs across generic instantiations.
- **Nullability**: `IsNullable(this FieldInfo/PropertyInfo/ParameterInfo)` (`:11-31`) using `NullabilityInfoContext`.
- **Compiled accessors**: `CreateGetter<T,R>(MemberInfo) → Func<T,R>?` (`:254`) and `CreateSetter<T,P>(MemberInfo) → Action<T,P>?` (`:276`) — expression-tree-compiled, the engine behind `MemberEntryFactory`.
- **Type classification**: `IsNumber` (`:294`), `IsIntegerNumber` (`:319`), `IsDecimalNumber` (`:341`), `IsDate` (`:357`), `IsPercentage` (`:365`), `ParsePercentage` (`:370`).
- **Parse/convert**: `Parse<T>(string?)` / `Parse(string?, Type)` / culture-aware overloads (`:396-470`), `TryParse` family (`:488-521`), a public `Dictionary<Type, Func<string,object>> CustomParsers` extension point (`:445`), `ChangeType<T>` / `ChangeType(object?, Type)` / `CanChangeType` (`:718-830`) — a much more capable `Convert.ChangeType` handling nullables, enums, `Lite<T>`-ish cases.
- Misc: `IsStatic(this PropertyInfo)` (`:889`), `BuildTimeUTC(this Assembly)` (`:895`), `IsBackingField(this FieldInfo)` (`:911`).

`ReflectionTools.md` exists alongside.

### 2.2 `DescriptionManager.cs` (~660 lines) + `DescriptionManager.md`

The **localization + human-naming subsystem**, and the reason `NiceToString()` appears everywhere in Signum code (including `ConsoleSwitch`'s own messages).

Public surface:
- `NiceName(this Type)` (`:182`), `NicePluralName(this Type)` (`:200`), `NiceName(this FieldInfo)` (`:237`), `NiceName(this PropertyInfo)` (`:242`), `NiceName<R>(Expression<Func<R>>)` / `NiceName<T,R>(Expression<Func<T,R>>)` (`:227`, `:232`).
- `NiceToString(this Enum)` (`:218`) and `NiceToString(this Enum, params object?[] args)` (`:213`) — the `args` overload does `.FormatWith(args)`, which is how `ConsoleMessage.NoOptionWithKey0Found.NiceToString(input)` works.
- `GetGender(this Type)` (`:278`) — feeds `NaturalLanguageTools.GetDeterminer` for gendered languages.
- `GetLocalizedType(Type, CultureInfo)` (`:306`), `GetLocalizedAssembly(Assembly, CultureInfo)` (`:324`), `Invalidate()` / `Invalidated` (`:361-362`).
- Extension points: `Func<Type,string> CleanTypeName` (`:129`, defaults to strip nothing but exists so `MyEntityEntity` → `MyEntity`), `Func<Type,Type> CleanType` (`:130`, for `Lite<T>`), `event Func<Type, DescriptionOptions?> DefaultDescriptionOptions` (`:134` — **by default any `enum` whose name ends in `Message` is auto-localizable**, which is why `ConsoleMessage` works with no attribute), `event Func<MemberInfo,bool> ShouldLocalizeMemeber` (`:135`), `event Action<CultureInfo,MemberInfo>? NotLocalizedMember` (`:136`), `Dictionary<Type, Func<MemberInfo,string>> ExternalEnums` (`:138`, pre-seeded with `DayOfWeek` → culture day names).

Attributes declared here: `DescriptionOptionsAttribute`/`DescriptionOptions` flags (`:13-34`), `PluralDescriptionAttribute` (`:59`), `GenderAttribute` (`:70`), `DefaultAssemblyCultureAttribute` (`:81`), and `FormatAttribute` (`:93-107`, with `Password`/`Color`/`Html`/`Markdown` constants and `FormatNumber`). `FormatAttribute` is also what `Csv`/`Tsv` read for per-column formats (`Csv.cs:568`).

Storage model: `LocalizedAssembly` (`:381-513`) / `LocalizedType` (`:515-...`) with `ExportXml()` / `ImportXml(Assembly, CultureInfo, bool forceCreate)` / `FromXml(...)`, i.e. **one XML file per assembly per culture**, resolved from:

```csharp
public static string TranslationDirectory =
    Path.Combine(Path.GetDirectoryName(typeof(DescriptionManager).Assembly.Location)!, "Translations");   // :132
```

`Signum.Utilities/Translations/` ships `Signum.Utilities.{de,es,fr,it,pt}.xml` (English is the code-level default via `[Description]`). **Caveat for a CLI:** `Signum.Utilities.csproj` contains no `Content`/`EmbeddedResource`/`None CopyToOutputDirectory` entry for `Translations/**`, and there is no `Directory.Build.props` in the repo — so the XMLs are *not* automatically next to the built assembly. A CLI that wants non-English `NiceToString()` must copy them itself (or set `DescriptionManager.TranslationDirectory`).

### 2.3 `Reflection/MemberEntryFactory.cs` + `TupleExtensions.cs` + `GenericInvoker.cs`

- **`MemberEntryFactory.GenerateList<T>(MemberOptions options, Type? type = null) → List<MemberEntry<T>>`** (`:7`). `MemberEntry<T>` (`:49-64`) = `Name` + `MemberInfo` + compiled `Func<T,object?>? Getter` + `Action<T,object?>? Setter`. `MemberOptions` flags (`:38`): `Fields | Properties | Getter | Setters | …`; `[Order]` attribute (`:78-84`) controls ordering. This is the shared engine behind `Csv`, `Tsv`, `ToDataTable`, and `ToStringTable` — the "public fields/properties in declaration order are the schema" convention.
- **`GenericInvoker<T>`** (`Reflection/GenericInvoker.cs`) — caches compiled delegates for generic-method instantiations, keyed by `Type[]` with a custom `TypeArrayEqualityComparer`:

```csharp
public GenericInvoker(Expression<T> expression) { … }
public T GetInvoker(params Type[] types) =>
    executor.GetOrAdd(types, ts => GeneratorVisitor.GetGenerator<T>(expression, ts).Compile());
```
Used ~46 files across `Signum`/`Extensions` — this is the framework's standard replacement for `MethodInfo.MakeGenericMethod(...).Invoke(...)` (avoids per-call reflection and boxing). Note it depends on `Signum.Utilities.ExpressionTrees`, so §3 is not optional plumbing.
- **`TupleExtensions.cs`** — helpers to build/deconstruct `Tuple`/`ValueTuple` types dynamically (used by the LINQ provider for projections).

### 2.4 `Polymorphic.cs` + `Polymorphic.md`

`Polymorphic<T> where T : class` = "a `Dictionary<Type, T>` that understands inheritance and interface implementation". Constructor `Polymorphic(PolymorphicMerger<T>? merger = null, Type? minimumType = null)`; API `GetValue(Type)`, `TryGetValue(Type)`, `GetDefinition(Type)`, `SetDefinition(Type, T)`, `ClearCache()`, `OverridenTypes`.

Purpose (`Polymorphic.md:5-8`): **external polymorphism** — dispatch on entity type from an assembly the entities cannot reference (entities must not depend on the engine/DB). Merge strategy is a delegate:

```csharp
public delegate T PolymorphicMerger<T>(
    KeyValuePair<Type, T> currentValue,
    KeyValuePair<Type, T> baseValue,
    List<KeyValuePair<Type, T>> newInterfacesValues) where T : class;
```
with prebuilt strategies (`PolymorphicMerger.Inheritance` is the default).

**Load-bearing**: 11+ files — `Signum/Entities/Validation/Validator.cs`, `Signum/Operations/OperationLogic.cs`, `Signum/API/Json/EntityJsonConverter.cs`, `Signum/DynamicQuery/ExpressionContainer.cs`, `Extensions/Signum.{Dashboard,DiffLog,Mailing,Scheduler,UserAssets}`. Not CLI-relevant unless the CLI hosts the engine.

---

## 3. Expression-tree machinery (`ExpressionTrees/`)

`ExpressionTrees/0.Intro.md` sets expectations bluntly: these are "general purpose and utility classes for working with `ExpressionTrees` and making a `LinqProvider` … public but meant to be used in very advanced scenarios".

**Why the framework needs it:** Signum's LINQ provider translates C# expression trees to SQL. Two hard problems arise. (a) *Opacity* — a property like `person.IsAmerican` is just a `MemberExpression` the provider can't see inside, so Signum needs a documented way to say "this member means *that* expression tree" and to inline it before translation. (b) *Boundary* — parts of a query are really local values (`myVariable`, `DateTime.Now`, a captured closure field) and must be collapsed to constants before translation, without accidentally collapsing the DB-side parts. `ExpressionNominator` + `ExpressionEvaluator` solve (b); `ExpressionCleaner` + the `LinqExtensibility` model solve (a). `GenericInvoker` (§2.3) and `Polymorphic` reuse the same visitors.

Piece by piece:

| File | Lines | Role |
|---|---|---|
| `ExpressionCleaner.cs` | 426 | The central rewriter. `Clean(Expression?)` / `Clean(expr, Func<Expression,Expression> partialEval, bool shortCircuit)` (`:25`, `:30`). Per `ExpressionCleaner.md`: (1) expands the three extensibility mechanisms, (2) evaluates constant subexpressions, (3) simplifies short-circuited (`&&`/`||`/ternary) expressions. Key members: `BindMethodExpression(MethodCallExpression, bool allowPolymorphics)` (`:74`), `BindMemberExpression` (`:139`), `HasExpansions(Type, MemberInfo)` (`:158`), `GetFieldExpansion(Type?, MemberInfo)` (`:163`). |
| `ExpressionNominator.cs` | 165 | `static HashSet<Expression> Nominate(Expression)` (`:16`) — marks the maximal subtrees that are purely local and therefore *could* be replaced by a constant. Also hosts **`LinqHints`** (`:84-165`): `InSql<T>(this T)`, `KeepConstantSubexpressions<T>(T)`, `DisableQueryFilter<T>(this IQueryable<T>)`, `OrderAlsoByKeys<T>`, `DistinctNull<T>`, `WithHint<T>(this IQueryable<T>, string hint)`, `Collate(this string?, string)` — user-facing markers that steer nomination/translation. |
| `ExpressionEvaluator.cs` | 240 | `PartialEval(Expression)` (`:24`) compiles + evaluates the nominated subtrees and substitutes the results; `Eval(Expression)` (`:36`) evaluates a whole tree. Caches compiled accessors for instance/static members and no-arg (incl. extension) methods to avoid over-compiling (`ExpressionEvaluator.md:16-22`). |
| `LinqExtensibility.md` | doc | The three extensibility models, credited to Tomáš Petříček's LINQ-Expand work: **(1)** a `static Expression<…>` field/`[AutoExpressionField]`-style member expression paired with the property; **(2)** `MethodExpanderAttribute` on a method; **(3)** explicit `ExpressionExtensions.Expand(...)`. The stated design principle: you don't teach the provider your member → SQL, you teach it your member → *another C# expression* it already understands. |
| `QueryProvider.cs` | 46 | `public abstract class QueryProvider : IQueryProvider` — all the `CreateQuery`/`Execute` scaffolding, leaving two abstracts: `object Execute(Expression)` and `string GetQueryText(Expression)` (debug only). `QueryProvider.md` inlines the full source. |
| `Query.cs` | 82 | `Query<T>` — the plain `IQueryable<T>`/`IOrderedQueryable<T>` companion; use as-is, don't subclass (`Query.md`). |
| `ExpandableQueryProvider.cs` | 61 | Wraps any `IQueryProvider` and runs `ExpressionCleaner` before delegating — i.e. brings the extensibility model to LINQ-to-SQL/EF/etc. |
| `ExpressionComparer.cs` | 345 | Structural equality: `AreEqual(a, b, ScopedDictionary<ParameterExpression,ParameterExpression>? parameterScope = null, bool checkParameterNames = false)` (`:25`) and `GetComparer<E>(bool)` (`:321`). Needed for expression-keyed caches. |
| `ExpressionHelper.cs` | 219 | Visitor plumbing: `NewIfChange`, `TryConvert`/`TryRemoveConvert`/`RemoveAllConvert`, `Nullify`/`UnNullify`/`RemoveAllNullify`, `AggregateAnd`/`AggregateOr`, `GetArgument`/`TryGetArgument(mce, parameterName)`, `StripQuotes`, `ToStringIndented`. |
| `ExpressionReplacer.cs` | 32 | `Replace(InvocationExpression)` and `Replace(Expression, Dictionary<ParameterExpression,Expression>)` — lambda beta-reduction. |
| `ExpressionStringBuilder.cs` | 876 | Human-readable expression rendering (the framework's own `DebugView`). |
| `CSharpRenderer.cs` | 197 | Renders `Type`/`MemberInfo`/signatures as C# source (`TypeName`, `MethodSignature`, `PropertyName`, `CleanIdentifiers`, `BasicTypeNames`). **Used by the code generators — directly relevant if the CLI scaffolds C#.** |
| `Linq.cs` | 106 | `Linq.Expr<R>(Expression<Func<R>>)` / `Linq.Func<R>(Func<R>)` overload families — type-inference helpers so you can write inline lambdas without naming the delegate type. |
| `QueryableAsyncExtensions.cs` | 173 | `IQueryProviderAsync` + `ToListAsync`/`ToArrayAsync`/`FirstAsync`/`FirstOrDefaultAsync`/… bound to `CancellationToken` (Signum's own async LINQ, independent of EF Core). |

Also at the project root, not in the folder: `ExpressionExpanderAttributes.cs` — `GenericMethodExpander`, `[ForceEagerEvaluation]`, `[AvoidEagerEvaluation]`, `[NewCanBeConstant]`, and the `As` helper class (`As.Expression<T>(Expression<Func<T>> body)` — the `[AutoExpressionField]` idiom's runtime side; plus `GetExpression`/`ReplaceExpression` for runtime patching). `ExpressionExpanderSamples.cs` holds worked examples.

**CLI relevance:** essentially none, *except* `CSharpRenderer` (code generation) and the fact that `GenericInvoker` depends on this namespace. It is not separable from the assembly.

---

## 4. Data structures (`DataStructures/`) — inventory

Usage counts below are `grep -rl` file counts across `Signum/` + `Extensions/` + `Signum.Upgrade/` (a proxy for load-bearing-ness, not exact).

| Type | File (lines) | One-liner | Load-bearing? |
|---|---|---|---|
| `DirectedGraph<T>` | `DirectedGraph.cs` (562) | Unweighted directed graph as `Dictionary<T,HashSet<T>>`; wraps *any* objects (no `INode` interface required). Rich API: `Generate(root(s), expandFunction)`, `IndirectlyRelatedTo`, `DepthExplore`/`BreadthExplore`, `Inverse`, `UndirectedGraph`, `CompilationOrder()`/`CompilationOrderGroups()` (topological sort), `FeedbackEdgeSet()` (cycle breaking), `Sinks()`, `Graphviz()`, `ToDGML()`. | **Yes, core.** 16 files: `Signum/Engine/Schema/Schema.cs`, `Schema.Save.cs`, `SchemaBuilder.cs`, `Signum/Engine/Saver.cs`, `EntityCache.cs`, `Signum/Entities/Reflection/GraphExplorer.cs`, `Signum/Entities/Modifiable.cs`, `Signum/Operations/GraphState.cs`, `Extensions/Signum.Caching`, `Signum.Authorization`, `Signum.Disconnected`, … It determines entity save order and cache invalidation order. |
| `DirectedEdgedGraph<T,E>` | `DirectedEdgedGraph.cs` (626) | Sibling of the above with data on edges: `Dictionary<T, Dictionary<T,E>>`. Plus `Edge<T,E>` struct and `DirectedEdgedGraphExtensions`. | Secondary (3 files). |
| `Interval<T>`, `NullableInterval<T>`, `IntervalWithEnd<T>` | `IntervalDictionaries/Interval.cs` (618) | Immutable comparable/formattable ranges with overlap/union/intersection semantics; `IntervalExtensions`. Returned by `EnumerableExtensions.ToInterval`. | Moderate (9 files). |
| `IntervalDictionary<K,V>` | `IntervalDictionary.cs` (339) | Maps non-overlapping `Interval<K>` → V, i.e. range lookup. Plus `IntervalValue<T>`, `IntervalDictionaryExtensions`. | **Incidental** — 0 hits in the framework/extensions. Pure utility for user loading code. |
| `SquareDictionary<K1,K2,V>` / `Square<T1,T2>` | (85 / 26) | 2-D interval lookup. | **Incidental** — 0 hits. |
| `CubeDictionary<K1,K2,K3,V>` / `Cube<T1,T2,T3>` | (94 / 32) | 3-D interval lookup. | **Incidental** — 0 hits. |
| `PriorityQueue<T>` | `PriorityQueue.cs` (174) | Binary heap over a flat `List<T>`, priority via `IComparable<T>` or a `Comparison<T>` (no explicit priority argument). Predates `System.Collections.Generic.PriorityQueue`. | **Incidental** (1 hit). Prefer BCL's in new code. |
| `ImmutableStack<T>` | `ImmutableStack.cs` (34) + `ImmutableStackExtensions` | Immutable singly-linked list usable as stack/list; `Empty`, O(1) Push/Pop/Peek. | Moderate (9 files); note the BCL `System.Collections.Immutable` alternative. `EnumerableExtensions.PushRange`/`EnqueueRange` bridge both this and `System.Collections.Immutable.ImmutableQueue`. |
| `ScopedDictionary<TKey,TValue>` | `ScopedDictionary.cs` (99) | Chained/nested lookup dictionary with a parent scope — lexical-scope symbol tables. | **Yes** for the LINQ provider (10 files; `ExpressionComparer` takes one for parameter scoping). |
| `RecentDictionary<K,V>` | `RecentsDictionary.cs` (262) | MRU/LRU cache: capacity-bounded (default 50) dictionary + `LinkedList`, fires `Purged` on eviction. | **Incidental** (1 hit). |
| `LambdaComparer<T,S>` | `LambdaComparer.cs` (163) | `IComparer<T>`+`IEqualityComparer<T>` from a `Func<T,S>` key selector; plus `LambdaComparer.CombineComparer`/`CombineEqualityComparer`. | **Incidental in-framework** (0 hits) but idiomatic for user code. |
| `ReferenceEqualityComparer<T>` | (38) | Restores reference identity where `Equals`/`GetHashCode` were overridden (`Entity` compares by Type+Id). | Moderate (6 files) — matters when graph-walking entities. |
| `HashSetComparer<T>` | `HashsetComparer.cs` (33) | Set equality as an `IEqualityComparer<HashSet<T>>`. | Incidental (0 hits). |
| `Grouping<K,T>` | `Grouping.cs` (39) | Signum's `IGrouping<K,T>` implementation, inherits `List<T>` (deliberately mutable — see `Grouping.md`). | **Yes** — returned by the LINQ provider's `GroupBy`. |
| `MinMax<T>` | `MinMax.cs` (38) | Immutable `(Min, Max)` pair of *non-comparable* items ranked by a selector; returned by `MinMaxBy`. | Minor (4 files). |
| `Sequence<T>` | `Sequence.cs` (13) | 13-line `List<T>` subclass used as a collection-initializer-friendly marker/flattener. | Minor (the 44-file grep count is mostly substring noise). |

Docs exist for most (`*.md` beside each). No `.md` for `ScopedDictionary`, `Sequence`, `HashsetComparer`.

**Takeaway for a CLI:** only `DirectedGraph` (dependency ordering — plausibly useful for a CLI that orders migrations/modules) and possibly `TreeHelper` (§5) are worth reaching for. The interval/cube family and `PriorityQueue`/`RecentDictionary` are legacy utility code with zero in-framework consumers.

---

## 5. Extension methods (`Extensions/`) — the idiomatic surface

`Extensions/Introduction.md` and the per-file `.md`s document these. Design creed (`Signum.Utilities/Introduction.md:10-17`): *small over big, functional over imperative, handy over intellectually gratifying, no dependencies.*

Files: `Extensions.cs`, `EnumerableExtensions.cs` (1544), `StringExtensions.cs` (897), `DictionaryExtensions.cs`, `DateTimeExtensions.cs`, `ListExtensions.cs`, `ArrayExtensions.cs`, `EnumExtensions.cs`, `GroupExtensions.cs`, `ReflectionExtensions.cs`, `RegexExtensions.cs`, `StreamExtensions.cs`, `FileExtensions.cs`, `TaskExtensions.cs`, `TimeSpanExtensions.cs`, `TimeOnlyExtensions.cs`, `ColorExtensions.cs`, `XmlExtensions.cs`, `ExpressionExtensions.cs`, `PageExtensions.cs`, `TreeHelper.cs`, `ProgressEnumerator.cs`.

### 5.1 The ~15 most idiomatic (match these in new code)

```csharp
// 1. "Ex" family — assert-with-a-good-message instead of silent/ambiguous failure.
//    EnumerableExtensions.cs:43,85,112,129 / :157,189,208 / :228,252,266 / :282
T  SingleEx<T>(this IEnumerable<T> collection);
T  SingleEx<T>(this IEnumerable<T> collection, Func<T,bool> predicate);
T  SingleEx<T>(this IEnumerable<T> collection, Func<string> elementName, bool forEndUser = false);
T? SingleOrDefaultEx<T>(this IEnumerable<T> collection);
T  FirstEx<T>(this IEnumerable<T> collection);
T? Only<T>(this IEnumerable<T> collection);          // 0 or 1 item -> value or null, >1 -> null

// 2. Null/empty predicates with nullable-flow attributes. EnumerableExtensions.cs:336,346; StringExtensions.cs:13
bool IsNullOrEmpty<T>([NotNullWhen(false)] this IEnumerable<T>? collection);
bool HasItems<T>([NotNullWhen(true)]  this IEnumerable<T>? collection);
bool HasText([NotNullWhen(true)] this string? str);   // ubiquitous; replaces !string.IsNullOrEmpty

// 3. String join, Signum-style. EnumerableExtensions.cs:427,446,470-495
string ToString<T>(this IEnumerable<T> source, string separator);
string ToString<T>(this IEnumerable<T> source, Func<T,string?> toString, string separator);
string CommaAnd<T>(this IEnumerable<T> collection);   // "a, b and c"  (localized)
string CommaOr<T>(this IEnumerable<T> collection);

// 4. Formatting. StringExtensions.cs:618-642
string FormatWith(this string format, object? arg0);
string FormatWith(this string pattern, params object?[] parameters);   // the house style over $"" in messages

// 5. Substring navigation — the single most distinctive Signum idiom.
//    StringExtensions.cs:97-440. Non-"Try" variants THROW when the separator is missing.
string  Before(this string str, char separator);        string?  TryBefore(this string? str, char separator);
string  After (this string str, char separator);        string?  TryAfter (this string? str, char separator);
string  BeforeLast(...); string AfterLast(...);         string?  TryBeforeLast(...); string? TryAfterLast(...);
string  Between(this string str, string first, string? second = null);   string? TryBetween(...);

// 6. Dictionary access with intent. DictionaryExtensions.cs:19,95,111,73,119
V? TryGetC<K,V>(this IReadOnlyDictionary<K,V> dictionary, K key);          // class values
V? TryGetS<K,V>(this IReadOnlyDictionary<K,V> dictionary, K key);          // struct values
V  GetOrThrow<K,V>(this IDictionary<K,V> dictionary, K key);               // + message/exception overloads
V  GetOrCreate<K,V>(this IDictionary<K,V> dictionary, K key, Func<V> generator);
void AddOrThrow<K,V>(this IDictionary<K,V> d, K key, V value, string messageWithFormat);

// 7. Dictionary building that reports duplicates properly. DictionaryExtensions.cs:166,174 + GroupExtensions.cs:41
Dictionary<K,T> ToDictionaryEx<T,K>(this IEnumerable<T> source, Func<T,K> keySelector, string? errorContext = null);
Dictionary<K,List<T>> GroupToDictionary<T,K>(this IEnumerable<T> collection, Func<T,K> keySelector);

// 8. Ranges + iteration. Extensions.cs:337,343,349,368
IEnumerable<int> To(this int start, int endNotIncluded);          // 0.To(10)
IEnumerable<int> To(this int start, int endNotIncluded, int step);
IEnumerable<DateTime> To(this DateTime start, DateTime endNotIncluded);
IEnumerable<int> DownTo(this int startNotIncluded, int end);

// 9. Functional glue. Extensions.cs:269,325,383
R Let<T,R>(this T t, Func<T,R> func);                    // pipe/let-binding
T Do<T>(this T t, Action<T> action);                     // side-effect, returns self
IEnumerable<T> Follow<T>(this T start, FuncCC<T,T?> next) where T : class;   // unfold a linked chain

// 10. Parsing that returns null instead of throwing. Extensions.cs:13-77
int? ToInt(this string str, NumberStyles ns = NumberStyles.Integer, CultureInfo? ci = null);
int  ToInt(this string str, string error);               // "…, or throw with this message"
decimal? ToDecimal(...); bool? ToBool(...); Guid? ToGuid(...);

// 11. Enum conveniences. EnumExtensions.cs:7,25,43 + DescriptionManager.cs:213
T  ToEnum<T>(this string str) where T : struct, Enum;
T? TryToEnum<T>(this string str) where T : struct, Enum;
T[] GetValues<T>();
string NiceToString(this Enum a, params object?[] args);  // localized display text

// 12. Set-like additions / bulk mutation. EnumerableExtensions.cs:374,381,1093 + ListExtensions.cs:6,26
IEnumerable<T> And<T>(this IEnumerable<T> collection, T newItem);      // append one — very common
IEnumerable<T> PreAnd<T>(this IEnumerable<T> collection, T newItem);
void AddRange<T>(this HashSet<T> hashset, IEnumerable<T> collection);
List<T> Extract<T>(this IList<T> list, Func<T,bool> condition);        // remove-and-return
void Sort<T,A>(this List<T> list, Func<T,A> element);                  // sort by key, in place

// 13. Console/report output. EnumerableExtensions.cs:523,655,660,635
void   ToConsole<T>(this IEnumerable<T> collection, Func<T,string> toString);
void   ToConsoleTable<T>(this IEnumerable<T> collection, string? title = null, bool longHeader = false);
string ToFormattedTable<T>(this IEnumerable<T> collection, string? title = null, bool longHeader = false);
string FormatTable(this string[,] table, bool longHeaders = true, string separator = " ");

// 14. Set-difference joins that FAIL LOUDLY on mismatch — the synchronization workhorse.
//     EnumerableExtensions.cs:1110,1135,1196 + DictionaryExtensions.cs:260,284,317
IEnumerable<R> JoinStrict<K,C,S,R>(...);                 // throws listing missing/extra keys
IEnumerable<R> JoinRelaxed<K,C,S,R>(...);
Dictionary<K,V3> JoinDictionaryStrict<K,V1,V2,V3>(this IDictionary<K,V1> current, IDictionary<K,V2> should, Func<K,V1,V2,V3> mixer);
void JoinDictionaryForeachStrict<K,C,S>(...);

// 15. Indentation / text shaping for generated output. StringExtensions.cs:668-740, 527-539, 569
string Indent(this string str, int numChars);            // and (int, char), (string space)
string Unindent(this string str, int removeSpaces, char indentChar = ' ');
string PadTruncateRight(this string str, int length, char paddingChar = ' ');   // used by WriteSameLine/FormatTable
string Etc(this string str, int max, string etcString);  // truncate with ellipsis
```

### 5.2 Also worth knowing

- **`EnumerableExtensions`** (1544 lines): `Iterate<T>()` → `IEnumerable<Iteration<T>>` with `IsFirst/IsLast/Position` (`:1219`); `BiSelectC`/`BiSelectS` for pairwise/sliding-window (`:804`, `:832`); `SelectAggregate` (running fold, `:862`); `CartesianProduct` (`:872`); `Distinct(collection, keySelector)` (`:888`); `ZipStrict`/`ZipOrDefault`/`ZipForeach*` (`:915-1000`); `Duplicates(source, selector)` (`:1240-1257`); `Slice` (`:898`); `MinMaxBy`/`MinByList`/`MaxByList` (`:670-738`); `ToInterval` (`:739`); `Shuffle(rng)` (`:413`); `AsThreadSafe()` (`:1053`); `ToDataTable`/`Transpose` (`:549`, `:565`); `ToFile` (`:534`); a large `StdDev`/`StdDevP` family (`:1319-1543`) with both `IEnumerable` and `IQueryable` (provider-dispatched) forms.
- **`StringExtensions`**: `Add(str, separator, part)` / `AddLine` (`:56`, `:69`); `Lines()` (`:74`); `Start`/`End`/`TryStart`/`RemoveStart`/`RemoveEnd` (`:442-505`); `SplitInGroupsOf` (`:506`); `Truncate` (`:539`); `VerticalEtc` (`:586`); `Replace(Dictionary<string,string>)` (`:643`); `FirstUpper`/`FirstLower` (`:741`, `:748`); `Replicate` (`:755`); `Like(pattern)` (SQL-style wildcards, `:776`); `RemoveDiacritics` (`:784`); `ToComputerSize(this long)` (`:808`); `Combine(this string separator, params object?[])` (`:818`); `SplitNoEmpty` overloads (`:863-878`); `AppendLineLF` (`:888`) — LF-normalized `StringBuilder`, deliberate given the repo's CRLF policy (§1.8); `CountRepetitions` (`:848`); `DefaultText`/`DefaultToNull`/`AssertHasText` (`:23`, `:35`, `:43`).
- **`DateTimeExtensions`** (~500 lines): `IsInInterval` overloads (`:13-31`); `YearsTo`/`MonthsTo`/`DaysTo`/`TotalMonths` (`:69-116`); `DateSpanTo` + `DateSpan` type (`:144`); `Min`/`Max` incl. nullable (`:154-201`); `DateOnly`/`TimeOnly`/`TimeSpan` conversions (`:202-247`); `TruncTo(DateTimePrecision)` + `GetPrecision` (`:249`, `:263`); `YearStart`/`QuarterStart`/`MonthStart`/`WeekStart`/`TruncHours`/`TruncMinutes`/`TruncSeconds` incl. `step` variants (`:398-492`); `ToIsoString` (`:355`); `ToAgoString` (`:365`, localized "3 days ago"); `SmartShortDatePattern`/`SmartDatePattern` (`:289-326`, omits redundant year/month vs. today); `JavascriptMilliseconds` (`:390`). `DateTimePrecision` is the shared enum; `TimeSpanExtensions.NiceToString(TimeSpan[, DateTimePrecision])` (`TimeSpanExtensions.cs:76`, `:81`) is what `SafeConsole.WaitExecute` and `ProgressEnumerator` use for durations.
- **`ReflectionExtensions`**: `UnNullify`/`Nullify`/`IsNullable(this Type)` (`:10-20`); `IsAnonymous` (`:25`); `ReturningType(this MemberInfo)` (`:34`); `HasAttribute<T>`/`HasAttributeInherit<T>` (`:44`, `:49`); `IsInstantiationOf(Type, Type)` and `(MethodInfo, MethodInfo)` (`:54`, `:62`); `GetGenericInterfaces` (`:70`); `ElementType(this Type)` (`:92`); `IsExtensionMethod` (`:102`); `IsStaticClass` (`:124`); `CompilationDate(this Assembly)` (`:133`); `PreserveStackTrace(this Exception)` (`:165`).
- **`StreamExtensions`**: `ReadAllBytes`/`ReadAllBytesAsync`/`WriteAllBytes` (`:10-35`); `ReadResourceStream(this Assembly, name, encoding)` (`:43`); `StreamsAreEqual`/`FilesAreEqual` (`:55`, `:93`); the `Using<T,R>(this T disposable, Func<R>)` / `Using(Func<T,R>)` / `UsingAsync` / `EndUsing` family (`:106-217`) that lets `using` participate in expression position; `ProgressStream : Stream` (`:251`) — a byte-level progress wrapper.
- **`FileExtensions`** (`FileTools`): `AvailableFileName(string)` (`:7`, appends (1),(2)…), `CreateParentDirectory(string)` (`:21`), `GetTemporalFile(this byte[], extension[, ignoreDisposingErrors])` (`:76`, `:81`) → self-deleting `TemporalFile`.
- **`RegexExtensions`**: `EndIndex(this Match)`, `Captures(...)`, `Groups(...)`, `MostSimilar<T>(collection, stringSelector, pattern)` (`:34`), `JoinSimilar` (`:60`), `SplitAfter(this Regex, string)` (`:85`).
- **`TreeHelper`**: `BreathFirst<T>(root, children)` / `DepthFirst<T>(root, children)` (`:60`, `:72`) — flat, no allocation of a tree; plus `ToTreeC`/`ToTreeS(collection, getParent)` → `ObservableCollection<Node<T>>` and `SelectTree`/`SelectSimplifyTreeC/S`/`Apply`. The `BreathFirst`/`DepthFirst` pair is broadly useful (e.g. walking a directory tree in a CLI).
- **`PageExtensions`**: `Page<T>` (`:11`) + `Paginate` for `IQueryable`/`IEnumerable` (`:46`, `:62`), `TryTake(int? count)` (`:70`, `:78`).
- **`ArrayExtensions`**: 2-D/3-D array helpers — `Initialize`, `Row`, `Column`, `AddRow`, `AddColumn`, `SelectArray`, `Slice`. Pairs with `Tsv.ToTsvFile<T>(T[,], …)`.
- **`Extensions.cs` misc**: `Mod`/`DivMod`/`DivCeiling` (true-modulo, `:154-231`); `RoundTo(decimal|double, int decimals)` (`:139`, `:144`); `NotFoundToNull`/`NotFound` for `IndexOf` results (`:259`, `:264`); `DefaultToNull<T>` (`:247`); a `Try(...)` family predating `?.` (`:275-324`) — legacy, prefer `?.`; `GetInvocationListTyped<D>` (`:402`); `GetQueryString(object)` (`:411`).
- **Root-level extras**: `JsonExtensions.cs` (`System.Text.Json` helpers: `ToObject<T>(this JsonElement)`, `ToJsonString/Bytes/File`, `FromJsonString/Bytes/File`, `TryGetProperty`, `Utf8JsonReader.Assert`/`GetLiteralValue`); `MyRandom.cs` (`RandomExtensions`: `NextBool`, `NextString(length[, chars])`, `NextSubstring`, `NextDateTime(min,max)`, `NextLong`, `NextElement`, `NextParams`, `NextColor` — test-data generation); `Disposable.cs` (`new Disposable(Action)`, `Disposable.Combine(a, b)`, `Disposable.Combine<Del>(del, invoke)` for combining event-handler-returned disposables, `DisposableException`) — **80 files use it**, the framework's universal scope idiom; `UnexpectedValueException` (throw in a `default:` case, used e.g. `CodeUpgradeRunner.cs:143`); `StringDistance.cs` (see §6); `FontAwesomeV6Upgrade.cs` (a ~680-entry icon-rename dictionary + `UpdateIconName(string)` — pure migration data, no business in a general utility library).

---

## 6. Synchronization / NaturalLanguage / Profiler / Translations (brief)

### `Synchronization/`
- **`ResetLazy.cs`** — `ResetLazy<T>(Func<T> valueFactory, LazyThreadSafetyMode mode = PublicationOnly, Type? declaringType = null)`. Like `Lazy<T>` but **invalidatable**: `Value`, `GetValue(out DateTimeOffset loadedOn)`, `Load()`, `IsValueCreated`, `Reset()`, `event EventHandler? OnReset`, plus instrumentation counters `Loads`/`Hits`/`Invalidations`/`SumLoadtime` and `ResetLazyStats`. **58 files use it** — this is the framework's caching primitive (schema metadata, auth rules, type caches all reset on invalidation).
- **`CultureInfoUtils.cs`** — `ChangeCulture`, `ChangeCultureUI`, `ChangeBothCultures` (by `CultureInfo` or `string`), each returning `IDisposable?` for `using` scopes. **Directly relevant to a CLI**: pin culture per invocation so `Csv` separators / `NiceToString` / number formats are deterministic (see §1.7 gotcha).
- **`ThreadSafeEnumerator.cs`** + `.md` — `TreadSafeEnumerator<T>` (sic) lets N threads pull from one `IEnumerator<T>` with each element delivered exactly once; surfaced as `EnumerableExtensions.AsThreadSafe()`. Deliberately *not* PLINQ: it stays an `IEnumerable` so you can chain LINQ per consumer thread.
- **`TaskExtensions.cs`** — two lines: `WaitSafe(this Task)` and `ResultSafe<T>(this Task<T>)`, both `GetAwaiter().GetResult()` (unwraps `AggregateException`). Handy in `Main` for a sync CLI, though `async Main` is better.

### `NaturalLanguage/`
`NaturalLanguageTools.cs` plus per-language plug-ins `English.cs`, `German.cs`, `Spanish.cs`. Registry dictionaries keyed by two-letter culture: `Pluralizers`, `GenderDetectors`, `NumberWriters`, `DiacriticsRemover` (`:11-40`) — add an entry to support a new language. API: `Pluralize(singularName, culture?)` (`:106`), `GetGender(name, culture?)` (`:42`), `HasGenders(culture)` (`:54`), `GetDeterminer(gender, plural, culture?)` (`:65`), `TryGetGenderFromDeterminer` (`:82`), `ForGenderAndNumber(this string genderAwareText, char? gender, int? number)` (`:268`, resolves `[el|la]`-style markers). Casing converters used all over code generation and UI labels: **`SpacePascal(this string)`** (`:126`, `:135` with `preserveUppercase`), `SpacePascalOrUnderscores` (`:119`), `PascalToSnake` (`:175`), `ToPascal(this string)` / `ToPascal(str, firstUpper, keepUppercase)` (`:236`, `:241`). Also `NumberFormatter.ToStringWithCompact(this decimal|double, format, culture?)` (`:380`, `:383`) — "1.2K"-style compact numbers. `NaturalLangageTools.md` (sic) documents it. Note `ConsoleSwitch`'s auto-labels and `Csv.InferClass` both depend on this file.

### `Profiler/`
- **`HeavyProfiler.cs`** (~640 lines) — hierarchical sampling profiler. `Enabled` (`:23`, auto-disables after `MaxEnabledTime = 5 min`), `Tracer? Log(string kind[, Func<string?> additionalData][, LogLevel])` (`:53-73`) used as `using (HeavyProfiler.Log("ProgressForeach", () => elementID(item))) { … }` (real example: `Signum/Engine/ProgressExtensions.cs:125`), `LogNoStackTrace` (`:83`), `Tracer.Switch(...)` (`:245`, `:260`), `Entries`/`AllEntries()`/`Find(fullIndex)`, `ExportXml`/`ImportXml`/`ImportEntries`, `SqlStatistics()`/`SqlStatisticsXDocument()`. Bridges to modern telemetry: `static ILoggerFactory? LoggerFactory` and `static ActivitySource? ActivitySource` (`:15-16`) — **this is the only reason `Signum.Utilities` references `Microsoft.Extensions.Logging.Abstractions`**. Also hosts `PerfCounter` (`:587`, `FrequencyMilliseconds`, `Ticks`, `ToMilliseconds`) used by `ProgressEnumerator`. **63 files use it.**
- **`TimeTracker.cs`** — coarser: `IDisposable Start(string identifier, string? url = null, Func<object>? getUser = null)` accumulating into `ConcurrentDictionary<string, TimeTrackerEntry>` (min/max/avg/count), for always-on "how long does X take on average" stats.

### `Translations/`
Five XML files (`Signum.Utilities.{de,es,fr,it,pt}.xml`) consumed by `DescriptionManager`/`LocalizedAssembly` — one `<Type Name="…"><Member Name="…" Description="…"/></Type>` block per localizable enum (`ConsoleMessage`, `DateTimeMessage`, …). English is the in-code default via `[Description]`. See the copy-to-output caveat in §2.2.

---

## 7. Dependencies & target framework — is it standalone?

`Signum.Utilities/Signum.Utilities.csproj` in full:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <WarningsAsErrors>nullable</WarningsAsErrors>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.Extensions.Logging.Abstractions" Version="10.0.9" />
  </ItemGroup>
</Project>
```

- **Target:** `net10.0` (plain, *not* `Microsoft.NET.Sdk.Web`, no `FrameworkReference Microsoft.AspNetCore.App`). Contrast `Signum/Signum.csproj`, which does add `<FrameworkReference Include="Microsoft.AspNetCore.App" />` plus `Microsoft.Data.SqlClient`, `Npgsql`, `Microsoft.SqlServer.Types`, `Pgvector`.
- **Exactly one NuGet dependency:** `Microsoft.Extensions.Logging.Abstractions` 10.0.9 — used only by `HeavyProfiler` (`LoggerFactory`, `LogLevel`, `StructuredLogMessage`). It is an abstractions-only package: no host, no provider, no ASP.NET.
- **Zero project references.** Everything else it touches is in the BCL: `System.Data` (`DataTable` in `ToDataTable`/`ToStringTable`), `System.Text.Json`, `System.Xml.Linq`, `System.Collections.Immutable`/`Frozen`, `System.Runtime.InteropServices` (the one Windows P/Invoke), `System.Diagnostics` (`ActivitySource`, `Debug`, `Process`).
- **Nullable reference types are enabled *and* `WarningsAsErrors=nullable`** — new code in this style must be null-annotation-clean.
- Implicit usings via `Properties/GlobalUsings.cs`: `System`, `System.Collections.Generic`, `System.Linq`, `System.Linq.Expressions`, `System.Text`, `System.Reflection`. (No `ImplicitUsings` property; it's explicit.) Files therefore rarely carry `using` headers — match that.
- `Properties/Attributes.cs` holds assembly-level attributes (incl. `DefaultAssemblyCulture` for `DescriptionManager`).

**Answer: yes, fully usable standalone.** No ASP.NET, no database, no DI container, no configuration system. `Signum.Upgrade` is the existence proof: an `OutputType=Exe` console app whose only references are `Signum.Utilities` + `LibGit2Sharp`.

Two operational caveats for a standalone consumer:
1. `Translations/*.xml` are not copied to the output directory by this csproj (§2.2) — non-English `NiceToString()` needs manual handling.
2. `SafeConsole.SetConsoleCtrlHandler` is an unannotated Windows-only P/Invoke (§1.2) — don't call it from cross-platform code.

---

## Appendix: file map (quick reference)

```
Signum.Utilities/
├── Signum.Utilities.csproj        net10.0; 1 NuGet dep (Logging.Abstractions)
├── Introduction.md                design creed: small/functional/handy/no-deps
├── ConsoleSwitch.cs   .md         interactive menus  ← CLI
├── SafeConsole.cs     .md         colour, prompts, same-line, wait-spinner  ← CLI
├── ProgressProxy.cs   .md         UI-agnostic push progress + WaitOneAsync
├── Csv.cs  .md / Tsv.cs           tabular I/O + C#-class inference  ← CLI
├── CRLFChecker.cs                 dev-env git fixer + Process.Start template
├── Statics.cs         .md         ThreadVariable / SessionVariable / session factories  ← CLI
├── StartParameters.cs             IgnoredDatabaseMismatches / IgnoredCodeErrors
├── DebugTextWriter.cs .md         TextWriter -> Debug.Write
├── DescriptionManager.cs .md      NiceName/NiceToString/localization + FormatAttribute
├── Polymorphic.cs     .md         Dictionary<Type,T> honouring inheritance
├── StringDistance.cs  .md         Levenshtein/LCS/Smith-Waterman + diff
├── Disposable.cs      .md         Disposable(Action), Combine  (80 users)
├── MyRandom.cs .md / JsonExtensions.cs / UnexpectedValueException.cs
├── ExpressionExpanderAttributes.cs / ExpressionExpanderSamples.cs / FontAwesomeV6Upgrade.cs
├── Properties/{GlobalUsings.cs, Attributes.cs}
├── Reflection/    ReflectionTools(.md), MemberEntryFactory, GenericInvoker, TupleExtensions
├── ExpressionTrees/  15 files + 9 .md — see §3
├── DataStructures/   17 files + 11 .md — see §4
├── Extensions/       22 files + 15 .md — see §5
├── Synchronization/  ResetLazy, CultureInfoUtils(.md), ThreadSafeEnumerator(.md), TaskExtensions
├── NaturalLanguage/  NaturalLanguageTools + English/German/Spanish (+ .md)
├── Profiler/         HeavyProfiler(.md), TimeTracker(.md)
└── Translations/     Signum.Utilities.{de,es,fr,it,pt}.xml
```

Outside this project but essential CLI reading:
- `Signum/Engine/ProgressExtensions.cs` — `ProgressForeach`/`ProgressSelect` + `LogWriter` (needs `Signum`, i.e. ASP.NET + SQL).
- `Signum.Upgrade/Program.cs`, `Signum.Upgrade/CodeUpgradeRunner.cs` — the reference console-tool skeleton.
- `Signum/CodeGeneration/CodeGenerator.cs` — canonical `ConsoleSwitch` usage.
- `Extensions/Signum.Migrations/{CSharpMigrationRunner,SqlMigrationRunner}.cs` — same skeleton + `autoRun`.
