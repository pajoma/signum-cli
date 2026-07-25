# Signum Framework — Core Runtime Architecture (Entities, ORM/LINQ, Operations, DynamicQuery)

Repo: `/home/patrick.maue/git/sfcl/signum-framework` (branch as analysed: merge of `AlejandroCano/fixChartUtils`, HEAD `74bd24693d`).
All paths below are absolute. Line numbers are from the working tree at time of analysis.

**Doc-drift warning up front.** This framework documents itself in `.md` files sitting next to the sources, but many of those files predate the current code by several major versions (they still talk about WCF, `Signum.Windows`, `SqlConnector`, `SchemaBuilderSettings`, `AllowNew`/`Lite` operation members, `int Id`). Every claim in this report was verified against the C# source; where docs and code disagree I say so explicitly.

---

## 1. Entity model

### 1.1 The hierarchy

```
object
└── Modifiable                                   /Signum/Entities/Modifiable.cs:6
    ├── MList<T>                                 /Signum/Entities/MList.cs:11
    ├── LiteImp / LiteImp<T,M>  (impl of Lite<T>) /Signum/Entities/LiteImp.cs:3, :8
    └── ModifiableEntity                         /Signum/Entities/ModifiableEntity.cs:21
        ├── EmbeddedEntity                       /Signum/Entities/EmbeddedEntity.cs:4
        ├── ModelEntity                          /Signum/Entities/ModelEntity.cs:3
        ├── MixinEntity                          /Signum/Entities/MixinEntity.cs:7
        └── Entity                               /Signum/Entities/Entity.cs:11
            ├── EnumEntity<T>                    /Signum/Entities/EnumEntity.cs
            ├── Symbol                           /Signum/Basics/Symbol.cs:5
            └── SemiSymbol                       /Signum/Basics/SemiSymbol.cs:5
```

**Deviation from the docs:** `/Signum/Entities/BaseEntities.md:10` says `ModelEntity` inherits from `EmbeddedEntity`. In the code it inherits `ModifiableEntity` directly *and* implements `IRootEntity` (`/Signum/Entities/ModelEntity.cs:3`), which is what makes it a valid `PropertyRoute.Root(...)`. Its `PostRetrieving` throws outright (`ModelEntity.cs:10-13`).

`EmbeddedEntity` is a pure marker — the class body is literally empty (`EmbeddedEntity.cs:4-6`). Its meaning lives entirely in the schema builder (embedded fields are flattened into the parent table with a `<Field>_<SubField>` column-name prefix and an optional `HasValue` bit column).

`MixinEntity` (`/Signum/Entities/MixinEntity.cs:7-34`) is an in-memory **linked list** hung off every `ModifiableEntity`:

```csharp
protected MixinEntity(ModifiableEntity mainEntity, MixinEntity? next)   // MixinEntity.cs:9
{
    this.mainEntity = mainEntity;
    this.next = next;
}
[Ignore] readonly MixinEntity? next;              // :16
[Ignore] readonly ModifiableEntity mainEntity;    // :24
```

Note the ctor takes `ModifiableEntity`, not `Entity` (the `Mixin.md:63` doc says `Entity`) — mixins can now be declared on embeddeds too. The list is created in the `ModifiableEntity` ctor: `mixin = MixinDeclarations.CreateMixins(this)` (`ModifiableEntity.cs:513-516`), so **there is no way to have an instance without its mixins**. Access: `Mixin<M>()` walks the list (`ModifiableEntity.cs:520-541`), `TryMixin<M>()`, `TryMixin(string)`, `GetMixin(Type)`, `this[string mixinName]` (`:571`), `Mixins` (`:589`). Registration is either `[Mixin(typeof(X))]` on the type or `MixinDeclarations.Register<TEntity, TMixin>()` **before** the entity is included in the schema (`/Signum/Entities/MixinEntity.cs:47-60`; `MixinDeclarations.AssertNotIncluded` at `:44` is the guard, replaced by the engine at startup).

### 1.2 `Entity`: identity, ToStr, Ticks, PartitionId

```csharp
[DescriptionOptions(DescriptionOptions.All), InTypeScript(false)]
public abstract class Entity : ModifiableEntity, IEntity        // Entity.cs:10-11
{
    [Ignore] internal PrimaryKey? id;                            // :14
    [Ignore] protected internal string? ToStr;                   // :18  only for non-expression ToString
    public PrimaryKey Id { get {                                 // :21
        if (id == null) throw new InvalidOperationException("{0} is new and has no Id"...);
        return id.Value; } internal set { id = value; } }
    public PrimaryKey? IdOrNull => id;                           // :33
    [Ignore] bool isNew = true;  public bool IsNew { ... }        // :39, :41
    [Ignore] internal long ticks;  public long Ticks { ... }      // :48, :50
    [Ignore] internal int? partitionId; public int? PartitionId { get; set => Set(...) } // :66, :68
}
```

- **`Id` is not a field on the wire model**: `id` is `[Ignore]`d so the schema builder synthesizes the PK column itself; likewise `ticks`, `ToStr`, `partitionId` (`/Signum/Engine/Schema/SchemaBuilder/SchemaBuilder.cs:470-561`).
- **Equality is by `(Type, Id)`, not reference** (`Entity.cs:104-116`): two different instances with the same concrete type and the same non-null `id` are `Equals`. `GetHashCode` = `StringHashEncoder.GetHashCode32(GetType().FullName) ^ id.GetHashCode()` when saved (`Entity.cs:132-137`); when new, it falls back to `ModifiableEntity.GetHashCode`, which is `GetType().FullName.GetHashCode() ^ temporalId.GetHashCode()` where `temporalId` is a per-instance `Guid` (`ModifiableEntity.cs:288-294`). **Surprise:** a new entity's hash code changes the moment it is saved. Never put unsaved entities in a long-lived `HashSet`/`Dictionary` that survives a save.
- **`ToString` is an expression by default.** `Entity.ToString()` is `[AutoExpressionField] => As.Expression(() => BaseToString())` and `BaseToString()` = `IsNew ? GetType().NewNiceName() : GetType().NiceName() + " " + Id` (`Entity.cs:98-102`). If a subclass overrides `ToString` with `[AutoExpressionField]`, the schema builder *omits* the `ToStr` column entirely (`SchemaBuilder.cs:497`). If it overrides it with plain C#, the evaluated string is persisted into `ToStr` on save. This is the single most important consequence of the "query expression" pattern for the DB shape.
- **`Ticks` = optimistic concurrency**, value is `Clock.Now.Ticks` at save. Because `MList<T>` persistence sends surgical INSERT/DELETE/UPDATE keyed on `RowId`, **`MList` fields are only legal on entities that have Ticks** (`SchemaBuilder.cs:963-964`). Disable with `[TicksColumn(false)]` (`/Signum/Entities/FieldAttributes.cs:469`).
- **`PartitionId`** is new and undocumented in the `.md` files: opt-in via `[PartitionColumn]` (`FieldAttributes.cs:453`), used for SQL-Server table partitioning; `SchemaBuilder.WithPartition<T>(calc)` (`SchemaBuilder.cs:1225-1233`) registers both the column *and* a `PreSaving` hook that computes it. `Lite<T>` carries `PartitionId` too (`/Signum/Entities/Lite.cs:36`) purely to let queries prune partitions.
- `_TypeConditions` (`Entity.cs:78`) is a runtime bag used by property-level type-condition authorization.
- `UnsafeEntityExtensions` (`Entity.cs:168-245`) is the deliberate escape hatch: `SetId`, `SetIsNew`, `SetNotModified`, `SetModified`, `SetReadonly` (reflection-emitted field setter, `:197-205`), `SetNotModifiedGraph`. A CLI doing data import will need these.

### 1.3 `PrimaryKey`

`/Signum/Entities/PrimaryKey.cs:13` — a `struct` wrapping a single `IComparable Object` (`:39`), plus a `string? VariableName` (`:38`) used by the synchronizer to emit `@variable` placeholders in generated SQL. The CLR type of the key per entity type lives in two **static dictionaries** filled at schema-build time:

```csharp
public static Dictionary<Type, Type> PrimaryKeyType = new();                  // :15
public static Dictionary<PropertyRoute, Type> MListPrimaryKeyType = new();     // :16
public static Type Type(Type entityType)                                       // :18
public static void SetType(Type entityType, Type primaryKeyType)               // :28
```

Implicit conversions from `int`/`long`/`Guid`/`DateTime` (and their nullables) and explicit conversions back (`:89-190`); full operator set `== != < <= > >=` (`:194-219`). Comparing two `PrimaryKey`s of different underlying types throws. `PrimaryKey.Parse(value, entityType)` / `TryParse` use `PrimaryKeyType` to know how to parse — **so parsing an id from a string requires the schema to have been built**, though not a DB connection.

Per-type PK type is declared with `[PrimaryKey(typeof(Guid))]` (`/Signum/Entities/FieldAttributes.cs:370`, a subclass of `DbTypeAttribute`), which also carries `Identity` vs `IdentityBehaviour` — the distinction matters because SQL Server implements GUID identity via `DEFAULT NEWSEQUENTIALID()` rather than `IDENTITY`.

### 1.4 `Lite<T>`

`Lite<T>` is an **interface**, not a class (`/Signum/Entities/Lite.cs:12`), purely so it can be declared `out T` covariant. The only implementation is `internal sealed class LiteImp<T, M>` (`/Signum/Entities/LiteImp.cs:8`), so `lite.GetType()` is `LiteImp<...>`, never `Lite<...>`.

Current members (`Lite.cs:12-105`) — note this is **much richer than `Lite.md`**:

```csharp
public interface Lite<out T> : IComparable, IComparable<Lite<Entity>> where T : class, IEntity
{
    T Entity { get; }            T? EntityOrNull { get; }
    PrimaryKey Id { get; }       PrimaryKey? IdOrNull { get; }
    int? PartitionId { get; }    bool IsNew { get; }
    Type EntityType { get; }
    Type ModelType { get; }      object? Model { get; }        // <-- new: "lite models"
    void ClearEntity();  void SetEntity(Entity ei);  void SetModel(object? model);
    PrimaryKey RefreshId();
    string Key();       // "TypeCleanName;Id"
    string KeyLong();   // "TypeCleanName;Id;ToString"
    Lite<T> Clone();
    M GetModel<M>() where M : ModelEntity;
}
```

The big evolution: a Lite no longer necessarily carries a `string` "toStr". It carries a **model** whose type is `ModelType` (`typeof(string)` by default). Custom models are registered at startup:

```csharp
Lite.RegisterLiteModelConstructor((AmericanMusicAwardEntity a) => new AwardLiteModel { ... });
// /Signum/Entities/Lite.cs:360-364 ; used at /Signum.Test/Environment/MusicStarter.cs:82
```

`ILiteModelConstructor` (`Lite.cs:108`) / `LiteModelConstructor<T,M>` (`Lite.cs:~135`) hold a `LambdaExpression` that the LINQ provider inlines, so the model is computed *in SQL* when a Lite is projected. `[LiteModel]` attribute (`FieldAttributes.cs:536`) pins a model type per field.

**Thin vs Fat**: thin = type + id + model; fat = also holds the real entity (`SetEntity`). Every `Lite` pointing at a *new* entity must be fat (no id to identify it by). `ToLite()` (`Lite.cs:259`) makes thin; `ToLiteFat()` (`Lite.cs:306`) makes fat; `ClearEntity()` goes back to thin; `Clone()` (`Lite.cs:~`) returns a defensive thin copy.

**String form — this is the key CLI affordance.** `Key()` = `"CleanTypeName;Id"`, `KeyLong()` = `"CleanTypeName;Id;ToString"`. Parsing:

```csharp
public static readonly Regex ParseRegex = new Regex(@"(?<type>[^;]+);(?<id>[\d\w-]+)(;(?<toStr>.+))?");  // Lite.cs:183
public static Lite<Entity> Parse(string liteKey)                     // Lite.cs:185
public static string? TryParseLite(string liteKey, out Lite<Entity>?) // Lite.cs:200
```

`TryParseLite` resolves the type via `TypeLogic.TryGetType(cleanName)` (`Lite.cs:208`) and the id via `PrimaryKey.TryParse` — i.e. **`Lite.Parse` requires `TypeLogic` to be loaded, which requires a DB** (see §7). It also supports a partition suffix `Id/PartitionId` (`Lite.cs:215-220`). `Lite.Create(type, id[, model][, partitionId])` builds one without parsing (`Lite.cs:240-256`).

**Comparison trap**: `animalLite == animal` compiles (both are reference types and a class could theoretically implement `Lite<T>`) but is always false. Use `.Is(...)`. `Signum.Analyzer` re-adds the compile error: `/Signum.Analyzer/Signum.Analyzer/LiteEqualityAnalyzer.cs`, `LiteCastAnalyzer.cs`.

### 1.5 Change tracking / `Modified`

```csharp
public abstract class Modifiable                       // Modifiable.cs:6
{
    [Ignore] ModifiedState modified;
    [HiddenProperty] public ModifiedState Modified {
        get => modified;
        protected internal set {
            if (modified == ModifiedState.Sealed && value != ModifiedState.Sealed)
                throw new InvalidOperationException("The instance {0} is sealed and can not be modified"...);
            modified = value; } }                       // :12-22
    public bool IsGraphModified => Modified is Modified or SelfModified;  // :33-36
    public virtual void SetSelfModified() => Modified = ModifiedState.SelfModified;  // :38
    protected internal virtual void PreSaving(PreSavingContext ctx) { }   // :43
    protected internal virtual void PostRetrieving(PostRetrievingContext ctx) { }  // :47
}
public enum ModifiedState { SelfModified, Clean, Modified, Sealed }        // :72-84
```

- `SelfModified` = this object changed. `Clean` / `Modified` (recursively clean / recursively modified) are **only meaningful during saving** — the doc comments say so explicitly (`Modifiable.cs:75-82`). The recursive states are computed by walking the object graph.
- `Sealed` = retrieved into a shared cache; any mutation throws. This is what `Symbol.SetId` does to symbol singletons (`/Signum/Basics/Symbol.cs:87-112`), so **symbol instances are immutable process-wide**.
- The graph walk lives in `/Signum/Entities/Reflection/GraphExplorer.cs` (`FromRoot`, `FromRootEntity`, `EntityIntegrityCheck`, `FullIntegrityCheck`, `SetValidationErrors`), driven from `Entity.EntityIntegrityCheck` (`Entity.cs:118-130`) and `ModifiableEntity.FullIntegrityCheck` (`ModifiableEntity.cs:423-427`).

`ModifiableEntity.Set<T>` (`ModifiableEntity.cs:42-102`) is the canonical property setter and does six things:

```csharp
protected virtual bool Set<T>(ref T field, T value, [CallerMemberName] string? automaticPropertyName = null)
{
    if (EqualityComparer<T>.Default.Equals(field, value)) return false;
    PropertyInfo? pi = GetPropertyInfo(automaticPropertyName!);                   // cached, :122-127
    if (value is IMListPrivate { IsNew: false } && !ReferenceEquals(value, field))
        throw new InvalidOperationException("Only MList<T> with IsNew = true can be assigned to an entity");
    /* detach [BindParent] child events from old value */
    SetSelfModified();
    field = value;
    /* attach [BindParent] child events to new value */
    NotifyPrivate(pi.Name); NotifyPrivate("Error"); NotifyToString();
    ClearTemporalError(pi.Name);
    return true;
}
```

**Doc drift:** `ChangeTracking.md:120` documents `[NotifyPropertyChanged]` / `[NotifyCollectionChanged]` attributes. The code uses a single `BindParentAttribute` (`/Signum/Entities/FieldNotificationAttributes.cs`), and the parent link is a real `parentEntity` field (`ModifiableEntity.cs:219`) rather than event subscriptions. That parent chain is also how `TryGetPropertyRoute()` reconstructs a `PropertyRoute` from a live object graph (`ModifiableEntity.cs:381-410`) — very useful and DB-free.

Note also `Entity.SetIfNew` (`Entity.cs:84-95`): a setter that throws if the entity is not new. Used for write-once fields.

### 1.6 `MList<T>` in memory

`MList<T> : Modifiable, IList<T>, IList, INotifyCollectionChanged, INotifyPropertyChanged, IMListPrivate<T>` (`/Signum/Entities/MList.cs:11`). The backing store is **not** `List<T>` but `List<RowIdElement>` (`MList.cs:102`):

```csharp
public struct RowIdElement : IEquatable<RowIdElement>, IComparable<RowIdElement>  // MList.cs:35
{
    public readonly PrimaryKey? RowId;   // null => new row, not yet inserted
    public readonly T Element;
    public readonly int? OldIndex;       // index it had in DB, to detect reordering
}
public bool IsNew => innerList.All(a => a.RowId == null);   // MList.cs:13-16
```

`RowIdElement.Equals` compares **only the element** (`MList.cs:55-65`) so `Contains`/`IndexOf`/`Remove` behave like a normal list, while `RowIdElementComparer` (`:18-33`) compares RowId+Element for the diffing logic. `IMListPrivate` / `IMListPrivate<T>` (`MList.cs:867`, `:884`) expose `InnerList`, `GetRowId`/`SetRowId`/`ForceRowId`, `SetOldIndex`, `AssignMList`, `IsEqualTo(newList, orderMatters)` (`:797-840`) — the RowId-based diff. `PostRetrieving` (`:680-690`) throws `"Duplicated RowId found, possible problem in LINQ provider"` and re-sorts by `OldIndex`.

Practical consequence documented at `/Signum/Entities/MList.md:85-97`: **re-assigning** an MList (`x.Telephones = ...ToMList()`) discards all RowIds and causes a full delete+insert; use `ResetRange(...)` to keep them.

`MListElement<E, V>` (`MList.cs:852-864`) is the *queryable* row projection: `PrimaryKey RowId`, `int RowOrder`, `int RowPartitionId`, `E Parent`, `V Element`. It only has meaning inside a query.

### 1.7 The attribute catalogue

**Type-level** (`/Signum/Entities/TypeAttributes.cs`):

| Attribute | Line | Effect |
|---|---|---|
| `[EntityKind(EntityKind, EntityData)]` | `:115` | mandatory on every `Entity` in the schema; see §1.8 |
| `[AutoInit]` | `:9` | on a **static class**: IL-weaves a `.cctor` that constructs every static symbol/operation field. Pure marker at runtime |
| `[InTypeScript(bool)]` | `:18` | include/exclude from generated TS |
| `[ImportInTypeScript(Type)]` | `:32` | assembly-level, for foreign enums (`DayOfWeek`) |
| `[CleanTypeName("X")]` | `:42` | override the clean name (default = class name minus `Entity`/`Embedded`/… suffix, `Reflector.CleanTypeName`, `/Signum/Entities/Reflection/Reflector.cs:86`) |
| `[DescriptionOptions(...)]` | `/Signum.Utilities/DescriptionManager.cs:13` | what gets localized |
| `[Mixin(typeof(X))]`, `[TableName]`, `[PrimaryKey]`, `[SystemVersioned]`, `[PartitionColumn]`, `[TicksColumn]`, `[ToStringColumn]` | `/Signum/Entities/FieldAttributes.cs:435,370,503,453,469,484` | schema shaping; several are valid on both types and MList fields |

**`[Serializable]` is gone.** The docs insist it is mandatory (`Introduction.md:116`, every example) — it is not used by current entities (see e.g. `Entity.cs`, `/Signum.Test/Environment/Entities.cs`). Serialization is JSON via `System.Text.Json` converters in `/Signum/API/Json/`. The only vestige is `ModifiableEntity.ICloneable.Clone()`, which still uses `BinaryFormatter` behind a `#pragma warning disable SYSLIB0011` (`ModifiableEntity.cs:444-455`) — effectively dead on modern .NET.

**Field-level** (`/Signum/Entities/FieldAttributes.cs`), with the renames that the docs miss:

| Attribute | Line | Notes |
|---|---|---|
| `[Ignore]` | `:248` | no column, excluded from save/retrieve/query |
| `[FieldWithoutProperty]` | `:253` | otherwise a field with no matching property throws at include time |
| `[AvoidSave]` | `:263` | written on INSERT, skipped on UPDATE |
| `[ForceNotNullable]` / `[ForceNullable]` | `:268`, `:278` | **replaces `NotNullableAttribute`/`NullableAttribute` from the docs** |
| `[DbType(...)]` | `:284` | **replaces `SqlDbTypeAttribute`**. Carries `SqlDbType`, `NpgsqlDbType`, `Size`, `Precision`, `Scale`, `Collation`, `UserDefinedTypeName`, `Default`. Base class of `[PrimaryKey]`, `[PartitionColumn]`, `[TicksColumn]`, `[ToStringColumn]` |
| `[ColumnName]`, `[BackReferenceColumnName]` | `:403`, `:414` | column renames; on an MList field `[ColumnName]` renames the *element* column and the table suffix |
| `[Index]` / `[UniqueIndex]` / `[AttachToUniqueIndexes]` | `:7`, `:12`, `:18` | **`[Index]` is new** — the docs claim Signum only manages unique indexes; it now manages plain ones too |
| `[ImplementedBy(params Type[])]` | `:221` | polymorphic FK: one nullable FK column per implementation, named `<field>_<CleanTypeName>` |
| `[ImplementedByAll]` | `:237` | `(TypeId FK→TypeEntity, id)` pair — one id column **per PK CLR type** in `Settings.ImplementedByAllPrimaryKeyTypes` |
| `[CombineStrategy(CombineStrategy.Case\|Union)]` | `:525` | how the LINQ provider recombines an IB dispatch |
| `[AvoidForeignKey]`, `[AvoidExpandQuery]` | `:512`, `:518` | drop the FK constraint; stop eager join expansion (needed for cycles) |
| `[PreserveOrder]` | (MList) | adds an `Order` column; sorting the MList then marks it modified |
| `[LiteModel(typeof(M))]` | `:536` | model type for `Lite<T>` fields |
| `[AutoExpandSubTokens]` | `:548` | DynamicQuery: auto-expand this route's sub-tokens in the UI |
| `[AssemblySchemaName]` | `:23` | assembly-level → DB schema per assembly |
| `[ViewPrimaryKey]`, `[CacheViewMetadata]` | `:425`, `:430` | for `IView` mapping onto existing views |

**Property-level**: `[Format]`, `[Unit]`, `[HiddenProperty]`, `[QueryableProperty]`, `[TimeSpanDateFormat]` (`/Signum/Entities/PropertyAttributes.cs`, `/Signum.Utilities/DescriptionManager.cs:93`). `[QueryableProperty]` matters a lot: it forces a computed/`[Ignore]`d property to appear as a query token — that is exactly how VirtualMList works (`/Signum/Entities/MList.md:158`).

Validation attributes are a separate large family in `/Signum/Entities/Validation/ValidationAttributes.cs` (44 KB) — `StringLengthValidator`, `NotNullValidator`, `NumberIsValidator`, … They also **feed the schema**: `SchemaSettings` infers column `Size`/`Scale` from `StringLengthValidator`/`DecimalsValidator` (`/Signum/Engine/Schema/SchemaBuilder/SchemaSettings.cs:358-425`). So a validator attribute silently changes your DDL.

### 1.8 `EntityKind` / `EntityData` — why it matters

`/Signum/Entities/TypeAttributes.cs:162-237`. `EntityKind` classifies the *role*: `SystemString, System, Relational, String, Shared, Main, Part, SharedPart`. `EntityData` classifies the *lifecycle*: `Master` (business definition, default order id ASC, cacheable) vs `Transactional` (created while running, default order id DESC, not cacheable).

The one piece with hard runtime teeth is `RequiresSaveOperation`:

```csharp
public static bool CalculateRequiresSaveOperation(EntityKind entityKind) => entityKind switch  // :138-152
{
    SystemString => false, System => false, Relational => true, String => true,
    Shared => true, Main => true, Part => false, SharedPart => false, ...
};
```

`OperationLogic` installs a global `Saving` hook that **throws** if you call `.Save()` on a `RequiresSaveOperation` type outside an operation or an `OperationLogic.AllowSave<T>()` scope (`/Signum/Operations/OperationLogic.cs:295-304`, hook registered at `:118`). And at `SchemaCompleted` it validates that every such type actually *has* a save-like operation registered (`OperationLogic.cs:241-269`), throwing with a "Consider … `sb.Include<T>().WithSave(..)`" message. So `EntityKind` is not merely UI advice: **it is a compile-time-ish contract enforced at startup.**

`EntityKindCache` (`TypeAttributes.cs:51-112`) is a `ConcurrentDictionary` cache with an `Override(type, attr)` escape hatch; `TryGetAttribute` throws if the type isn't an `IEntity`. `IsLowPopulation` (`:120`) drives EntityCombo-vs-EntityLine in the UI. `SerializeTemporalId` (`:123`) is a newer flag for the React `EntityAssigner`.

The UI-default matrix (IsCreable/IsViewable/IsNavigable/IsReadOnly per kind) is in `/Signum/Entities/EntityKindAttribute.md:37-46` and is honoured by the React client, not by this assembly.

### 1.9 `EnumEntity<T>` and Symbols

A plain C# `enum` field generates a **real table** whose PK equals the enum's numeric value and whose `ToStr` is the identifier; `EnumEntity<T>` (`/Signum/Entities/EnumEntity.cs`) is the bridge entity. The schema builder does `Include(EnumEntity.Generate(cleanEnum))` for you (`/Signum/Engine/Schema/SchemaBuilder/SchemaBuilder.cs:828`). The synchronizer emits INSERT/DELETE/UPDATE for enum rows and, because re-ordering an enum changes a PK, it will rewrite dependent FKs (`/Signum/Engine/Sync/SchemaSynchronizer.cs:1150-1158`). `[Flags]` enums get no FK unless `[ForceForeignKey]`.

Symbols are the run-time-extensible alternative — covered in §4.2.

---

## 2. Schema & ORM

### 2.1 `SchemaBuilder.Include<T>()` → `Table` → `Field` → `IColumn`

Entry point: `SchemaBuilder.Include<T>()` returns a `FluentInclude<T>`; the real work is `Include(Type, PropertyRoute?)` at `/Signum/Engine/Schema/SchemaBuilder/SchemaBuilder.cs:322-376`. It is idempotent (`schema.Tables.TryGetValue` first, `:335`), refuses abstract/non-`Entity` types (`:343-347`), refuses anything after `OnSchemaCompleted()` (`:338-339`, `"Schema already completed"`), computes the clean name via `Reflector.CleanTypeName` with a `SchemaSettings.Desambiguate` override hook (`:349`), registers `NameToType`/`TypeToName` (`:361-363`), and **rolls back the partial registration if `Complete` throws** (`:368-374`).

`Complete(Table)` — `SchemaBuilder.cs:383-405` — is the whole per-table pipeline:

```csharp
table.IdentityBehaviour = GetPrimaryKeyAttribute(type).IdentityBehaviour;
table.Name          = GenerateTableName(type, Settings.TypeAttribute<TableNameAttribute>(type));
table.CleanTypeName = GenerateCleanTypeName(type);
table.Fields        = GenerateFields(PropertyRoute.Root(type), table, NameSequence.GetVoid(IsPostgres),
                                     forceNull: false, inMList: false);
table.Mixins        = GenerateMixins(PropertyRoute.Root(type), table, NameSequence.GetVoid(IsPostgres));
table.SystemVersioned  = ToSystemVersionedInfo(Settings.TypeAttribute<SystemVersionedAttribute>(type), table.Name);
table.PartitionScheme  = ToPartitionScheme(Settings.TypeAttribute<PartitionColumnAttribute>(type));
table.GenerateColumns();
```

`GenerateFields` (`SchemaBuilder.cs:470-561`) synthesizes the framework fields first — `id`, `ticks` (unless `[TicksColumn(HasTicks=false)]`), `ToStr` (**skipped when the entity's `ToString` is an expression**, `:497`), `partitionId` (only with `[PartitionColumn]`) — then iterates `Reflector.InstanceFieldsInOrder(type)` skipping `[Ignore]`d routes (`:526`).

Field-kind dispatch (`SchemaBuilder.cs:568-621`, `KindOfField` enum `:623-634`, classification `:636-672`):

```csharp
switch (kof) {
  case KindOfField.PrimaryKey:  return GenerateFieldPrimaryKey((Table)table, route, name);
  case KindOfField.Ticks:       return GenerateFieldTicks(...);
  case KindOfField.PartitionId: return GenerateFieldPartition(...);
  case KindOfField.ToStr:       return GenerateFieldToString(...);
  case KindOfField.Value:       return GenerateFieldValue(table, route, name, forceNull);
  case KindOfField.Reference: {
      Implementations at = Settings.GetImplementations(route);
      if (at.IsByAll)                                    return GenerateFieldImplementedByAll(...);
      else if (at.Types.Only() == route.Type.CleanType()) return GenerateFieldReference(...);
      else                                               return GenerateFieldImplementedBy(..., at.Types);
  }
  case KindOfField.Enum:        return GenerateFieldEnum(...);
  case KindOfField.Embedded:    return GenerateFieldEmbedded(..., inMList);
  case KindOfField.MList:       return GenerateFieldMList((Table)table, route, name);
```

`Field` subclasses and the columns they produce — all in `/Signum/Engine/Schema/Schema.Basics.cs`, base contract `public abstract IEnumerable<IColumn> Columns();` at `:440`:

| Field class | Line | Columns |
|---|---|---|
| `FieldPrimaryKey : Field, IColumn` | `:597-662` | itself. With a partition scheme the PK index is split into non-clustered PK + separate clustered partitioned index (`:638-651`) |
| `FieldValue : Field, IColumn` | `:664-717` | itself |
| `FieldTicks : FieldValue` | `:719-728` | itself |
| `FieldPartitionId : FieldValue` | `:730-739` | itself |
| `FieldEmbedded : Field, IFieldFinder` | `:741-917` | optional `EmbeddedHasValueColumn` (bit/boolean) + nested `EmbeddedFields` dict + nested `Mixins` (`:853-866`) |
| `FieldMixin : Field, IFieldFinder` | `:919-1013` | flattened columns of its `Fields` (`:974-980`); `GenerateIndexes` throws (`:982`) |
| `FieldReference : Field, IColumn, IFieldReference` | `:1015-1103` | itself; DbType/Size/Collation **delegated to `ReferenceTable.PrimaryKey`** (`:1023-1031`); auto non-unique index (`:1075-1081`) |
| `FieldEnum : FieldReference` | `:1105-1150` | itself; FK → generated `EnumEntity<T>` table |
| `FieldImplementedBy` | `:1152-1211` | one `ImplementationColumn` (`:1283-1320`) per implementation, named `<field>_<CleanTypeName>` (`SchemaBuilder.cs:895`); forced nullable when >1 impl (`:882-883`) |
| `FieldImplementedByAll` | `:1213-1281` | one `ImplementedByAllIdColumn` **per entry in `Settings.ImplementedByAllPrimaryKeyTypes`** + one `ImplementedByAllTypeColumn` FK→`TypeEntity` (`:1231-1239`); composite `(TypeColumn, idCol)` indexes (`:1267-1275`) |
| `FieldMList` | `:1366-1432` | **none** (`Array.Empty<IColumn>()`, `:1405-1408`); owns a `TableMList` |

`Table` (`Schema.Basics.cs:172-192`):

```csharp
public partial class Table : IFieldFinder, ITable, ITablePrivate
{
    public Type Type { get; private set; }          public Schema Schema { get; private set; }
    public ObjectName Name { get; set; }            public bool IdentityBehaviour { get; internal set; }
    public bool IsView { get; internal set; }       public string CleanTypeName { get; set; }
    public SystemVersionedInfo? SystemVersioned { get; set; }
    public Dictionary<string, EntityField> Fields { get; set; }
    public Dictionary<Type, FieldMixin>? Mixins { get; set; }
    public Dictionary<string, IColumn> Columns { get; set; }
    public List<TableIndex>? AdditionalIndexes { get; set; }
```

`GenerateColumns()` (`:205-235`) flattens fields → mixins → system-versioned period columns and **resets four compiled save caches** (`inserterIdentity`, `inserterDisableIdentity`, `updater`, `saveCollections`, `:231-234`).

`IColumn` — note it is a `partial interface`, extended by the LINQ layer (`Schema.Basics.cs:526-546`):

```csharp
public partial interface IColumn
{
    string Name { get; }        IsNullable Nullable { get; }     AbstractDbType DbType { get; }
    DateTimeKind DateTimeKind { get; }  Type Type { get; }       string? UserDefinedTypeName { get; }
    bool PrimaryKey { get; }    bool IdentityBehaviour { get; }  bool Identity { get; }
    string? Default { get; }    ComputedColumn? ComputedColumn { get; }   string? Check { get; }
    int? Size { get; }  byte? Precision { get; }  byte? Scale { get; }  string? Collation { get; }
    Table? ReferenceTable { get; }   bool AvoidForeignKey { get; }
}
```

`IsNullable` has **three** states — `No`, `Yes`, `Forced` ("nullable only because inside a nullable Embedded", `:560-566`). `Forced` is what drives the synchronizer's "add column with default, then `UPDATE ... WHERE HasValue = 1`" path (`/Signum/Engine/Sync/SchemaSynchronizer.cs:871-899`).

`TableMList` (`Schema.Basics.cs:1434-1635`) is the second `ITable`: `PrimaryKeyColumn` (always identity, `:1445`), `BackReference` (a `FieldReference` named `ParentID`, `SchemaBuilder.cs:1005-1011`), optional `Order` (`[PreserveOrder]`), optional `PartitionId`, and `Field` (the element, itself possibly `FieldEmbedded`/`FieldImplementedBy`). MList tables inherit `SystemVersioned`/`PartitionScheme` from the parent (`SchemaBuilder.cs:1020-1047`).

Type mapping: `SchemaSettings.TypeValues` (`/Signum/Engine/Schema/SchemaBuilder/SchemaSettings.cs:53-78`) → `AbstractDbType` (`Schema.Basics.cs:1637-1935`), a struct holding **both** a nullable `SqlDbType` and a nullable `NpgsqlDbType`; `Equals` compares only the side selected by `Schema.Current.Settings.IsPostgres` (`:1666-1671`).

Name generation: `NameSequence` accumulation + `Idiomatic()` (PascalToSnake on Postgres) + `FixNameLength` → `StringHashEncoder.ChopHash(name, Connector.Current.MaxNameLength, isPostgres)` (`SchemaBuilder.cs:919-922`); reference/enum fields get an `"ID"` suffix (`GenerateFieldName`, `:1167-1188`).

### 2.2 `Schema` internals

`/Signum/Engine/Schema/Schema.cs`.

**There is no static schema field.** `Schema.Current => Connector.Current.Schema` (`:701-704`). Everything that touches metadata therefore transitively needs a `Connector` *object* to exist (not necessarily a live connection — see §7).

- `Dictionary<Type, Table> Tables` (`:75-79`); `Table(Type)` throws with a `"Consider sb.Include<{0}>()"` hint (`:721-724`).
- `GetDatabaseTables()` (`:893-902`) yields entity tables **and** their MList tables — the canonical enumeration used by both generator and synchronizer. `DatabaseNames()` (`:904-909`).
- `Settings` = `SchemaSettings` (`:69`), constructed by `SchemaBuilder` (`SchemaBuilder.cs:27`). **`IsPostgres` is set as a side effect of constructing the connector**: `base(schema.Do(s => s.Settings.IsPostgres = true))` (`/Signum/Engine/Connection/PostgreSqlConnector.cs:74`).
- `Version` throws `"Schema.Version is not set"` if unset (`:36-47`).
- Naming: `ObjectName`/`SchemaName`/`DatabaseName`/`ServerName` in `/Signum/Engine/Schema/ObjectName.cs:22, 68, 123, 203`. Dialect-aware escaping (`:237-242`); Postgres names >63 chars throw at construction (`:216-217`); `SchemaName.Default(isPostgres)` = `dbo` vs `public` (`:144`). `ObjectName.OverrideOptions` (`:326`) supports an ambient database-name replacement, used by `Schema.GenerationScipt(databaseNameReplacement)`.
- **Lifecycle events** (all multicast, all self-nulling after firing):
  - `SchemaCompleted` → `OnSchemaCompleted()` (`:559-573`), sets `IsCompleted`.
  - `WhenIncluded<T>(action)` (`:575-582`) defers work until completion.
  - `BeforeDatabaseAccess` → `OnBeforeDatabaseAccess()` (`:610-625`) — **asserts `IsCompleted`**, so forgetting `OnSchemaCompleted()` fails loudly on first DB touch.
  - `Initializing` → `Initialize()` (`:629-646`) — loads all `GlobalLazy`s.
  - `Generating` / `Synchronizing` pipelines are just multicast delegates wired in the ctor (`:668-699`).
  - `OnInvalidateCache` (`:627`, wired to `GlobalLazy.ResetAll` at `:695`); `OnMetadataInvalidated`/`InvalidateMetadata()` (`:49-53`, fired by `Administrator.Synchronize`, `/Signum/Engine/Administrator.cs:185`).
- **Per-entity events**: `EntityEventsGlobal` and `EntityEvents<T>()` over `Dictionary<Type, IEntityEvents>` (`:119-130`); the `OnPreSaving/OnSaving/OnSaved/OnRetrieved/OnPreUnsafe*/OnPreBulkInsert` fan-outs (`:133-256`) each call `AssertAllowed(type, inUserInterface: false)` — **authorization is enforced at the schema layer, not by callers.** `EntityEvents<T>` itself: `/Signum/Engine/Schema/EntityEvents.cs:8-61`, plus `RegisterBinding` (`:46-61`) for computed/"additional" query fields consumed by `Schema.GetAdditionalQueryBindings` (`Schema.cs:268-303`).
- **Row-level security**: `FilterQuery` → `OnFilterQuery`/`GetInMemoryFilter`/`GetInDatabaseFilter`, AND-combined (`:315-417`).
- `CheckImplementedByAllPrimaryKeyTypes()` (`:584-608`) validates `Settings.ImplementedByAllPrimaryKeyTypes` and prints copy-pasteable fix lines; auto-registered on `SchemaCompleted` (`:697`).
- **Doc drift:** `Schema.md` still references `SqlConnector`, `SchemaBuilderSettings`, `ConnectionScope`, and claims SQL Server has no sharding support — the code now has partition functions/schemes.

### 2.3 Generation and synchronization SQL

**From scratch:** `Administrator.TotalGenerationScript()` → `Schema.Current.GenerationScipt()` (`/Signum/Engine/Administrator.cs:118-121`; `Schema.cs:525-544`, run under `ExecutionMode.Global()`). Pipeline order (`Schema.cs:675-684`): SnapshotIsolation → Postgres extensions → default text-search language → partition functions/schemes → assets-before-tables → `CreateSchemasScript` → `CreateTablesScript` → `InsertEnumValuesScript` → `TypeLogic.Schema_Generating` → assets. `SchemaGenerator.CreateTablesScript` (`/Signum/Engine/Sync/SchemaGenerator.cs:46-105`) emits tables → FKs → full-text catalogs → indexes, each `.PlainSqlCommand()`-ed with `GoAfter = true`. `Administrator.TotalGeneration` (`:23-56`) first `CleanAllDatabases`, then executes with a 5-minute timeout, splitting `ExtractNoTransaction()` before/after the transaction.

**Synchronization:** `Administrator.TotalSynchronizeScript(out Replacements, interactive, schemaOnly)` (`Administrator.cs:191-205`) wraps `Schema.SynchronizationScript` between a header, `SqlBuilder.UseDatabase()` and a footer. `Schema.SynchronizationScript` (`Schema.cs:419-468`) invokes each `Synchronizing` handler individually, printing OK/Changes/Error per handler and **turning a handler exception into a SQL comment** rather than failing the whole run (`:454-460`).

The core is `SchemaSynchronizer.SynchronizeTablesScript` (`/Signum/Engine/Sync/SchemaSynchronizer.cs:15-770`):

1. **Model side**: `modelTables` = `s.GetDatabaseTables()` keyed by `Name.ToString()` (`:23`); `modelTablesHistory` by `SystemVersioned.TableName` (`:27`); `modelIndices` = `t.AllIndexes()` keyed by `IndexName` (`:80-81`); model schemas / partition schemes / full-text catalogs (`:31-32`, `:83-86`).
2. **DB side** — and this is the neat bootstrap trick: the existing database is read **through Signum's own LINQ provider over `IView` classes**. SQL Server: `SysTablesSchema.GetDatabaseDescription(...)` querying `SysTables/SysColumns/SysTypes/SysIndexes/SysForeignKeys/…` (`/Signum/Engine/Sync/SqlServer/SysTablesSchema.cs:8-220`, with `Administrator.OverrideDatabaseInSysViews(db)` per database at `:18`). Postgres: `PostgresCatalogSchema.GetDatabaseDescription(...)` over `PgClass/PgNamespace/PgAttribute/PgIndex/PgOpClass/…` (`/Signum/Engine/Sync/Postgres/PostgresCatalogSchema.cs:10-166`).
3. **Renames are asked interactively**, at every level, via `Replacements.AskForReplacements(oldKeys, newKeys, key)`: tables (`:72-78`), per-table columns (`Replacements.KeyColumnsForTable(tn)`, `:102-108`), schemas (`:196-210`), enum rows (`KeyEnumsForTable`, `:1154-1158`). The matching algorithm is a **weighted Levenshtein distance matrix (substitutions cost 2)** offering the closest candidates repeatedly (`/Signum/Engine/Sync/Synchronizer.cs:277-343`), with a console UI accepting `n` / `n!` / `+` / index (`SelectInteractive`, `:387-488`) and hooks `AutoReplacement`, `GlobalAutoReplacement`, `ResponseRecorder`. **Non-interactive mode throws instead of guessing** (`:402-403`). `ApplyReplacementsToOld` then re-keys the DB dictionary into model naming (`:257-265`), and `KeyTablesInverse` lets `Administrator.TryRetrieveAll` read data under the *old* table name (`Synchronizer.UseOldTableName`, `:206-221`; `Administrator.cs:345-362`).
4. Incompatible column type changes get **pre-renamed to `<name>_old`** so the new column can be added alongside and data migrated (`:110-117`, `preRenameColumns` `:154-159`), with `UpdateCustom` emitting a deliberately non-compiling `YourCode(...)` placeholder for the developer to fill in (`:805-808`).
5. Everything is expressed through the three-way `Synchronizer.SynchronizeScript(spacing, newDict, oldDict, createNew, removeOld, mergeBoth)` (`/Signum/Engine/Sync/Synchronizer.cs:151-181`) — the canonical pattern, reapplied at every level.
6. Output ordering is explicit and dependency-aware (`SchemaSynchronizer.cs:740-768`): preRenameColumns → catalogs/partition objects/schemas → drop statistics → drop indexes → drop FKs → history fixes → tables → versioning triggers → delayed PK/FK updates → delayed drops → re-enable versioning → enum rows → add FKs → add indexes → drops. `GoBefore`/`GoAfter` nudge batch separators.
7. Signum only claims ownership of indexes whose names start with `IX_`/`UIX_`/`CIX_` (`/Signum/Engine/Sync/DiffModels.cs:307-313`) — anything else prompts "Recreate non-controlled index?" (`:676`).

`SqlPreCommand` (`/Signum/Engine/Sync/SqlPreCommand.cs:19-62`) is an abstract tree: `SqlPreCommandSimple` (`:450`, sql + `List<DbParameter>`), `SqlPreCommandConcat` (`:655`, with `Spacing`), plus `SqlPreCommandPostgresDoBlock` (`:774`) and `SqlPreCommand_WithHistory` (`:869`) whose `Leaves()`/`PlainSql()` **throw** (`:889`, `:893`) — it is a marker that must be resolved by `ForNormal`/`ForHistory` (`:895-921`). `ExtractNoTransaction()` (`:722`) pulls out statements that cannot run inside a transaction. `PlainSql()` (`:34-45`) inlines parameters and is injection-prone by design (the `.md` warns).

### 2.4 Backends: `Connector`, SQL Server, PostgreSQL

Exactly **two** backends: SQL Server (`Microsoft.Data.SqlClient`) and PostgreSQL (`Npgsql`).

`Connector` (`/Signum/Engine/Connection/Connector.cs:12-165`) — ambient via a **thread** variable: `Connector.Current => currentConnector.Value ?? Default` (`:27-32`), scoped override `Connector.Override` (`:18-25`), `CommandTimeoutScope` (`:36-41`). Abstract surface:

```csharp
public abstract string GetSqlDbType(DbParameter p);
protected internal abstract object? ExecuteScalar(SqlPreCommandSimple, CommandType);
protected internal abstract int ExecuteNonQuery(SqlPreCommandSimple, CommandType);
protected internal abstract DataTable ExecuteDataTable(...);
protected internal abstract DbDataReaderWithCommand UnsafeExecuteDataReader(...);
protected internal abstract Task<DbDataReaderWithCommand> UnsafeExecuteDataReaderAsync(..., CancellationToken);
protected internal abstract void BulkCopy(DataTable, List<IColumn>, ObjectName, SqlBulkCopyOptions, int? timeout);
public abstract Connector ForDatabase(DatabaseName? database);
public abstract string OriginalDatabaseName();  DatabaseName();  DataSourceName();
public abstract int MaxNameLength { get; }
public abstract void SaveTransactionPoint(DbTransaction, string savePointName);
public abstract void RollbackTransactionPoint(DbTransaction, string savePointName);
public abstract DbConnection CreateConnection();
public abstract ParameterBuilder ParameterBuilder { get; protected set; }
public abstract void CleanDatabase(DatabaseName?);   public abstract bool HasTables();
```

plus a **capability block** (`:138-164`) that is how dialect differences are abstracted: `AllowsMultipleQueries`, `SupportsScalarSubquery(InAggregates)`, `AllowsSetSnapshotIsolation`, `AllowsIndexWithWhere(where)`, `AllowsConvertToDate/Time`, `SupportsStringAggr`, `SupportsSqlDependency`, `SupportsFormat`, `SupportsTemporalTables`, `RequiresRetry`, `SupportsDateDifBig`, `SupportsPartitioning`, `SupportsVectors`, `LocalTimeZone`.

`SqlServerConnector` (`/Signum/Engine/Connection/SqlServerConnector.cs:92-118`): `SqlServerVersion` enum incl. `AzureSQL` (`:14`), detected by `SqlServerVersionDetector.Detect(connectionString, fallback)` (`:29-90`, `SERVERPROPERTY`/`@@VERSION`, swallows failures and returns the fallback). Version gates: snapshot isolation ≥2008 (`:512`), filtered indexes >2005 (`:514`), retry on AzureSQL (`:516`), `DATEDIFF_BIG` ≥2016 (`:518`), `CONVERT ... date/time` ≥2008 (`:542-544`), `STRING_AGG` ≥2017 (`:546`), `FORMAT` ≥2012 (`:550`), temporal tables ≥2016 (`:552`), `DATE_TRUNC` ≥2022 (`:554`), partitioning always (`:556`), vectors ≥2025 (`:558`), `MaxNameLength => 128` (`:560`).

`PostgreSqlConnector` (`/Signum/Engine/Connection/PostgreSqlConnector.cs:45-107`): `Version? PostgresVersion` (a plain `System.Version`, from `SHOW server_version`, `:15-43`), `MaxNameLength => 63` (`:102`). Key differences: `AllowsMultipleQueries => true` (`:112`), `SupportsScalarSubqueryInAggregates => true` (`:112`, vs `false` on SQL Server `:125`), `AllowsSetSnapshotIsolation => false` (`:114`), `SupportsSqlDependency => false` (`:122`), **`SupportsPartitioning => false //for now`** (`:132`), `AllowsIndexWithWhere => true` unconditionally (`:134`), `SupportsVectors` = a lazy `pg_available_extensions` probe (`:50-62`), and **`ForDatabase` throws `NotImplementedException` (`:136-142`) — cross-database queries are SQL-Server-only.** It builds an `NpgsqlDataSource` via `NpgsqlSlimDataSourceBuilder` with a caller-supplied customizer (`EnableArrays/EnableLTree/EnableRanges/UseVector`, see `/Signum.Test/Environment/MusicStarter.cs:67-73`) and exposes `ReloadTypes()` (`:446-452`), needed after generation creates extensions/enum types.

`Executor` (`/Signum/Engine/Connection/Executor.cs`) is a thin static/extension facade over `Connector.Current`, plus `ExecuteLeaves` (`:62-68`) which runs each `SqlPreCommandSimple` leaf independently.

`Transaction` (`/Signum/Engine/Connection/Transaction.cs`) is ambient and keyed **per `Connector`** in a thread dictionary (`:415-427`), with five `ICoreTransaction` implementations: `RealTransaction` (`:109`, owns the connection, lazily started), `FakedTransaction` (nested no-op forwarding events), `NamedTransaction` (`:212`, real savepoints), `NoneTransaction` (`:288`, escapes the ambient transaction with its own connection), `TestTransaction` (`:389`). Factories: `new Transaction()` (`:408-413`), `None()` (`:429`), `NamedSavePoint(name)` (`:434`), `ForceNew()` (`:448-460` — **degrades to Faked when `InTestTransaction`**, so tests stay rollback-able), `Test()` (`:462`). `Commit()` must be called explicitly (`:553`). `NamedTransaction.CallPostRealCommit` re-registers handlers onto the parent (`:269-271`) so "post commit" always means the outermost real commit.

`FieldReader` (`/Signum/Engine/Connection/FieldReader.cs:14-64`) caches a `TypeCode[]` per ordinal with private pseudo-codes for `Guid/TimeSpan/TimeOnly/DateTimeOffset/DateOnly` (`:18-23`), records `LastOrdinal`/`LastMethodName` for diagnostics (`:26-27`), captures `isPostgres` at construction (`:57`), and offers typed getters incl. `GetUdt<T>`, `GetArray<T>`, `GetVector`, `GetRange<T>` (`:593-686`). `FieldReader.GetExpression(...)` (`:692-739`) is what the LINQ provider emits, and is where `DateTimeKind` chooses `GetDateTimeUtc` vs `GetDateTimeLocal` (`:700-704`).

### 2.5 Surprising things in the ORM layer

- **Temporal tables are emulated on Postgres.** `SystemVersionedInfo` (`Schema.Basics.cs:41-165`) has two shapes: SQL Server `Start`/`End` `DATETIME2` columns (`SqlServerPeriodColumn`, `:92`) vs a single `tstzrange` column (`PostgresPeriodColumn`, `:131`). On Postgres history is maintained by a shipped PL/pgSQL trigger function — `/Signum/Engine/Sync/Postgres/versioning_function.sql` and `versioning_function_nochecks.sql`, selected by `SchemaSettings.PostresVersioningFunctionNoChecks` (`SchemaSettings.cs:19`); the synchronizer creates/replaces/drops those triggers (`SchemaSynchronizer.cs:589-617`, comparing the target table encoded in `tgargs`).
- **Full-text search has two entirely different implementations.** SQL Server: a catalog plus a single pseudo-index literally named `"FULL_TEXT_INDEX"` (`/Signum/Engine/Schema/TableIndexes.cs:135, 168-171`; `DiffModels.cs:56-66`). Postgres: a **persisted computed `tsvector` column** built from `setweight(to_tsvector(...))` with A/B/C/D weights (`TableIndexes.cs:180-196`, `PostgresTsVectorColumn` `:208-244`) — meaning `AddFullTextIndex` *mutates* `table.Columns` after the table was built (`SchemaBuilder.cs:218-230`). Same trick for `AddVectorIndex` (`:268-281`).
- **Vector/embedding columns**: `AbstractDbType.VectorPG = (NpgsqlDbType)0x10000000` is a hand-rolled enum value because "NpgsqlDbType.Vector is not yet in the stable release" (`Schema.Basics.cs:1725`). Vector columns must declare a `Size` or schema build throws (`SchemaBuilder.cs:816-817`).
- **VirtualMList is not a schema construct at all** (`/Signum/Engine/Patterns/VirtualMList.cs:50-270`): the property must be `[Ignore, QueryableProperty]` (`:86-88`) so no `TableMList` exists; the collection is reconstituted via `EntityEvents<T>.Retrieved` (`:120-137`) and `RegisterBinding` (`:143-155`), and persisted through `PreSaving`/`Saving` hooks that save/delete the child entities via operations.
- **Bulk insert bypasses the save pipeline**: `BulkInserter.BulkInsertTable<T>` (`/Signum/Engine/BulkInserter.cs:117-185`) fills a `DataTable` and calls `SqlBulkCopy` on SQL Server (`SqlServerConnector.cs:411`) vs `COPY ... FROM STDIN (FORMAT BINARY)` on Postgres (`PostgreSqlConnector.cs:233-278`).
- **Normal saves use compiled-expression caches keyed by batch size** (`/Signum/Engine/Schema/Schema.Save.cs:110-190, 229, 388, 642`) and batch statements up to `min(MaxNumberOfStatementsInSaveQueries, MaxNumberOfParameters / paramsPerRow)` (defaults 16 / 2000, `SchemaSettings.cs:25-26`; `SaveUtils.SplitStatements`, `Schema.Save.cs:1471-1505`), degrading to one statement at a time when `!Connector.AllowsMultipleQueries`.
- **Views are first-class but ephemeral**: `Schema.View(Type)` rebuilds a throwaway `Table` on every call unless `[CacheViewMetadata]` (`Schema.cs:513-522`); `ViewBuilder` (`SchemaBuilder.cs:1313-1415`) reuses the field generators but does not include enum tables (`:1394-1413`). `Administrator.GenerateViewCode` reverse-engineers C# `IView` classes from `sys.tables` (`Administrator.cs:73-116`).
- `Schema.ExecuteAs` issues `SET ROLE` (Postgres) vs `EXECUTE AS LOGIN` (SQL Server) and drives owner-change scripts during sync (`Schema.cs:547-557`; `SchemaSynchronizer.cs:206-209, 369-370`).
- **Doc drift**: `EntityEvents.md:44` documents `PreSavingEventHandler<T>(T ident, ref bool graphModified)`; the code is `(T ident, PreSavingContext ctx)` (`EntityEvents.cs:305`).

---

## 3. The LINQ provider

### 3.1 `Database.Query<T>()`

```csharp
[DebuggerStepThrough]
public static IQueryable<T> Query<T>() where T : Entity        // /Signum/Engine/Database.cs:1227-1231
{
    return new SignumTable<T>(DbQueryProvider.Single, Schema.Current.Table<T>());
}
```

- `SignumTable<E>` (`/Signum/Engine/Database.cs:1819-1842`) subclasses `Query<E>` and implements `IQuerySignumTable` (`:1812-1817`) exposing `ITable Table`, `bool DisableAssertAllowed`, `SystemTime? SystemTime`. Its `Equals`/`GetHashCode` delegate to `Table`, so two `Database.Query<T>()` calls are structurally equal expressions.
- `Query<T>` (`/Signum.Utilities/ExpressionTrees/Query.cs:9-81`) sets `expression = Expression.Constant(this)` (`:17`). **The root of every LINQ tree is a `ConstantExpression` whose value is the `SignumTable<T>`** — that is how the binder recovers the `ITable` and any `SystemTime`.
- `QueryProvider.CreateQuery<S>` returns a plain `Query<S>`, not a `SignumTable<S>` (`/Signum.Utilities/ExpressionTrees/QueryProvider.cs:16`), so only the leaf constant carries schema info.
- The provider is a **stateless singleton**: `DbQueryProvider.Single` (`/Signum/Engine/Linq/DbQueryProvider.cs:12`), private ctor, implements `IQueryProviderAsync` (`:34`).

### 3.2 The translation pipeline

`DbQueryProvider.Translate<R>` (`/Signum/Engine/Linq/DbQueryProvider.cs:45-67`):

```csharp
AliasGenerator aliasGenerator = new AliasGenerator();
using (HeavyProfiler.Log("LINQ", () => expression.ToString()))
using (var log = HeavyProfiler.LogNoStackTrace("Clean"))
using (ExpressionMetadataStore.Scope())
{
    Expression cleaned = Clean(expression, true, log)!;
    var binder = new QueryBinder(aliasGenerator);
    log.Switch("Bind");
    ProjectionExpression binded    = (ProjectionExpression)binder.BindQuery(cleaned);
    ProjectionExpression optimized = (ProjectionExpression)Optimize(binded, binder, aliasGenerator, log);
    log.Switch("ChPrjFlatt");
    ProjectionExpression flat      = ChildProjectionFlattener.Flatten(optimized, aliasGenerator);
    log.Switch("TB");
    result = TranslatorBuilder.Build(flat);
}
return continuation(result);
```

Stage by stage:

| # | Stage | Location |
|---|---|---|
| 0 | `ExpressionMetadataStore.Scope()` — thread-static `ConditionalWeakTable<Expression, ExpressionMetadata>` for out-of-band per-node metadata (`DateTimeKind`) | `/Signum/Engine/Linq/ExpressionMetadataStore.cs:5-45` |
| 1 | `ExpressionCleaner.Clean` — expands `[ExpressionField]` / `[MethodExpander]` / `Evaluate`, partial-evaluates constants, short-circuits `&&`/`??`/`?:` | `/Signum.Utilities/ExpressionTrees/ExpressionCleaner.cs:25-37`, called `DbQueryProvider.cs:71` |
| 2 | `OverloadingSimplifier.Simplify` — `MinBy`→`OrderBy+First`, `GroupJoin`, `Where(a,i)`, `ElementAt`, `DefaultIfEmpty`, `Count()`… | `/Signum/Engine/Linq/ExpressionVisitor/OverloadingSimplifier.cs:10-60`, called `:73` |
| 3 | `QueryFilterer.Filter` — injects the schema row filter (`Schema.GetInDatabaseFilter<T>`) as a `.Where(...)` around every base `IQueryable` constant; for `MListElement<E,V>` it applies the *parent's* filter via `mle.Parent` | `/Signum/Engine/Linq/ExpressionVisitor/QueryFilterer.cs:13-70`, called `:75` |
| 4 | **`QueryBinder.BindQuery`** — LINQ methods → `SelectExpression`/`ProjectionExpression`, members → `ColumnExpression`s; then `QueryJoinExpander.ExpandJoins` materialises implicit LEFT JOINs | `/Signum/Engine/Linq/ExpressionVisitor/QueryBinder.cs:55-64`, dispatch table `:66-245` |
| 5 | `AggregateRewriter` | `:85` |
| 6 | **`EntityCompleter.Complete`** — eager expansion: `EntityExpression` stubs → fully bound entities (all columns), `LiteReferenceExpression`→`LiteValueExpression`, `MListExpression`→`MListProjectionExpression` | `/Signum/Engine/Linq/ExpressionVisitor/EntityCompleter.cs:17-26`, called `:87` |
| 7 | `AliasProjectionReplacer` | `:89` |
| 8 | `OrderByRewriter` | `:91` |
| 9 | `AsOfExpressionVisitor.Rewrite` — expression-valued AS OF → `FOR SYSTEM_TIME ALL` + `WHERE period CONTAINS expr` | `/Signum/Engine/Linq/AsOfExpressionVisitor.cs:12-31`, called `:93` |
| 10 | `DuplicateHistory.Rewrite` | `:95` |
| 11 | `QueryRebinder.Rebind` | `:97` |
| 12 | `UnusedColumnRemover.Remove` | `:99` |
| 13 | `RedundantSubqueryRemover.Remove` | `:101` |
| 14 | `ConditionsRewriter` **or** `ConditionsRewriterPostgres` (bool↔predicate coercion, dialect-dependent) | `:103` |
| 15 | `ScalarSubqueryRewriter.Rewrite` | `:105` |
| 16 | `ChildProjectionFlattener.Flatten` — splits correlated sub-projections into `ChildProjectionExpression`s keyed by an outer key, then re-runs stages 12–13 | `/Signum/Engine/Linq/ExpressionVisitor/ChildProjectionFlattener.cs:17-27`, called `:61` |
| 17 | `TranslatorBuilder.Build` → `ITranslateResult` | `/Signum/Engine/Linq/ExpressionVisitor/TranslatorBuilder.cs:13-47` |
| 17a | `QueryFormatter.Format(proj.Select)` → SQL text + `DbParameter`s | `TranslatorBuilder.cs:34`; visitor `/Signum/Engine/Linq/ExpressionVisitor/QueryFormatter.cs:16-47` |
| 17b | `ProjectionBuilder.Build<T>(proj.Projector, scope)` → `Expression<Func<IProjectionRow, T>>` — **the materializer** | `TranslatorBuilder.cs:32`, `:155-180` |
| 18 | `TranslateResult<T>.Execute()` | `/Signum/Engine/Linq/TranslateResult.cs:225-271` |

`DbExpressionNominator` (103 KB, `/Signum/Engine/Linq/ExpressionVisitor/DbExpressionNominator.cs:21-58`) is **not** a pipeline stage: it is a bottom-up helper called from inside `QueryBinder`/`ColumnProjector` that marks which sub-expressions are SQL-representable candidates (call sites e.g. `QueryBinder.cs:1102, 1256, 3483`). It has `AssertPostgres`/`AssertSqlServer` guards (`:60-70`) so dialect-specific functions fail loudly rather than mistranslate.

### 3.3 Execution and materialization

`/Signum/Engine/Linq/TranslateResult.cs:225-271`:

```csharp
using (new EntityCache())
using (var tr = new Transaction())
{
    using (var retriever = EntityCache.NewRetriever())
    {
        var lookups = new Dictionary<LookupToken, IEnumerable>();
        foreach (var child in EagerProjections) child.Fill(lookups, retriever);   // extra SELECTs FIRST
        using (var reader = Executor.UnsafeExecuteDataReader(MainCommand))
        {
            var enumerator = new ProjectionRowEnumerator<T>(reader.Reader, ProjectorExpression, lookups, retriever, ...);
            result = Unique == null ? enumerable.ToList() : UniqueMethod(enumerable, Unique.Value);
        }
        foreach (var child in LazyChildProjections) child.Fill(lookups, retriever);  // MList SELECTs LAST
        retriever.CompleteAll();                                                    // batched retrieves
    }
    return tr.Commit(result);
}
```

The projector does not read columns into properties directly; it emits calls into `IRetriever` — handles at `TranslatorBuilder.cs:162-166` (`Complete<T>`, `Request<T>`, `RequestIBA<T>`, `RequestLite<T>`, `ModifiablePostRetrieving<T>`), `VisitEntity` at `:294-299`:

```csharp
protected internal override Expression VisitEntity(EntityExpression entityExpr)
{
    Expression id = Visit(NullifyColumn(entityExpr.ExternalId));
    if (entityExpr.TableAlias == null)
        return Expression.Call(retriever, miRequest.MakeGenericMethod(entityExpr.Type), id);  // lazy → batched
    ...  // else retriever.Complete(id, e => { e.Prop = row.Reader.Get...; })
```

`RealRetriever` (`/Signum/Engine/Retriever.cs:25-132`) is the identity map + request queue. `CompleteAllPrivate` (`:176-213`) batches by **largest pending type first** and loops (`goto retry`, label `:178`) because retrieving can enqueue further requests. `Database.RetrieveList` chunks by `Schema.Current.Settings.MaxNumberOfParameters` (`/Signum/Engine/Database.cs:834, 844, 927`).

### 3.4 The "query expression" pattern

All the attributes live in `/Signum.Utilities/ExpressionExpanderAttributes.cs`:

| Member | Line | Purpose |
|---|---|---|
| `IMethodExpander.Expand(instance, args, mi)` | `:8-11` | arbitrary programmatic rewrite |
| `GenericMethodExpander` | `:14-21` | a `LambdaExpression` for open-generic expanders |
| `[MethodExpander(typeof(X))]` | `:28-41` | attach an expander to a method |
| `[PolymorphicExpansion]` | `:63-68` | "expand me *later*, in `QueryBinder`, not in `ExpressionCleaner`" |
| `[EagerBinding]` | `:71-74` | on a parameter: don't hoist into a temp during late expansion |
| `[ExpressionField("Name")]` | `:80-88` | points at a static field holding the `LambdaExpression` |
| `[AutoExpressionField]` | `:94-96` | the field is *generated* for you at build time |
| `As.Expression<T>(Expression<Func<T>> body)` | `:106-113` | **throws at runtime** — a syntactic marker only |
| `As.GetExpression*` / `As.ReplaceExpression*` | `:115-164` | read/**overwrite** the generated field at runtime |

`As.Expression`'s body:

```csharp
public static T Expression<T>(Expression<Func<T>> body)      // :106-113
{
    throw new InvalidOperationException("""
        This method is not meant to be called!!
        Did you forget the AutoExpressionFieldAttribute or is the project missing reference to Signum.MSBuildTask in this assembly?
        """);
}
```

**Replacement at translation time** — `ExpressionCleaner`:

- `VisitMethodCall` (`/Signum.Utilities/ExpressionTrees/ExpressionCleaner.cs:47-72`) → `BindMethodExpression(expr, allowPolymorphics: false)`; `VisitMember` (`:128-137`) → `BindMemberExpression`. Both re-`Visit` the result so expansions compose recursively.
- `BindMethodExpression` precedence (`:74-126`): (1) `ExpressionExtensions.Evaluate(...)` → `Expression.Invoke(lambda, args)`; (2) `[PolymorphicExpansion]` + `!allowPolymorphics` → **bail out**, leaving the node for `QueryBinder`; (3) `[MethodExpander]`; (4) `GetFieldExpansion(...)` → `Expression.Invoke(lambda, instance.PreAnd(args))`.
- `GetExpansion` (`:191-214`) is the reflection that loads the field:

```csharp
ExpressionFieldAttribute? efa = mi.GetCustomAttribute<ExpressionFieldAttribute>();
if (efa == null) return null;
if (efa.Name == "auto")
    throw new InvalidOperationException($"...has the default value 'auto'.\nMaybe Signum.MSBuildTask is not running in assemby {...}?");
FieldInfo? fi = mi.DeclaringType!.GetField(efa.Name, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
var obj = fi.GetValue(null);
if (obj is not LambdaExpression result) throw ...;
return result;
```

- `GetFieldExpansion` (`:163-178`) walks the **runtime** declared type up the base/interface chain (`GetMember` `:220-250`, `BaseMember` `:252-266`), so explicit interface impls and overrides resolve correctly.

**Late/polymorphic expansion inside `QueryBinder`** — members whose receiver is only known after binding (e.g. from an `ImplementedBy` dispatch) are re-expanded with `allowPolymorphics: true`: methods at `/Signum/Engine/Linq/ExpressionVisitor/QueryBinder.cs:1781-1805`, properties at `:2030-2042`:

```csharp
if (ExpressionCleaner.HasExpansions(source.Type, m.Method) && source is EntityExpression)
{
    Dictionary<ParameterExpression, Expression> replacements = new();
    Expression? replace(Expression? e, ParameterInfo? pi) { ... pi.HasAttribute<EagerBindingAttribute>() ... }
    MethodCallExpression simple = Expression.Call(replace(m.Object, null), m.Method, m.Arguments.Select(...).ToArray());
    Expression binded = ExpressionCleaner.BindMethodExpression(simple, true)!;
    Expression cleanedSimple = DbQueryProvider.Clean(binded, true, null)!;   // re-cleaned!
    map.AddRange(replacements);
    Expression result = Visit(cleanedSimple);
    map.RemoveRange(replacements.Keys);
    return result;
}
```

**The MSBuild IL rewriter.** `Signum.MSBuildTask` is a **post-compile Mono.Cecil rewriter**, not a source generator:

- Hook: `/Signum.MSBuildTask/Signum.MSBuildTask.targets:2-7` — target `SignumAfterCompile` `AfterTargets="AfterCompile"`, writes `@(ReferencePath)` to `SignumReferences.txt` and `Exec`s `dotnet Signum.MSBuildTask.dll <IntermediateAssembly> <refs>`.
- Driver: `/Signum.MSBuildTask/Program.cs:55-70` runs `ExpressionFieldGenerator.FixAutoExpressionField()`, `FieldAutoInitializer.FixAutoInitializer()`, `AutoPropertyConverter.FixProperties()`, then `assembly.Write(...)`.
- `/Signum.MSBuildTask/ExpressionFieldGenerator.cs:53-112` — for every member with `[AutoExpressionField]`: adds a private static field `<Name>Expression` of type `Expression<Func<...>>` (`:76-79`); adds a `<Name>Init()` method and **prepends a call to it in the type's `.cctor`** (creating the `.cctor` if absent, `:81-96`); `Transform(...)` (`:116+`) rewrites the method body IL into expression-tree-construction IL, turning each original parameter (including `this`, literally named `"this"`, `:132`) into an `Expression.Parameter(type, name)` local, and **detecting and removing the C# closure display class** `<>c__DisplayClass` in both DEBUG (`newobj/stloc`) and RELEASE (`dup/stfld`) shapes (`:100-101`, `:144-160`); finally removes `[AutoExpressionField]` and adds `[ExpressionField("<Name>Expression")]` (`:103-108`).
- Compile-time guard rails: `/Signum.Analyzer/Signum.Analyzer/AutoExpressionFieldAnalyzer.cs` — rule **SF0001** (`:16-23`) fires on the attribute syntax node (`:31`) if the return is `void` (`:52-56`), a parameter has a modifier other than `this` (`:58-65`), the body is not a single `As.Expression(() => ...)` invocation (`:73-83`), the argument is not a parenthesized lambda (`:87-91`), or there is an implicit conversion between `As.Expression`'s return type and the member type (`:95-104` — important, because the IL rewrite would silently drop it). Companions: `ExpressionFieldAnalyzer.cs`, `LiteEqualityAnalyzer.cs`, `LiteCastAnalyzer.cs`, plus fix providers.

**Registration of extension expressions for the UI** — `ExpressionContainer`:

- `/Signum/DynamicQuery/DynamicQueryFluentInclude.cs:27-56` — four `WithExpressionFrom<T,F>` overloads (an `IQueryable`-returning lambda yields a *collection* token; a `T?`-returning one a single token), all delegating to `QueryLogic.Expressions.Register(lambdaToMethodOrProperty, niceName)`. `WithExpression` variants (`:59-123`) exist but the code comments say to prefer `WithExpressionFrom` "to keep dependencies between modules clean".
- Storage: `Polymorphic<Dictionary<string, ExtensionInfo>> RegisteredExtensions` with `PolymorphicMerger.InheritDictionaryInterfaces` (`/Signum/DynamicQuery/ExpressionContainer.cs:8-14`), so registrations inherit down class hierarchies **and** through interfaces; plus `RegisteredExtensionsWithParameter` for indexer-style tokens.
- `Register<E,S>` (`:103-125`) requires a single member access or method call and, for methods, **asserts `[ExpressionField]` is present**:

```csharp
if (mi.GetCustomAttribute<ExpressionFieldAttribute>() == null)
    throw new InvalidOperationException("The parameter 'lambdaToMethodOrProperty' should be an expression calling a expression method or property");
```

- `ExtensionInfo` (`:285-380`) derives its UI metadata by running the **metadata pipeline**, not SQL: `MetadataVisitor.JustVisit(Lambda, MetaExpression.FromToken(qt, SourceType))` (`:320`), then reads `CleanMeta.PropertyRoutes` / `DirtyMeta.CleanMetas` to infer `PropertyRoute`, `Implementations`, `Format`, `Unit`, `IsAllowed` (`:340-359`), with `Force*` overrides (`:361-374`). `MetadataVisitor` is a parallel column-less binder: `/Signum/Engine/Linq/Meta/MetadataVisitor.cs:12-46`.
- Separately, `Schema.EntityEvents.AdditionalBindings` injects synthetic fields into the query projector: `Schema.GetAdditionalQueryBindings` (`/Signum/Engine/Schema/Schema.cs:268-280`) → `AdditionalFieldExpression`, consumed by `Table.GenerateBindings` (`/Signum/Engine/Schema/Schema.Expressions.cs:91-92`) and resolved lazily by `QueryBinder.BindAdditionalField` (`QueryBinder.cs:3500-3520`). This is the mechanism behind VirtualMList.
- Runtime monkey-patching is supported: `As.ReplaceExpression` writes a new lambda into the generated static field (`ExpressionExpanderAttributes.cs:147-164`).
- `ExpandableQueryProvider<T>` (`/Signum.Utilities/ExpressionTrees/ExpandableQueryProvider.cs:7-30`) lets the same `[ExpressionField]` machinery work over **foreign** providers (EF/L2S) by calling `ExpressionCleaner.Clean` before delegating.

### 3.5 `MList<T>` in queries and on save

**Querying.** `Database.MListQuery<E,V>(Expression<Func<E, MList<V>>>)` (`/Signum/Engine/Database.cs:1243-1254`) resolves the `FieldMList`/`TableMList` and returns `new SignumTable<MListElement<E,V>>(DbQueryProvider.Single, mlistTable)`; it carries `[MethodExpander(typeof(MListQueryExpander))]` (`:1256-1264`) which compiles-and-invokes itself at expansion time and returns `Expression.Constant(query)`.

```csharp
public static IQueryable<MListElement<E, V>> MListElements<E, V>(this E entity, Expression<Func<E, MList<V>>> mListProperty)
    where E : Entity                                          // /Signum/Engine/Database.cs:1266-1279
{
    return MListQuery(mListProperty).DisableQueryFilter().Where(mle => mle.Parent == entity);
}
```

`MListElementsExpander` (`:1281-1312`) rebuilds that tree manually, wrapping `Parent` in `ToLite()` when the argument is a `Lite<E>` (`:1302-1303`). Member access on `MListElement` maps `RowId`/`Parent`/`RowOrder`/`RowPartitionId`/`Element` at `QueryBinder.cs:2247-2260`, throwing when the underlying table lacks an Order/PartitionId column.

Schema side: `TableMList.FieldExpression(..., withRowId)` (`/Signum/Engine/Schema/Schema.Expressions.cs:162-180`) wraps the element in a `RowIdElement` when `withRowId`:

```csharp
var ci = typeof(MList<>.RowIdElement).MakeGenericType(type)
             .GetConstructor(new[] { type, typeof(PrimaryKey), typeof(int?) })!;
var order = Order == null ? (Expression)Expression.Constant(null, typeof(int?)) : OrderExpression(tableAlias).Nullify();
return Expression.New(ci, exp, rowId.UnNullify(), order);
```

Accessing `entity.Lines` inside a query yields an `MListExpression` (`Schema.Expressions.cs:295-301`) which `QueryBinder.MListProjection(mle, withRowId)` (`QueryBinder.cs:3470-3498`) turns into a correlated `ProjectionExpression` with `WHERE backId = parentId [AND partitionId = …] [AND periods overlap]`.

**On retrieve** it is exactly **one extra SELECT per MList, executed after the main reader is drained** — never N+1. `EntityCompleter.VisitMList` always uses `withRowId: true` (`/Signum/Engine/Linq/ExpressionVisitor/EntityCompleter.cs:209-216`); `ChildProjectionFlattener.VisitMListProjection` (`ChildProjectionFlattener.cs:30-37`) sets `IsLazyMList` (`:70`) which routes it to `LazyChildProjection` (`TranslatorBuilder.cs:68-76`). Filling (`/Signum/Engine/Linq/TranslateResult.cs:118-154`):

```csharp
((IMListPrivate<V>)kvp.Value).InnerList.AddRange(results);
((IMListPrivate<V>)kvp.Value).InnerListModified(results.Select(a => a.Element).ToList(), null);
retriever.ModifiablePostRetrieving(kvp.Value);
```

(the async variant uses `AssignMList(results.ToList())` instead, `:177-179`). `Scope.LookupMList` (`TranslatorBuilder.cs:755-769`) emits `row.LookupRequest<K,S>(token, outerKey, field)`; the row-side impl reuses the entity's own empty MList instance (`/Signum/Engine/Linq/ProjectionReader.cs:95-101`), so the graph isn't rebuilt.

**Persistence.** `TableMList.TableMListCache<T> : IMListCache` (`/Signum/Engine/Schema/Schema.Save.cs:980-990`), invoked from the saver at `:659`/`:666`. Four SQL shapes, each cached per batch size in a `ConcurrentDictionary<int, Action<...>>`: `GetDelete(n)` (`:1000-1016`), `GetDeleteExcept(n)` (`:1022-1033`), `GetUpdate(n)` (`:1054-1074`), `GetInsert(n)` (`:1098-1128`) — the last **reads identities back**:

```csharp
DataTable dt = new SqlPreCommandSimple(sqlMulti, result).ExecuteDataTable();
for (int i = 0; i < num; i++) {
    var pair = list[i];
    pair.MList.SetRowId(pair.Index, new PrimaryKey((IComparable)dt.Rows[i][0]));
    if (this.hasOrder) pair.MList.SetOldIndex(pair.Index);
}
```

`RelationalUpdates` (`:1185-1245`) is the diff: skip if `Modified == Clean` (`:1203`); `DELETE ... EXCEPT surviving RowIds` (`:1208-1213`); `UPDATE` **only** when `isEmbeddedEntity || hasOrder` and only if the order actually changed or the embedded is graph-modified (`:1215-1230`) — so **plain `MList<Lite<X>>`/`MList<int>` rows are never UPDATEd**, they are delete-except + insert; then `INSERT` rows with `RowId == null` (`:1232-1236`).

### 3.6 `Lite<T>` in queries; `SmartEqualizer`

`ToLite()`/`ToLiteFat()` — `QueryBinder.cs:173-185`:

```csharp
else if (m.Method.DeclaringType == typeof(Lite) && (m.Method.Name == "ToLite" || m.Method.Name == "ToLiteFat"))
{
    var entity    = Visit(m.GetArgument("entity"));
    var converted = EntityCasting(entity, Lite.Extract(m.Type)!)!;
    Expression? model     = Visit(m.TryGetArgument("model"));
    Expression? modelType = Visit(m.TryGetArgument("modelType"));
    return new LiteReferenceExpression(Lite.Generate(entity.Type), entity, model,
        modelType == null ? null : ToTypeDictionary(modelType, entity.Type),
        false, eagerEntity: m.Method.Name == "ToLiteFat");
}
```

A `Lite<T>` **column** is already wrapped by the schema: `FieldReference.GetExpression` (`/Signum/Engine/Schema/Schema.Expressions.cs:270-284`) builds an `EntityExpression` over the FK column then `QueryBinder.MakeLite(...)` when `IsLite`. Ditto `FieldImplementedBy` (`:346-352`) and `FieldImplementedByAll` (`:368-369`). **In SQL there is zero difference between a `T` and a `Lite<T>` property — same FK column.**

Member access on a Lite (`QueryBinder.cs:2213-2228`): only `Id`, `EntityOrNull`/`Entity` (which simply **unwrap** to the underlying `EntityExpression`, i.e. an implicit LEFT JOIN), and `EntityType` are allowed; anything else throws `"The member {0} of Lite is not accessible on queries"`. `.ToString()` on a Lite recurses into the entity's `ToString` expression (`:1835-1840`) — which is why an `[AutoExpressionField] ToString()` causes the *real* columns to be selected rather than a `ToStr` column.

`Database.Retrieve` inside a query is **explicitly rejected** (`QueryBinder.cs:156-159`):

```csharp
else if (m.Method.DeclaringType == typeof(Database) && (m.Method.Name == "RetrieveAndRemember" || m.Method.Name == "Retrieve"))
    throw new InvalidOperationException("{0} is not supported on queries. Consider using Lite<T>.Entity instead."...);
```

`.Is(...)` is pure sugar erased during `ExpressionCleaner` via `[MethodExpander]`: `IsExpander` for entity-entity and lite-lite (`/Signum/Entities/Lite.cs:350-356`, attributes `:478`, `:497`) → `Expression.Equal`; `IsEntityLiteExpander` (`:516-535`) and `IsLiteEntityExpander` (`:556-575`) wrap the entity side in `ToLite()` first. The in-memory bodies (`:538-554`, `:578-594`) compare `EntityType` then `Id`, falling back to `ReferenceEquals` for new entities.

`SmartEqualizer` (`/Signum/Engine/Linq/ExpressionVisitor/SmartEqualizer.cs`) is the type-aware `==` translator. `QueryBinder.VisitBinary` funnels every `Equal`/`NotEqual` into it (`QueryBinder.cs:2751-2778`):

```csharp
if (b.NodeType == ExpressionType.Equal)    return SmartEqualizer.PolymorphicEqual(left, right, safeNull: isNegated);
if (b.NodeType == ExpressionType.NotEqual) return Expression.Not(SmartEqualizer.PolymorphicEqual(left, right));
```

`PolymorphicEqual` (`:48-101`) tries, in order: `NewExpression` destructuring (anonymous/tuple keys, `:50-60`), `PrimaryKeyEquals`, `ObjectEquals`, `ConditionalEquals`, `CoalesceEquals`, `LiteEquals`, `EntityEquals`, `TypeEquals`, `MListElementEquals`, `EnumEquals`, then `EqualNullable`. `LiteEquals` (`:669-680`) strips both sides to `.Reference` and recurses. `MListElementEquals` (`:682-696`) compares `RowId`. `ConstantToEntity`/`ConstantToLite` (`:882-926`) turn a captured C# entity/Lite constant into id constants.

### 3.7 Polymorphic FK translation

`DispatchIb` (`QueryBinder.cs:2300-2337`) is the heart:

```csharp
public Expression DispatchIb(ImplementedByExpression ib, Type resultType, Func<EntityExpression, Expression> selector)
{
    if (ib.Implementations.Count == 0) return Expression.Constant(null, resultType);
    if (ib.Implementations.Count == 1) return selector(ib.Implementations.Values.Single());
    if (ib.Strategy == CombineStrategy.Case) {
        var dictionary = ib.Implementations.SelectDictionary(ee => selector(ee));
        return CombineImplementations(new SwitchStrategy(ib), dictionary, resultType);
    } else {
        UnionAllRequest ur = Completed(ib);
        var dictionary = ur.Implementations.SelectDictionary(ue => { using (SetCurrentSource(ue.Table)) return selector(ue.Entity); });
        return CombineImplementations(ur, dictionary, resultType);
    }
}
```

- `CombineStrategy.Case` → `CASE WHEN <FK_i> IS NOT NULL THEN <value_i> … END` (`SwitchStrategy.CombineValues`, `:2346-2361`).
- `CombineStrategy.Union` → a `UNION ALL` sub-select with `Id_<Type>` columns, LEFT JOINed on all FK columns (generated SQL in `/Signum/Engine/Linq/Linq.Inheritance.md:114-129`). Selectable per-query with `.CombineUnion()` / `.CombineCase()` (`LinqHintEntities`, `/Signum/Entities/FieldAttributes.cs:565`, handled `QueryBinder.cs:164-172`).
- `CombineImplementations` (`:2370-2480`) recombines heterogeneous branch results: lifts to `ImplementedByAllExpression` if any branch is IBA (`:2390-2398`), to `ImplementedByExpression` with the union of types if all are Entity/IB (`:2401-2428`), to `TypeImplementedByAllExpression` for `System.Type` results (`:2475-2479`).
- **`ImplementedByAll` member access is deliberately crippled** — only `Id` works, by coalescing all id columns (`:2236-2246`):

```csharp
if (fi != null && fi.FieldEquals((Entity ie) => ie.id))
    return new PrimaryKeyExpression(Coalesce(typeof(IConvertible),
        iba.Ids.Values.Select(a => (Expression)Expression.Convert(a, typeof(IConvertible))))).UnNullify();
throw new InvalidOperationException("The member {0} of ImplementedByAll is not accesible on queries"...);
```

- **Three-valued logic for IB equality** is a real, commented-on bug fix. Because `ImplementedBy` has no discriminator column, a type mismatch naturally yields `NULL`, and `NOT(NULL) = NULL` silently drops rows under negation. `EntityIbEquals` (`SmartEqualizer.cs:792-803`) and `IbIbEquals` (`:813-825`) therefore emit `ThreeValued(anyNull, match)` (`:841-848`) → `CASE WHEN anyNull THEN NULL WHEN match THEN true ELSE false END`, where `NullBool = new SqlConstantExpression(null, typeof(bool))` (`:837`) is a bool-typed SQL NULL that plain `Expression.Constant(null, typeof(bool))` cannot express. The `safeNull: false` fast path (`:796-797`, `:819-820`) is used for join keys and `Contains`, where the result is never negated.
- IBA equality always compares `TypeId` against `QueryBinder.TypeConstant(t)` (`:2740-2748`) which resolves through `TypeLogic.TypeToId`, throwing `"The type {0} is not registered in the database as a concrete table"` — **so IBA queries require a live `TypeLogic`.**
- `System.Type` is a first-class query value: `TypeEntityExpression`, `TypeImplementedByExpression`, `TypeImplementedByAllExpression` (`/Signum/Engine/Linq/DbExpressions.Sql.cs:53-55`), all pairwise combinations at `SmartEqualizer.cs:447-540` plus `TypeIn` (`:541-576`). `GetType()` in a query is handled at `QueryBinder.cs:196-201`. Casts behave like `as` — they never throw (`Linq.Inheritance.md:26-47`).
- IBA materialization goes through `retriever.RequestIBA<T>(typeId, id)` (`TranslatorBuilder.cs:164`) resolved via `TypeLogic.IdToType` (`/Signum/Engine/Retriever.cs:122-132`).

### 3.8 Surprising things in the provider

- **Eager entity expansion.** Selecting an entity pulls *all* its columns and transitively completes referenced entities. `EntityCompleter.VisitEntity` (`/Signum/Engine/Linq/ExpressionVisitor/EntityCompleter.cs:137-159`) recurses with an `ImmutableStack<Type> previousTypes` cycle guard:

```csharp
if (previousTypes.Contains(ee.Type) || IsCached(ee.Type) || ee.AvoidExpandOnRetrieving)
    ee = new EntityExpression(ee.Type, ee.ExternalId, null, null, null, null, null, ee.AvoidExpandOnRetrieving); // stub
else
    ee = binder.Completed(ee);   // full JOIN + all columns
previousTypes = previousTypes.Push(ee.Type);
```

  A stub (`TableAlias == null`) becomes `retriever.Request<T>(id)` — a deferred, batched load. `[AvoidExpandQuery]` is how you opt out.
- **`EntityCompleter.IsCached` has a side effect**: it calls `cc.Load()` "just to force cache before executing the query" (`:198-207`). Query *translation* can therefore trigger a full table cache load.
- **`ExpressionMetadataStore`** (`/Signum/Engine/Linq/ExpressionMetadataStore.cs:5-45`) is a thread-static `ConditionalWeakTable<Expression, ExpressionMetadata>` scoped per translation, used to propagate `DateTimeKind` (UTC vs Local) from `ColumnExpression`s (`Schema.Expressions.cs:235-243`) across comparisons (`ShareMetadata`, `QueryBinder.cs:2770`). Keyed by **reference identity**, so expression rebuilds must call `CopyMetadata`.
- **`MethodExpander`s that compile-and-run during expansion**: `MListQueryExpander` (`Database.cs:1256-1264`) and `MListElementsExpander` (`:1281-1312`) both do `Expression.Lambda<Func<IQueryable>>(...).Compile()()` inside `Expand` and embed the result as a constant.
- **`Unsafe*` reuse the same binder with different entry points.** `DbQueryProvider.Delete` (`:109-129`), `Update` (`:131-151`), `Insert` (`:153-172`) each run `Clean` → `binder.BindDelete/BindUpdate/BindInsert` → the **same `Optimize` chain** → `CommandSimplifier.Simplify(...)` → `TranslatorBuilder.BuildCommandResult`. `BindDelete` (`QueryBinder.cs:2780-2820`) emits **multiple** `DeleteExpression`s — one per MList table plus the main table — in a `CommandAggregateExpression`, with `avoidMList` to skip cascades. Fluent surface `IUpdateable`/`IUpdateablePart<A,T>` (`Database.cs:1845-1866`), `Execute` (`:1585-1605`), and chunked variants `UnsafeDeleteChunks`/`ExecuteChunks` (`:1495-1534`, `:1607-1624`). All fire `Schema.Current.OnPreUnsafeUpdate/Delete/Insert` (`:1442`, `:1599`).
- **`SystemTime` / temporal queries.** `QueryBinder.systemTime` initialises from ambient `SystemTime.Current` (`:34`), overridable inline (`:232-242`) or per-query via `Database.Query<T>(SystemTime)` (`Database.cs:1234-1238`). `AsOfExpressionVisitor` rewrites an *expression-valued* AS OF into `SYSTEM_TIME ALL` + `WHERE interval CONTAINS expr` — a per-row AS OF that T-SQL cannot express directly. `SystemTime.HistoryTable` redirects deletes to history tables (`QueryBinder.cs:2782`, `:2797`).
- **Security is enforced at bind time.** `Table.GetProjectorExpression` calls `Schema.Current.AssertAllowed(Type, inUserInterface: false)` (`Schema.Expressions.cs:31-32`); `TableMList.GetMListElementExpression` asserts on the *parent* type (`:184-185`). Bypass via `SignumTable.DisableAssertAllowed` / `LinqHints.DisableQueryFilter`.
- **Defensive stage invariants throughout**: `QueryBinder.IsTable` throws `"{0} belongs to another kind of Linq Provider"` (`:1490-1504`); `ProjectionBuilder` throws `"No ProjectionExpressions expected at this stage"` and `"Impossible to retrieve MixinEntity … without their main entity"` (`TranslatorBuilder.cs:284-292`).

---

## 4. Operations

### 4.1 `Graph<T>` and the five operation kinds

All five kinds are **nested classes of `Graph<T>`** (`/Signum/Operations/Graph.cs`), whose only purpose is namespacing. `Graph<T>` is never instantiated; `Graph<T,S>`'s ctor actively throws `"OperationGraphs should not be instantiated"` (`/Signum/Operations/GraphState.cs:304-307`). You either write `new Graph<T>.Execute(...)` or inherit `class OrderGraph : Graph<OrderEntity, OrderState>` and write `new Execute(...)`.

| Kind | Line | Delegate signature |
|---|---|---|
| `Graph<T>.Construct` | `Graph.cs:10-155` | `Func<object?[]?, T?>` (`/Signum/Operations/Internal.cs:37`) |
| `Graph<T>.ConstructFrom<F>` | `Graph.cs:157-355` | `Func<F, object?[]?, T?>` (`Graph.cs:193`) |
| `Graph<T>.ConstructFromMany<F>` | `Graph.cs:357-530` | `Func<List<Lite<F>>, object?[]?, T?>` (`Graph.cs:383`) |
| `Graph<T>.Execute` | `Graph.cs:532-716` | `Action<T, object?[]?>` (`Internal.cs:43`) |
| `Graph<T>.Delete` | `Graph.cs:718-871` | `Action<T, object?[]?>` (`Internal.cs:50`) |

**`Execute` members — and here the docs are actively wrong.** `/Signum/Operations/Operations.md:210-214` documents `AllowNew` and `Lite`; the code has:

| Member | Line | Meaning |
|---|---|---|
| `Execute` | `:554` | the body, runs inside a `Transaction` |
| `CanExecute` (`Func<T,string?>?`) | `:555` | precondition; non-null string = error message |
| `CanExecuteExpression` (`Expression<Func<T,string?>>?`) | `:557` | DB-evaluable variant; **required** to expose the operation as a query token (`OperationLogic.cs:160-161`) |
| `CanBeNew` | `:552` | replaces the doc's `AllowsNew`; if false, `OnCanExecute` rejects `entity.IsNew` (`:589-590`) |
| `CanBeModified` | `:540` | replaces the doc's `!Lite` (inverted meaning). If false, `AssertEntity` rejects a dirty graph (`OperationLogic.cs:685-697`); if true, `AssertLite` rejects `ExecuteLite` (`OperationLogic.cs:676-683`) |
| `AvoidImplicitSave` | `:544` | by default the entity **is saved for you** |
| `ForReadonlyEntity` | `:545` | forces `AvoidImplicitSave`, forbids `CanBeNew`/`CanBeModified` (`:699-708`), throws if the graph got modified (`:640-641`) |
| `OverrideExecute` / `OverrideCanExecute` | `:564-573` | the `Overrider<F>` delegate (`Graph.cs:5`) wrapping pattern for extending a base implementation |

The invocation body — the canonical shape shared by all five kinds (`Graph.cs:598-684`):

```csharp
void IExecuteOperation.Execute(IEntity entity, params object?[]? args)
{
    OperationLogic.AssertOperationAllowed(executeSymbol.Symbol, entity.GetType(), inUserInterface: false, entity: (Entity)entity);
    OperationLogEntity log = new OperationLogEntity { Operation = executeSymbol.Symbol, Start = Clock.Now, User = UserHolder.Current?.User! };
    using (var tr = new Transaction())
    {
        using (OperationLogic.AllowSave(entity.GetType()))
        {
            var assertEnd = AssertEntity((T)entity);
            OperationLogic.OnSuroundOperation(this, log, entity, args).EndUsing(_ =>
            {
                string? error = OnCanExecute((T)entity);
                if (error != null) throw new ApplicationException(error);
                Execute((T)entity, args);
                assertEnd?.Invoke();
                if (!AvoidImplicitSave) entity.Save();
                log.SetTarget(entity); log.End = Clock.Now;
            });
        }
        log.SaveLog();
        tr.Commit();
    }
}
```

Order: authorize → build log → transaction → `AllowSave` scope → `SurroundOperation` events → `CanExecute` → body → implicit save → log. On exception, `SetExceptionData` stamps `ex.Data["operation"/"entity"/"args"]` (`OperationLogic.cs:316-322`) and a fresh log carrying the `ExceptionEntity` lite is written in `Transaction.ForceNew()` (`Graph.cs:664-679`).

`Delete` (`Graph.cs:718-871`): `CanBeNew => false` is hardcoded (`:732`), and the entity is **not** implicitly deleted — your delegate must call `e.Delete()` (see the default in `FluentOperationInclude.WithDelete`, `OperationLogic.cs:908`).

`ConstructFrom<F>` extras: `ResultIsSaved` (asserted at `Graph.cs:337-338`), `SourceEntityIsModified` (only consumer is `OperationAuthLogic.cs:224`, deciding Write-vs-Read on the *source* type), `LogAlsoIfNotSaved`. **`BaseType` comes from the symbol container** (`Graph.cs:207`), which is why a `ConstructFrom` is registered under `F`, not `T` (`OverridenType`, `Graph.cs:163`, `:363`).

`ConstructFromMany<F>` has no per-entity `CanConstruct` delegate — only `CanConstructExpression`, evaluated in DB in chunks of 100 (`Graph.cs:400-415`); authorization is asserted once per distinct `EntityType` (`:428-431`).

### 4.2 `Graph<T,S>` — the state machine

`/Signum/Operations/GraphState.cs`. `Graph<T,S>` subclasses each of the five and layers states:

- **`GetState` is a `static` `Expression<Func<T,S>>` per `<T,S>` pair**; the setter compiles it into `GetStateFunc` (`:309-320`). Convention is to set it as the first line of `Register()`: `GetState = f => f.State;` (`/Signum.Test/Environment/MusicLogic.cs:289`). `AssertGetState()` (`:83-91`) produces the "Consider writing something like 'GetState = a => a.State'" error at registration time. **Surprise:** this is static state on a generic type, mutated from arbitrary `Start` methods; two independent graph classes over the same `<T,S>` share it.
- `Execute` (`:165-255`) adds `FromStates`, `ToStates`, and `FromToStates` (`List<(S from, S to)>`). `OnCanExecute` rejects states not in `FromStates` with `OperationMessage.StateShouldBe0InsteadOf1` (`:187-197`). `AssertEntity` returns a **post-condition closure** verifying the end state (`:199-220`); with `FromToStates` it captures the initial state and only permits the declared transitions. `AssertIsValid` (`:222-246`) forbids mixing `FromToStates` with `FromStates`/`ToStates`.
- `Construct`/`ConstructFrom`/`ConstructFromMany` add `ToStates` only; `Delete` adds `FromStates` only.
- `ToDGML()` / `ToDirectedGraph()` (`:328-385`) walk `OperationLogic.GraphOperations<T,S>()` to render the machine, with pseudo-nodes `[New]`, `[From X]`, `[FromMany X]`, `[Deleted]`. **This is directly useful for a CLI: `signum operations graph OrderEntity --dgml`.**

### 4.3 `.Register()`

`Register` is an **extension method on `IOperation`** (`/Signum/Operations/OperationLogic.cs:350-370`):

```csharp
public static void Register(this IOperation operation, bool replace = false)
{
    if (Schema.Current.IsCompleted) throw new InvalidOperationException("Schema already completed");
    if (!operation.OverridenType.IsIEntity()) throw new InvalidOperationException(...);
    operation.AssertIsValid();
    var dic = operations.GetOrAddDefinition(operation.OverridenType);
    if (replace) dic[operation.OperationSymbol] = operation;
    else dic.AddOrThrow(operation.OperationSymbol, operation, "Operation {0} has already been registered");
    operations.ClearCache();
    operationsFromKey.Reset();
}
```

`AssertIsValid()` is where each class compiles `CanExecuteExpression → CanExecute` and asserts mandatory delegates/states (`Graph.cs:691-709`, `GraphState.cs:222-246`).

**Doc drift:** `Operations.md:577-590` documents `.RegisterReplace()`; no such method exists — only `Register(replace: true)`.

Fluent shorthands (`OperationLogic.cs:888-932`):

```csharp
public static FluentInclude<T> WithSave<T>(this FluentInclude<T> fi, ExecuteSymbol<T> saveOperation,
                                           Action<T, object?[]?>? execute = null) where T : Entity
{
    new Graph<T>.Execute(saveOperation) { CanBeNew = true, CanBeModified = true,
                                          Execute = execute ?? ((e, _) => { }) }.Register();
    return fi;
}
```

plus `WithDelete` and `WithConstruct`.

### 4.4 Symbols: `OperationSymbol`, `Symbol`, `SemiSymbol`, `[AutoInit]`

`Symbol : Entity` (`/Signum/Basics/Symbol.cs:5-118`) with `[UniqueIndex] string Key` (`:56-58`) and an `[Ignore] FieldInfo` (`:46-53`). The protected ctor does everything:

```csharp
public Symbol(Type declaringType, string fieldName)                    // Symbol.cs:15-44
{
    this.fieldInfo = declaringType.GetField(fieldName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;
    if (this.fieldInfo == null) throw new InvalidOperationException(...);
    this.Key = declaringType.Name + "." + fieldName;                   // <-- the Key
    try { Symbols.GetOrCreate(this.GetType()).Add(this.Key, this); }    // global registry
    catch (Exception e) when (StartParameters.IgnoredCodeErrors != null) { ...; return; }
    var dic = Ids.TryGetC(this.GetType());
    if (dic != null) { PrimaryKey? id = dic.TryGetS(this.Key); if (id != null) this.SetId(id.Value); }
}
```

Notes:
- **`Key` uses `declaringType.Name`, not `FullName`** (`:22`) — two `[AutoInit]` containers with the same simple name in different namespaces collide on the unique index. That surfaces as a duplicate-key startup failure, not a compile error.
- `ToString()` is `[AutoExpressionField] => this.Key` (`:60-61`); `NiceToString()` is `FieldInfo.NiceName()` (`:82-85`) — localizable, Pascal-spaced.
- **`Equals`/`GetHashCode` compare by `Key`, not by id** (`:68-78`). This is exactly what makes symbols usable as dictionary keys before the DB is touched — the `operations` registry is keyed this way.
- `Symbol.SetId` (`:87-112`) sets `id`, `IsNew = false`, `ToStr = Key`, and **seals** the instance (`Modified = Sealed`).

`OperationSymbol` (`/Signum/Operations/Operation.cs:3-144`) is the only `Symbol` with a **private** ctor: it exists only via the static factories `Construct<T>.Simple/From<F>/FromMany<F>` (`:16-31`), `Execute<T>` (`:91`), `Delete<T>` (`:97`), each wrapping it in a private impl of the corresponding **container interface** (`SimpleImp`, `FromImp<F>`, `ExecuteSymbolImp<T>`, `DeleteSymbolImp<T>`, `:33-143`). The containers — `IOperationSymbolContainer`, `IEntityOperationSymbolContainer<in T>`, `ConstructSymbol<T>.Simple/From/FromMany`, `ExecuteSymbol<in T>`, `DeleteSymbol<in T>` (`:146-191`) — exist purely to give the compiler the operation kind + entity type, with contravariant `in T` so `ExecuteSymbol<AwardEntity>` works on a subclass.

**There is no `SymbolContainer` type.** "Symbol container" just means the static `[AutoInit]` class, discovered reflectively via `FieldInfo.DeclaringType` (`/Signum/Basics/SymbolLogic.cs:55`).

**Who fills the static fields:** `[AutoInit]` (`/Signum/Entities/TypeAttributes.cs:9-15`) is a **marker with no runtime behaviour** — it only carries the helpful `ArgumentNullException("... Are you missing an [AutoInit] attribute?")` factory. The real work is IL weaving in `/Signum.MSBuildTask/FieldAutoInitiaizer.cs`:

- `FixAutoInitializer()` (`:44-56`) finds every `[AutoInit]` type.
- `AutoInitFields()` (`:63-113`) requires the class to be `static` with **no** existing static ctor (`:58-61`, `:72-77`), marks each field `InitOnly` (readonly), and emits a synthetic `.cctor` pushing `ldtoken <containerType>` + `ldstr <fieldName>` into the matching factory.
- `GetMethod()` (`:115-153`) maps the field's declared type to the factory: `ConstructSymbol<T>.Simple → OperationSymbol.Construct<T>.Simple`, `.From<F>`, `.FromMany<F>`, `ExecuteSymbol<T> → OperationSymbol.Execute<T>`, `DeleteSymbol<T> → OperationSymbol.Delete<T>` (`:120-137`); anything else must expose a `(Type, string)` ctor (`:143-153`) — **that is the contract every custom symbol type must satisfy** (`/Signum/Basics/Symbol.md:46-56`).

So `AlbumOperation.Save` (`/Signum.Test/Environment/Entities.cs:289-298`) is populated by a compiler-generated static ctor, and `AlbumOperation.Save.Symbol.Key == "AlbumOperation.Save"`.

**DB row creation / validation — `SymbolLogic<T>`** (`/Signum/Basics/SymbolLogic.cs:41-90`):

```csharp
public static void Start(SchemaBuilder sb, Func<IEnumerable<T>> getSymbols)
{
    if (sb.AlreadyDefined(typeof(SymbolLogic<T>).GetMethod("Start"))) return;
    sb.Include<T>().WithQuery(() => t => new { Entity = t, t.Id, t.Key });
    SymbolLogic.OnLoadAll += () => lazy.Load();
    SymbolLogic.OnGetSymbolContainer += () => getSymbols().Select(a => a.FieldInfo.DeclaringType!).Distinct();
    sb.Schema.Initializing  += () => lazy.Load();
    sb.Schema.Synchronizing += Schema_Synchronizing;
    sb.Schema.Generating    += Schema_Generating;
    sb.Schema.EntityEvents<T>().Saved += SymbolLogic_Saved;
    SymbolLogic<T>.getSymbols = getSymbols;
    lazy = sb.GlobalLazy(() => { using (AvoidCache()) {
        var current = Database.RetrieveAll<T>();
        var result = EnumerableExtensions.JoinRelaxed(current, getSymbols(), c => c.Key, s => s.Key,
            (c, s) => s.SetId(c.Id), "caching " + typeof(T).Name);
        Symbol.SetSymbolIds<T>(current.ToDictionary(a => a.Key, a => a.Id));
        return result.ToFrozenDictionaryEx(a => a.Key);
    }}, new InvalidateWith(typeof(T)), Schema.Current.InvalidateMetadata);
}
```

- Rows are created by **DDL generation, not at runtime**: `Schema_Generating` emits one `InsertSqlSync` per registered symbol (`:114-121`); `Schema_Synchronizing` diffs code-vs-DB by `Key` and emits insert/delete/update-with-rename (`:123-142`). `Saved` **throws** if anyone tries to save a symbol at runtime (`:92-96`).
- Ids are injected into the static fields at `Schema.Initialize()` time. `JoinRelaxed` (`/Signum.Utilities/Extensions/EnumerableExtensions.cs:1159`) downgrades a code/DB mismatch to a logged exception when `StartParameters.IgnoredDatabaseMismatches != null`.
- Access: `SymbolLogic<T>.Symbols` / `ToSymbol(key)` / `TryToSymbol(key)` / `AllUniqueKeys()` (`:152-170`), all behind `AssertStarted()` which throws `"{0} has not been started. Someone should have called {0}.Start before"` (`:144-150`).

**With no DB / before `Initialize()`:** the symbol object exists and is fully usable in memory — `Key`, `ToString()`, `NiceToString()`, `Equals`/`GetHashCode`, dictionary lookups, `OperationLogic.Register` — but `IsNew == true` and `Id` throws. Any query or FK save needs the id.

`SemiSymbol` (`/Signum/Basics/SemiSymbol.cs:5-142`) is the run-time-extensible variant: same ctor pattern plus `Name = fieldName` (`:22-23`), but **`Key` is nullable** — rows created by users at run time have `Key == null` and only a `Name`. `Equals` falls back to base identity when keys are null (`:68-73`); `Name` becomes readonly once `Key` has text (`:128-134`); `ToString() => Key ?? Name` (`:107-108`). A static ctor auto-registers `DescriptionManager.DefaultDescriptionOptions += DescriptionManager_IsSymbolContainer` so any static class holding `SemiSymbol` fields gets `DescriptionOptions.Members` for free (`:91-102`). `SemiSymbolLogic<T>` (`/Signum/Basics/SemiSymbolLogic.cs`) filters `Where(a => a.Key.HasText())` (`:39`, `:109`) so user rows are never treated as missing/deleted.

`PermissionSymbol` is the textbook consumer: `PermissionLogic` keeps a `HashSet<PermissionSymbol>` filled by `RegisterPermissions`/`RegisterTypes` (reflection over a static class, `/Signum/Basics/PermissionLogic.cs:14-51`) and forwards it: `SymbolLogic<PermissionSymbol>.Start(sb, () => RegisteredPermission.ToHashSet())` (`:33`).

### 4.5 `OperationLogic`

**The registry** (`/Signum/Operations/OperationLogic.cs:30-44`):

```csharp
static Polymorphic<Dictionary<OperationSymbol, IOperation>> operations =
    new Polymorphic<Dictionary<OperationSymbol, IOperation>>(PolymorphicMerger.InheritDictionaryInterfaces, typeof(IEntity));

static ResetLazy<FrozenDictionary<OperationSymbol, List<Type>>> operationsFromKey = new(() =>
    (from t in operations.OverridenTypes
     from d in operations.GetDefinition(t)!.Keys
     group t by d into g
     select KeyValuePair.Create(g.Key, g.ToList())).ToFrozenDictionaryEx());
```

`Polymorphic<T>` (`/Signum.Utilities/Polymorphic.cs:80-180`) walks `type.BaseType` recursively and caches the merged result per concrete type (`:151-169`). `InheritDictionaryInterfaces` (`:45-75`) merges base-class dict + own dict (own wins) + interface dicts for keys not otherwise present, throwing on ambiguity between two interfaces. Lookups: `TryFindOperation` (`:639-642`), `FindOperation` throwing `"Operation '{0}' not found for type {1}"` (`:631-637`), `Find<T>` which additionally validates the kind and tells you which method to use instead (`:615-629`).

**Invocation entry points** (`:472-613`) come in two parallel families. Strongly-typed extension methods for C#: `Execute<T>` (`:473`), `ExecuteLite<T>` (`:488`), `CanExecute<T>` (`:506`), `Delete<T>` (`:537`), `DeleteLite<T>` (`:522`), `Construct<T>` (`:558`), `ConstructFrom<F,T>` (`:568`), `ConstructFromLite<F,T>` (`:582`), `ConstructFromMany<F,T>` (`:605`). And untyped `Service*` overloads taking a raw `OperationSymbol`, used by the HTTP layer: `ServiceExecute` (`:481`), `ServiceExecuteLite` (`:497`), `ServiceCanExecute` (`:513`, multi at `:445`), `ServiceDelete` (`:530`/`:544`), `ServiceConstruct` (`:552`), `ServiceConstructFrom` (`:576`), `ServiceConstructFromLite` (`:590`), `ServiceConstructFromMany` (`:598`). **`Service*` is the CLI-relevant family: it accepts a string-resolved symbol and untyped args.**

The lite/entity split enforces `CanBeModified`: `AssertLite` throws `"Operation {0} is not allowed for Lites"` (`:676-683`); `AssertEntity` throws `"Operation {0} needs a Lite or a clean entity, but the entity has changes"` (`:685-697`).

**Save gating** (`:295-304`), hooked at `:118`:

```csharp
static void EntityEventsGlobal_Saving(Entity ident)
{
    if (ident.IsGraphModified && EntityKindCache.RequiresSaveOperation(ident.GetType())
        && !AllowSaveGlobally && !IsSaveAllowedInContext(ident.GetType()))
        throw new InvalidOperationException("Saving '{0}' is controlled by the operations. Use using(OperationLogic.AllowSave<{0}>()) or execute {1}"...);
}
```

The scope is a thread-local `ImmutableStack<Type>` pushed by `AllowSave<T>()` / `AllowSave(Type)` / `AllowSave(List<Type>)` (`:46-77`), which every operation body opens around itself.

**Authorization hook** (`:306-348`):

```csharp
public static event SurroundOperationHandler? SurroundOperation;
public static event AllowOperationHandler? AllowOperation;   // (symbol, entityType, inUserInterface, entity) => bool

public static bool OperationAllowed(OperationSymbol operationSymbol, Type entityType, bool inUserInterface, Entity? entity)
    => AllowOperation != null ? AllowOperation(operationSymbol, entityType, inUserInterface, entity) : true;
```

`AssertOperationAllowed` throws `UnauthorizedAccessException` (`:341-347`). **Signum core ships no implementation** — the only subscriber is `/Extensions/Signum.Authorization/Rules/OperationAuthLogic.cs:26` (impl `:93-111`). **Bug worth flagging:** `AllowOperation` is invoked as a plain multicast delegate, so **only the last subscriber's return value wins** (`:326-327`) — unlike `PermissionLogic.IsAuthorizedString` which explicitly loops `GetInvocationListTyped()` (`/Signum/Basics/PermissionLogic.cs:64-74`). `SurroundOperation` is combined correctly via `Disposable.Combine` (`:311-314`).

**Logging.** `OperationLogEntity` (`/Signum/Operations/OperationLog.cs:5-55`): `[ImplementedByAll] Target`, `[ImplementedByAll] Origin`, `OperationSymbol Operation`, `Lite<IUserEntity> User`, `Start`, `End?`, computed `Duration` (ms) via `ExpressionField`, `Lite<ExceptionEntity>? Exception`, plus an `[Ignore]`d `temporalTarget` so handlers can see the unsaved instance (`:43-54`). Writes funnel through (`OperationLogic.cs:876-885`):

```csharp
public static Func<OperationLogEntity, bool> LogOperation = (request) => true;
public static void SaveLog(this OperationLogEntity log)
{
    if (!LogOperation(log)) return;
    using (ExecutionMode.Global()) log.Save();
}
```

Query-side helpers registered as `[AutoExpressionField]` extensions: `e.OperationLogs()`, `e.PreviousOperationLog()` (system-versioned period aware), `e.LastOperationLog()`, `o.Logs()` (`:13-28`), surfaced as query tokens at `:113-118`. `RegisterPreviousLog<T>` is auto-registered for every `SystemVersioned` table at `SchemaCompleted` (`:201-219`). Purging is wired into `ExceptionLogic.DeleteLogs` (`:127`, impl `:222-239`).

**`OperationLogic.Start(sb)`** (`:84-132`):

```csharp
public static void Start(SchemaBuilder sb)
{
    if (sb.AlreadyDefined(MethodInfo.GetCurrentMethod())) return;
    sb.Include<OperationLogEntity>().WithIndex(a => a.Start).WithQuery(() => lo => new { ... });
    SymbolLogic<OperationSymbol>.Start(sb, () => RegisteredOperations);
    sb.Include<OperationSymbol>().WithQuery(() => os => new { Entity = os, os.Id, os.Key });
    QueryLogic.Expressions.Register((OperationSymbol o) => o.Logs(), OperationMessage.Logs);
    sb.Schema.EntityEventsGlobal.Saving += EntityEventsGlobal_Saving;
    sb.Schema.EntityEvents<OperationSymbol>().PreDeleteSqlSync += Operation_PreDeleteSqlSync;
    sb.Schema.EntityEvents<TypeEntity>().PreDeleteSqlSync += Type_PreDeleteSqlSync;         // Target column
    sb.Schema.EntityEvents<TypeEntity>().PreDeleteSqlSync += Type_PreDeleteSqlSync_Origin;  // Origin column
    sb.Schema.SchemaCompleted += OperationLogic_Initializing;
    sb.Schema.SchemaCompleted += () => RegisterCurrentLogs(sb.Schema);
    ExceptionLogic.DeleteLogs += ExceptionLogic_DeleteLogs;
    OperationsContainerToken.GetEligibleTypeOperations = ...;
    OperationToken.IsAllowedExtension = ...;
    OperationToken.BuildExtension = ...;
}
```

Key detail: `SymbolLogic<OperationSymbol>.Start` is handed a **lazy** closure over `operations.OverridenValues.SelectMany(a => a.Keys)` (`:41-44`), so operations registered later in other `Start` methods still get synchronized. `OperationLogic_Initializing` (`:241-269`) is the startup validation described in §1.8.

The HTTP surface is `/Signum/API/Controllers/OperationController.cs:17-258` — `api/operation/construct | constructFromEntity | constructFromLite | executeEntity | executeLite | executeLiteWithProgress | deleteEntity | deleteLite | constructFromMany | constructFromMultiple | executeMultiple | deleteMultiple / {operationKey}`. The string `operationKey` is resolved and authorized in one step by `BaseOperationRequest.ParseOperationAssert` (`:138-145`): `SymbolLogic<OperationSymbol>.ToSymbol(operationKey)` then `OperationLogic.AssertOperationAllowed(..., inUserInterface: true, ...)`.

### 4.6 `ArgsExtensions` — untyped args

`/Signum/Operations/ArgsExtensions.cs` (106 lines total). There is **no `OperationArgs` type**; args are always a bare `object?[]?`.

- `GetArg<T>()` (`:8-11`) — `args!.SmartConvertTo<T>().SingleEx(...)`; throws if 0 or >1 match.
- `TryGetArgC<T>() where T : class` (`:15-18`) — `SingleOrDefaultEx`.
- `TryGetArgS<T>() where T : struct` (`:20-28`) — nullable variant.
- `AppendArg(this object?[]?, object?)` (`:30-39`).

**Matching is by type, not position** (`ArgsExtensions.md:4-8`: "just one element of each type should be added"; for two of the same type, define a DTO). The engine is `SmartConvertTo<T>` (`:41-89`), which coerces more than the docs admit: exact `is T` with `DateTime` passed through `dt.FromUserInterface()` (`:48-52`); `string` → enum via `Enum.Parse` when `Enum.IsDefined` (`:54-55`); numeric → numeric via `ReflectionTools.ChangeType` (`:56-57`); date-ish → date-ish (`:58-65`); `List<object>` → `List<S>`/`S[]` **only if every element converted** (`:66-87`).

Rule 5 is what makes JSON args work. `OperationController.ConvertObject` (`:164-199`) turns JSON into `string`/`decimal`/`bool`/`Lite<Entity>` (detected by an `EntityType` property)/`ModifiableEntity` (detected by `Type`)/`List<object>`, then relies on coercion. `RegisterCustomOperationArgsConverter(operationSymbol, converter)` (`:157-162`) is the extension point. **Every JSON number arrives as `decimal`**, so `args.GetArg<int>()` depends on coercion rule 3.

**Doc drift:** `ArgsExtensions.md:16` shows `this IEnumerable<object>` signatures; the real ones are `this object?[]?`.

### 4.7 Bugs and oddities found in the Operations layer

- **Exception-log bug repeated 4×.** In the `catch` blocks of `Construct` (`Graph.cs:113-123`), `ConstructFrom` (`:312-322`), `ConstructFromMany` (`:490-499`) and `Delete` (`:833-842`), a `newLog` carrying `Exception = exLog.ToLite()` is built and then **`log.SaveLog()` is called instead of `newLog.SaveLog()`** — the local is discarded and the saved row has no exception reference. Only `Execute` does it right (`:676`). The compiler doesn't complain because `newLog` is "used" by its initializer.
- **Constructors swallow their own exception logging.** In `Construct`/`ConstructFrom`/`ConstructFromMany` the entire exception-logging block is inside `if (LogAlsoIfNotSaved)` (`:102`, `:301`, `:480`), so with the default `false` a failed constructor leaves **no** `OperationLogEntity` at all.
- **Dead condition** in `TypeOperationsAndConstructors` (`OperationLogic.cs:716-721`): `where op.OperationType == ConstructorFrom && op.OperationType == ConstructorFromMany` — always false; almost certainly meant to be `||`, so the `returnTypeOperations` half of the union is always empty.
- **`Graph<T,S>.EnterState`/`ExitState` are dead** (`GraphState.cs:323-324`), never read anywhere. The vestige shows in `Graph<T,S>.Delete.OnDelete`, which computes `S oldState = GetStateFunc(entity);` and does nothing with it (`:287-293`).
- **`Symbol.CallRetrieved` is subscribed but never invoked.** `SymbolLogic<T>.Start` registers a handler to lazily repair a `FieldInfo` (`SymbolLogic.cs:84-89`) but nothing calls `Symbol.CallRetrieved(this)` — whereas `SemiSymbol.NiceToString()` does (`SemiSymbol.cs:62-66`). So `Symbol.NiceToString()` (`Symbol.cs:82-85`) will `NullReferenceException` on a symbol retrieved while `avoidCache` was set (i.e. during synchronization).
- **`StartParameters` as a global "degrade gracefully" switch** (`/Signum.Utilities/StartParameters.cs:6-12`): two nullable `List<Exception>` statics that, when initialized, convert hard startup failures into collected exceptions — `IgnoredCodeErrors` for duplicated symbol keys (`Symbol.cs:28-35`) and missing save operations (`OperationLogic.cs:265-268`), `IgnoredDatabaseMismatches` for code-vs-DB symbol drift (`SymbolLogic.cs:106-110`). Designed for blue/green deploys and dynamic code.
- **`[AutoInit]` fields are `null` in any consumer that reads the assembly without `Signum.MSBuildTask` having run** (Roslyn analyzers, some IL tools). The whole error-message strategy for this is `AutoInitAttribute.ArgumentNullException`, raised from every operation ctor (`Graph.cs:35`, `:204`, `:393`, `:577`, `:755`).

---

## 5. DynamicQuery — the string-addressable query language

This is the layer that matters most for a CLI, because **a whole query is expressible as plain data: a query key, a list of token strings, filter operations, values, orders and a pagination record.** No C# expression trees at the boundary.

### 5.1 The three-layer model

```
QueryLogic.Queries  (DynamicQueryContainer)      /Signum/Basics/QueryLogic.cs:19
   └── DynamicQueryBucket per queryName          /Signum/DynamicQuery/DynamicQueryContainer.cs:246
         └── IDynamicQueryCore                   /Signum/DynamicQuery/DynamicQueryCore.cs
               ├── AutoDynamicQueryCore<T>       /Signum/DynamicQuery/AutoDynamicQuery.cs:6   (wraps an IQueryable)
               └── ManualDynamicQueryCore<T>     /Signum/DynamicQuery/ManualDynamicQueryCore.cs
```

`QueryLogic` (`/Signum/Basics/QueryLogic.cs:9-20`):

```csharp
public static class QueryLogic
{
    static ResetLazy<FrozenDictionary<string, object>> queryNamesLazy = null!;   // :11
    public static FrozenDictionary<string, object> QueryNames => queryNamesLazy.Value;  // :12
    public static DynamicQueryContainer Queries { get; } = new DynamicQueryContainer();  // :19
    public static ExpressionContainer  Expressions { get; } = new ExpressionContainer(); // :20
}
```

**A query name is an `object`**, not a string — either a `Type` (the common case) or an `Enum` value (a "named query", an alternative projection of the same entity). The mapping to/from strings is:

```csharp
public static string GetKey(object queryName)                            // /Signum/DynamicQuery/QueryUtils.cs:12-16
    => queryName is Type t ? Reflector.CleanTypeName(EnumEntity.Extract(t) ?? t) : queryName.ToString()!;
public static string GetNiceName(object queryName)                       // :18-24
public static object  ToQueryName(string queryKey)                       // /Signum/Basics/QueryLogic.cs:146
public static object? TryToQueryName(string queryKey)                    // :151
```

So on the wire a query is identified by the **clean type name** (`"Album"`, not `"AlbumEntity"`, not the full name). `queryNamesLazy` is a `GlobalLazy` (`QueryLogic.cs:99`) loaded during `Schema.Initialize()` (`:84`) — **the string→queryName mapping needs the DB-backed init to have run.**

Registration — the recommended fluent form (`/Signum/DynamicQuery/DynamicQueries.md:18-38`):

```csharp
sb.Include<OrderEntity>()
  .WithQuery(() => o => new
  {
      Entity = o,          // <-- the magic column name, see ColumnDescription.Entity
      o.Id, o.State, o.Customer, o.Employee, o.OrderDate,
  });
```

The projection **must be an anonymous type** — `AutoDynamicQueryCore` throws `"Query should be an anoynmous type"` otherwise (`/Signum/DynamicQuery/AutoDynamicQuery.cs:18`). Each member becomes a `ColumnDescriptionFactory` with metadata harvested from the metadata pipeline (`:20-21`).

### 5.2 `QueryDescription` / `ColumnDescription` — the schema of a query

`/Signum/DynamicQuery/QueryDescription.cs`:

```csharp
public class QueryDescription                                 // :3
{
    public object QueryName { get; private set; }
    public List<ColumnDescription> Columns { get; private set; }
}

public class ColumnDescription                                // :15
{
    public const string Entity = "Entity";                    // :17  the reserved name
    public string Name { get; internal set; }                  // :18
    public Type Type { get; internal set; }                    // :19
    public string? Unit { get; internal set; }                 // :20
    public string? Format { get; internal set; }               // :21
    public Implementations? Implementations { get; internal set; }  // :22
    public PropertyRoute[]? PropertyRoutes { get; internal set; }   // :23
    public string DisplayName { get; internal set; }           // :24
    public bool IsEntity => Name == Entity;                    // :33-36
}
```

`ColumnDescriptionFactory` (`/Signum/DynamicQuery/ColumnDescriptionFactory.cs:3-63`) is the builder. Setting `PropertyRoutes` **auto-derives** `Format`, `Unit` and `Implementations` from the best route (`:42-51`):

```csharp
var br = this.BestRoute();
Format = br == null ? null : Reflector.GetFormatString(br);
Unit   = br == null ? null : Reflector.GetUnit(br);
if (Implementations == null)
    Implementations = Signum.Entities.Implementations.Combine(propertyRoutes.Select(a => a.TryGetImplementations()));
```

`QueryDescription` is **filtered and localized per user** — `DynamicQueryContainer.QueryDescription(queryName)` (`/Signum/DynamicQuery/DynamicQueryContainer.cs:162`) → `DynamicQueryBucket.GetDescription()` (`:282`), which drops columns the caller isn't allowed to see. That's also enforced again at result time: `ResultTable`'s ctor keeps only `c.Token.IsAllowed() == null` (`/Signum/DynamicQuery/Requests/ResultTable.cs:53`).

For manual queries, metadata is **not** inherited and must be supplied explicitly with `ColumnPropertyRoutes(a => a.Id, PropertyRoute.Construct(...), ...)` (`DynamicQueries.md:188-204`).

### 5.3 `QueryToken` — the token language

`/Signum/DynamicQuery/Tokens/QueryToken.cs:11`. A token is a node in a chain (`Parent` at `:217`), and the **wire form is `FullKey()`**:

```csharp
public string FullKey()                    // QueryToken.cs:667-673
{
    if (Parent == null) return Key;
    return Parent.FullKey() + "." + Key;
}
public bool Equals(QueryToken? other)      // :680-683
    => other != null && other.QueryName.Equals(QueryName) && other.FullKey() == FullKey();
```

So token identity **is** its dotted string plus the query name. Abstract surface (`:15-217`): `ToString()`, `NiceName()`, `Format`, `Unit`, `Type`, `DateTimeKind`, `Key`, `IsGroupable` (`:88`), `AutoExpand` (`:23`)/`HideInAutoExpand` (`:32`), `SubTokensOverride(options)` (`:137`), `QueryName` (`:139`, inherited from parent), `BuildExpression(context, searchToArray)` (`:166`) / `BuildExpressionInternal` (`:190`), `GetPropertyRoute()` (`:192`), `GetImplementations()` (`:212`), `IsAllowed()` (`:213`), `Clone()` (`:215`), `Priority` (`:13`).

**Parsing — the exact grammar** (`/Signum/DynamicQuery/QueryUtils.cs:370-394`):

```csharp
public static readonly Regex SplitRegex = new Regex(@"(?<!\[[^\]]*)\.(?![^\[]*\])");   // :370

public static QueryToken Parse(string tokenString, QueryDescription qd, SubTokensOptions options)
{
    if (string.IsNullOrEmpty(tokenString)) throw new ArgumentNullException(nameof(tokenString));
    string[] parts = SplitRegex.Split(tokenString);            // dots NOT inside brackets
    QueryToken? result = SubToken(null, qd, options, parts.FirstEx());
    if (result == null)
        throw new FormatException("Column '{0}' not found on query {1}"...);
    foreach (var part in parts.Skip(1))
        result = SubToken(result, qd, options, part)
              ?? throw new FormatException("Token with key '{0}' not found on token '{1}' of query {2}"...);
    return result;
}
```

`TryParse(tokenString, qd, options, out error, out lastParsedToken)` (`:396-430`) is the CLI-friendly variant: it returns the deepest token it *did* parse plus a human-readable error. Pair it with `QueryDescription.NextAlternatives(qd, options, partial)` (`:506-509`) which lists the legal next keys — **that is a ready-made tab-completion primitive.**

The **first** segment must be a `ColumnDescription.Name` from the `QueryDescription` (`SubTokenBasic`, `:345-360`); subsequent segments are resolved by `token.SubTokenInternal(key, options)` (`QueryToken.cs:226`). `SubTokensOptions` gates which token families are legal (`QueryUtils.cs:717-734`):

```csharp
public enum SubTokensOptions
{
    CanAggregate = 1, CanAnyAll = 2, CanElement = 4, CanOperation = 8, CanToArray = 16,
    CanSnippet = 32, CanManual = 64, CanTimeSeries = 128, CanNested = 256,
    All = CanAggregate | CanAnyAll | CanElement | CanOperation | CanToArray | CanSnippet | CanManual | CanTimeSeries | CanNested,
}
```

**Token catalogue with the literal `Key` each one contributes** (all under `/Signum/DynamicQuery/Tokens/`):

| Token class | `Key` | Source |
|---|---|---|
| `ColumnToken` | the `ColumnDescription.Name` | `ColumnToken.cs:24-27` |
| `EntityPropertyToken` | `PropertyInfo.Name` | `EntityPropertyToken.cs:58-61` |
| `EntityToStringToken` | `"ToString"` | `EntityToStringToken.cs:26-29` |
| `EntityTypeToken` | `"[EntityType]"` | `EntityTypeToken.cs:28-31` |
| `AsTypeToken` | `"(CleanTypeName)"` | `AsTypeToken.cs:31-34` |
| `CollectionElementToken` | `"Element"` / `"Element2"` / `"Element3"` | `CollectionElementToken.cs:60-63`, enum `:181-188` |
| `CollectionAnyAllToken` | `"Any"` / `"All"` / `"NotAny"` / `"NotAll"` | `CollectionAnyAllToken.cs:39-42`, enum `:163-169` |
| `CollectionNestedToken` | `"Nested"` | `CollectionNestedToken.cs:33-36` |
| `CollectionToArrayToken` | `ToArrayType.ToString()` | `CollectionToArrayToken.cs:39-42` |
| `CountToken` | `"Count"` | `CountToken.cs:27-30` |
| `AggregateToken` | `Function + [Distinct] + [op] + [value]` — see below | `AggregateToken.cs:152-171` |
| `DateToken` | `"Date"` | `DateToken.cs:40-43` |
| `DateTimeSpecialTokens` | `Year`, `Month`, `Day`, `Hour`, … (`Name`, with `0`→step) | `DateTimeSpecialTokens.cs:124-132` |
| `DecimalSpecialTokens` | `"Step<size>"` (`.`→`_`) and `"x<multiplier>"` | `DecimalSpecialTokens.cs:40-43`, `:138-141` |
| `HasValueToken` | `"HasValue"` | `HasValueToken.cs:50-53` |
| `StringSnippetToken` | (snippet keyword) | `StringSnippetToken.cs` |
| `FullTextRankToken` | `"Rank"` | `FullTextRankToken.cs:19` |
| `IndexerContainerToken` | `"[Prefix]"`, then `"[value]"` | `IndexerContainerToken.cs:31`, `:109` |
| `ExtensionToken` | the registered key (from `ExpressionContainer`) | `ExtensionToken.cs:58` |
| `OperationToken` / `OperationsContainerToken` | registered key | `OperationToken.cs:37` |
| `ManualToken` / `ManualContainerToken` | registered key | `ManualToken.cs:36`, `ManualContainerToken.cs:42` |
| `MListElementPropertyToken` | property name of the MList row | `MListElementPropertyToken.cs` |
| `TimeSeriesToken` | `TimeSeriesToken.KeyText` | referenced `QueryUtils.cs:272` |
| `PgTsVectorColumnToken`, `VectorColumnToken`, `VectorDistanceToken`, `PgTsRankToken` | full-text / vector search tokens | `Tokens/` |

`AggregateToken.Key` is composed (`AggregateToken.cs:152-171`):

```csharp
var distinct = this.Distinct ? "Distinct" : null;
var op = FilterOperation == null ? null
       : FilterOperation == FilterOperation.EqualTo   ? ""
       : FilterOperation == FilterOperation.DistinctTo ? "Not"
       : FilterOperation.Value.ToString();
var value = FilterOperation == null ? null : (Value == null ? "Null" : Value.ToString());
return AggregateFunction.ToString() + distinct + op + value;
```

so you get `"Count"`, `"Sum"`, `"Min"`, `"Max"`, `"Average"`, `"CountDistinct"`, `"CountNotNull"`, `"CountNull"`, `"CountTrue"`, `"CountFalse"`, `"Count<EnumValue>"`, … Which aggregates are offered depends on the `FilterType` of the parent token (`QueryUtils.AggregateTokens`, `:292-343`): numeric/boolean get Average/Sum/Min/Max; DateTime/Time get Min/Max; anything gets `CountNotNull`/`CountNull`; groupable tokens get `CountDistinct`; enums and booleans get a `Count<value>` per value.

So a real token string looks like: `Customer.Address.City`, `Entity.ToString`, `Lines.Element.Product.UnitPrice`, `Lines.Any.Product.Name`, `OrderDate.Year`, `Sum` (on the query root), `Lines.Element.SubTotalPrice.Sum` (grouped), `Customer.(PersonEntity).FirstName` (cast), `Customer.[EntityType]`.

**Token-graph discovery.** `SubTokensBase(type, options, implementations)` (`QueryToken.cs:278-364`) enumerates children, and `SubTokensBaseProperties` (`:655-665`) is where entity properties and **mixin properties** are folded together:

```csharp
var result = from p in Reflector.PublicInstancePropertiesInOrder(type)
             where Reflector.QueryableProperty(type, p)
             select (QueryToken)new EntityPropertyToken(this, p, (normalizedPr?.Add(p))!);

var mixinProperties = from mt in MixinDeclarations.GetMixinDeclarations(type)
                      from p in Reflector.PublicInstancePropertiesInOrder(mt)
                      where Reflector.QueryableProperty(mt, p)
                      select (QueryToken)new EntityPropertyToken(this, p, (normalizedPr?.Add(mt).Add(p))!);
return result.Concat(mixinProperties);
```

Note `Reflector.QueryableProperty(type, p)` (`/Signum/Entities/Reflection/Reflector.cs:367`) is the gate — a property is queryable if it has a backing field, or an `[ExpressionField]`, or `[QueryableProperty]`, and is not `[HiddenProperty]`.

Type-specific token generators: `DateTimeProperties` (`QueryToken.cs:424`), `DateTimeOffsetProperties` (`:488`), `TimeSpanProperties` (`:498`), `TimeOnlyProperties` (`:547`), `DateOnlyProperties` (`:565`), `StepTokens` (`:583`), `CollectionProperties` (`:601`), `StringTokens` (`:410`), `TsVectorColumns` (`:366`), `VectorColumns` (`:395`).

Structural helpers used for validation: `HasToArray()` (`:626`), `HasAllOrAny()` (`:631`), `HasNested()` (`:636`), `HasElement()` (`:641`), `HasCollectionToArray()` (`:646`), `IsCollection(type)` (`:717`), `ContainsKey(key)` (`:759`), `Dominates(t)` (`:764`).

### 5.4 Filters, columns, orders, pagination

**`Filter`** is an abstract class (`/Signum/DynamicQuery/Requests/Filter.cs:18`) with two concrete shapes:

```csharp
public class FilterCondition : Filter                          // :264
{
    public QueryToken Token { get; }
    public FilterOperation Operation { get; }
    public object? Value { get; }
    public FilterCondition(QueryToken token, FilterOperation operation, object? value)
    {
        this.Token = token; this.Operation = operation;
        this.Value = ReflectionTools.ChangeType(value, GetValueType(Token, operation));   // :274
    }
    public static Type GetValueType(QueryToken token, FilterOperation operation)          // :278-291
    {
        if (operation.IsTsQuery()) return typeof(string);
        if (operation == FilterOperation.SmartSearch) return typeof(string);
        if (operation.IsList() || operation.IsPair())
            return typeof(IEnumerable<>).MakeGenericType(token.Type.Nullify());
        return token.Type;
    }
}

public class FilterGroup : Filter                               // :125
{
    public FilterGroupOperation GroupOperation { get; }   // And | Or   (:12-16)
    public QueryToken? Token { get; }                     // optional Any/All scope anchor
    public List<Filter> Filters { get; }
}
```

`FilterGroup` nests arbitrarily, so **arbitrary boolean trees are expressible as data**. The optional `Token` on a group is the `Any`/`All` collection anchor: `GetExpression` finds the deepest un-replaced `CollectionAnyAllToken` in the token chain and wraps the whole group in a single `.Any(...)`/`.All(...)` (`:159-172`, `GetExpressionWithAnyAll` `:40-68`). That is how "the same collection element must satisfy A **and** B" is expressed.

**`FilterOperation`** (`Filter.cs:558-617`) — the complete list, with the `[Description]` string that is the user-facing name:

`EqualTo` ("equal to"), `DistinctTo` ("distinct to"), `GreaterThan`, `GreaterThanOrEqual`, `LessThan`, `LessThanOrEqual`, `Contains`, `StartsWith`, `EndsWith`, `Like`, `NotContains`, `NotStartsWith`, `NotEndsWith`, `NotLike`, `IsIn` ("is in"), `IsNotIn` ("is not in"), `ComplexCondition` (SQL Server full-text), `FreeText` (SQL Server full-text), `TsQuery`, `TsQuery_Plain`, `TsQuery_Phrase`, `TsQuery_WebSearch` (Postgres), `SmartSearch` (vector search with embeddings), `Between`, `BetweenNoEnd`.

**`FilterType`** (`Filter.cs:620-635`): `Integer, Decimal, String, DateTime, Time, Lite, Embedded, Model, Boolean, Enum, Guid, TsVector, Vector`. Derived from the token's CLR type by `QueryUtils.TryGetFilterType(type)` (`/Signum/DynamicQuery/QueryUtils.cs:36-99`) — note `Guid`, `DateOnly`/`DateTimeOffset`→`DateTime`, `TimeSpan`/`TimeOnly`→`Time`, `NpgsqlTsVector`→`TsVector`, `Pgvector.Vector`→`Vector`, and both `Lite<T>` **and** `IEntity` map to `FilterType.Lite`.

**Which operations are legal for a token** — `QueryUtils.GetFilterOperations(token)` (`:101-113`) looks up a static `Dictionary<FilterType, ReadOnlyCollection<FilterOperation>>` (`:115-255`), and adds `FreeText`/`ComplexCondition` when the token's route has a full-text index (`:107-110`). E.g. `FilterType.String` allows `Contains, EqualTo, StartsWith, EndsWith, Like, NotContains, DistinctTo, NotStartsWith, NotEndsWith, NotLike, IsIn, IsNotIn` (`:118-132`) — note `Contains` is deliberately **first**, i.e. the UI default for strings.

Operation classifiers (`:688-716`): `IsList()` (`IsIn`/`IsNotIn`), `IsPair()` (`Between`/`BetweenNoEnd`), `IsListOrPair()`, `IsTsQuery()`, `IsSmartSearch()`. `IsIn`/`IsNotIn` expect an `IEnumerable<TokenType?>`; **filtering by null via `IsIn` is explicitly no longer supported** and throws `"Filtering by null using IsIn / IsNotIn is no longer supported"` (`Filter.cs:~365`). `Between`/`BetweenNoEnd` expect a two-element list `[min, max]` where either may be null.

**`Column`** (`/Signum/DynamicQuery/Requests/Column.cs:5-45`):

```csharp
public class Column
{
    public string? DisplayName { get; set; }
    public QueryToken Token { get; }
    public bool IsVisible = true;
    public string Name => Token.FullKey();
    public Type Type => Token.Type;
    public Implementations? Implementations => Token.GetImplementations();
    public string? Format => Token.Format;
    public string? Unit   => Token.Unit;
}
public enum ColumnOptionsMode { Add, Remove, ReplaceAll, InsertStart, ReplaceOrAdd }   // :48-55
public enum CombineRows { EqualValue, EqualEntity }                                     // :58-62
```

**`Order`** (`/Signum/DynamicQuery/Requests/Order.cs:6-45`): `QueryToken Token` + `OrderType { Ascending, Descending }`. `ToString()` is `"{FullKey} {OrderType}"`.

**`Pagination`** (`/Signum/DynamicQuery/Requests/QueryRequest.cs:248-321`) — three subclasses:

| Mode | Class | Fields | `ToString()` |
|---|---|---|---|
| `All` | `Pagination.All` (`:264`) | — | `"All"` |
| `Firsts` | `Pagination.Firsts` (`:273`) | `TopElements` (default 20, `:275`) | `"First 20"` |
| `Paginate` | `Pagination.Paginate` (`:292`) | `ElementsPerPage`, `CurrentPage` (both must be > 0, `:296-301`) | `"Paginate 50 (Page = 3)"` |

`Paginate.StartElementIndex()`, `EndElementIndex(rows)`, `TotalPages(total)` (`:309-311`) and `MaxElementIndex` (`:316`) do the arithmetic. `ToBigPage()` (`:256-262`) collapses page N into "first N*perPage" — used when concatenating manual queries.

**Validation before you build a request** — `QueryUtils` (`:432-540`), all returning `string?` (null = OK):

- `CanFilter(token)` (`:432-445`): no collections (unless `string`/`tsvector`) — "continue the sequence"; no `OperationsContainerToken`/`OperationToken`/`ManualContainerToken`/`ManualToken`/`IndexerContainerToken`.
- `CanColumn(token)` (`:446-468`): no collections, no `Vector`, no `Any`/`All`, no container tokens.
- `CanOrder(token)` (`:511-540`): no embeddeds (unless an `OrderAdapter` is registered), no collections, no `Vector`, no `ToArray`, no `Any`/`All`, no container tokens.

`QueryUtils.RegisterOrderAdapter<T,V>(orderByMember)` / `OrderAdapters` / `CreateOrderLambda` (`:470-503`) let you make an otherwise-unorderable type sortable.

### 5.5 The request objects

`/Signum/DynamicQuery/Requests/QueryRequest.cs`:

```csharp
public abstract class BaseQueryRequest                       // :7
{
    public required object QueryName { get; set; }
    public required List<Filter> Filters { get; set; }
    public string? QueryUrl { get; set; }
    public abstract HashSet<QueryToken> AllTokens();
    public abstract string Dump();                            // human-readable, great for a CLI --explain
}

public class QueryRequest : BaseQueryRequest                 // :42
{
    public bool GroupResults { get; set; }
    public required List<Column> Columns { get; set; }
    public required List<Order> Orders { get; set; }
    public required Pagination Pagination { get; set; }
    public SystemTimeRequest? SystemTime { get; set; }
}
```

Five request shapes in total:

| Class | Line | Returns | Extra fields |
|---|---|---|---|
| `QueryRequest` | `:42` | `ResultTable` | `GroupResults`, `Columns`, `Orders`, `Pagination`, `SystemTime` |
| `QueryValueRequest` | `:323` | a single scalar (or list) | `ValueToken?`, `MultipleValues`, `SystemTime` |
| `UniqueEntityRequest` | `:372` | `Lite<Entity>?` | `Orders`, `UniqueType` |
| `QueryEntitiesRequest` | `:413` | `IQueryable<Lite<Entity>>` / `IQueryable<Entity>` | `Orders`, `Count?` |
| `QueryGroupRequest` | (folded into `QueryRequest` via `GroupResults`) | — | — |

Useful derived helpers on every request: `AllTokens()` (`:84-88`), `Multiplications()` → `List<CollectionElementToken>` (`:81`), `TableFilters()` (`:82`), `Dump()` (`:54-66`), `Clone()` (`:90`), `CombineFullTextFilters()` (`:101-118`). `AssertNeasted()` (`:68-79`) enforces that any `Nested` token used in a filter/order is also selected as a column.

`SystemTimeRequest` (`:138-207`) is the temporal-query payload: `mode` (`AsOf | Between | ContainedIn | All | TimeSeries`, `:210-217`), `joinMode` (`Current | FirstCompatible | AllCompatible`, `:234-239`), `startDate`, `endDate`, and for time series `timeSeriesStep`, `timeSeriesUnit` (`Year…Millisecond`, `:220-231`), `timeSeriesMaxRowsPerStep`. `ToSystemTime()` (`:195-206`) converts to the engine's `SystemTime`.

Execution entry points on `DynamicQueryContainer` (`/Signum/DynamicQuery/DynamicQueryContainer.cs`):

```csharp
public QueryDescription QueryDescription(object queryName)              // :162
public ResultTable ExecuteQuery(QueryRequest request)                    // :112
public Task<ResultTable> ExecuteQueryAsync(QueryRequest, CancellationToken) // :123
public object? ExecuteQueryValue(QueryValueRequest request)              // :134
public Lite<Entity>? ExecuteUniqueEntity(UniqueEntityRequest request)    // :148
public IQueryable<Lite<Entity>> GetEntitiesLite(QueryEntitiesRequest)    // :167
public IQueryable<Entity>       GetEntitiesFull(QueryEntitiesRequest)    // :174
public Task<object?[]> BatchExecute(BaseQueryRequest[] requests, CancellationToken)  // :228
public List<object> GetQueryNames()                                      // :223
public List<object> GetAllowedQueryNames(bool fullScreen)                // :211
public Dictionary<object, DynamicQueryBucket> GetTypeQueries(Type entityType)  // :216
public event Func<object, bool, bool>? AllowQuery;                       // :181
public event Func<ExecuteType, object, BaseQueryRequest?, IDisposable?>? QueryExecuted;  // :100
```

`BatchExecute` (`:228`) is notable — **N heterogeneous requests in one round trip**, directly useful for a CLI dashboard command.

### 5.6 Request → LINQ: the `DQueryable` pipeline

`AutoDynamicQueryCore<T>.GetDQueryable` (`/Signum/DynamicQuery/AutoDynamicQuery.cs:94-135`) is the core translation:

```csharp
private DQueryable<T> GetDQueryable(QueryRequest request, out List<Order>? inMemoryOrders)
{
    var columns = request.Columns.Select(a => a.Token).ToHashSet();
    if (!columns.Any(t => t.IsEntity()))
        columns.Add(new ColumnToken(EntityColumnFactory().BuildColumnDescription(), QueryName));  // always add Entity

    var filters = request.Filters.ToList();
    var timeSeriesFilters = filters.Extract(f => f.IsTimeSeries());

    var query = Query
        .ToDQueryable(GetQueryDescription())
        .SelectMany(request.Multiplications(), request.TableFilters())   // one SelectMany per Element token
        .Where(filters);
    ...
}
```

and the whole-request convenience (`/Signum/DynamicQuery/DQueryable.cs:90-101`):

```csharp
public static DEnumerableCount<T> AllQueryOperations<T>(this DQueryable<T> query, QueryRequest request, bool forCombine)
{
    return query
        .SelectMany(request.Multiplications(), request.TableFilters())
        .Where(request.Filters)
        .Select(...)
        .OrderBy(request.Orders, ...)
        .TryPaginate(forCombine ? request.Pagination.ToBigPage() : request.Pagination, request.SystemTime);
}
```

`DQueryable<T>` / `DEnumerable<T>` / `DEnumerableCount<T>` (`DQueryable.cs:61`, `:373`, `:389`) carry a `BuildExpressionContext` alongside an untyped `IQueryable`. The generic parameter exists **only** so that manual queries can be `Concat`-ed with matching columns (`DynamicQueries.md:209`).

`BuildExpressionContext` (`QueryToken.cs:782-840`) is what maps tokens to expressions:

```csharp
public readonly Type ElementType;
public readonly ParameterExpression Parameter;
public readonly Dictionary<QueryToken, ExpressionBox> Replacements;
public readonly List<Filter>? Filters;      // for SubQueries and Snippet keyword detection
public readonly List<Order>?  Orders;
public readonly Pagination?   Pagination;
public LambdaExpression GetEntitySelector();       // :819
public LambdaExpression GetEntityFullSelector();   // :826
```

`ExpressionBox` (`:842-869`) wraps `RawExpression` + `MListElementRoute` + optional `SubQueryContext`.

Dynamic operators available on `DQueryable`/`DEnumerable`: `Select` (`:122`, `:134`, `:139`), `SelectMany(elementTokens, tableFilters)` (`:401`) and per-token (`:583`), `Where(filters)` (`:640`, `:645`, `:667`), `OrderBy(orders, pagination)` (`:712`, `:739`, `:823`), `TryTake(n)` (`:865`), `TryPaginate(pagination, systemTime)`, `Concat` (`:352`, `:362`), `JoinWithFullText` (`:421`), `JoinWithVectorSearch` (`:506`), `SelectManyTimeSeries` (`:885`), `ToResultTable(request)`.

**`Pagination.All` forces in-memory ordering** (`AutoDynamicQuery.cs:116-124`) — the columns and order tokens are unioned into the projection and the sort happens client-side. Worth knowing for a CLI that dumps whole tables.

### 5.7 `ResultTable` — the output shape

`/Signum/DynamicQuery/Requests/ResultTable.cs`:

```csharp
public class ResultColumn                              // :8
{
    public QueryToken Token { get; }
    public int Index { get; internal set; }
    public IList Values { get; }                        // column-oriented!
    public bool CompressUniqueValues { get; set; }
}

public class ResultTable                               // :34
{
    public ResultColumn? EntityColumn { get; }          // :36
    public bool HasEntities => entityColumn != null;    // :38
    public ResultColumn[] Columns { get; }               // :44
    public ResultRow[] Rows { get; }                     // :48
    public ResultColumn[] AllColumns();                  // :50
    public DataTable ToDataTable(DataTableValueConverter? converter = null);  // :66
}
```

Two things to note. (1) **It is column-oriented** — each `ResultColumn` holds an `IList` of values and `ResultRow` is a lightweight `(index, table)` view (`:60`). (2) The `Entity` column is **split out** of `Columns` and exposed separately unless grouping (`:53-54`), and disallowed columns are dropped at this point (`c.Token.IsAllowed() == null`). `ToDataTable(converter)` (`:66`) gives you a flat `System.Data.DataTable` — the obvious CLI/CSV path, with an `InvariantDataTableValueConverter` default.

### 5.8 The HTTP wire format — a ready-made CLI protocol

This is the single most useful artefact for a CLI, because it is already a pure-JSON, string-token protocol. Controller: `/Signum/API/Controllers/QueryController.cs`.

| Endpoint | Line | Body / result |
|---|---|---|
| `GET api/query/description/{queryName}` | `:45-50` | `QueryDescriptionTS` — the columns, each as a `QueryTokenTS` with auto-expanded sub-tokens |
| `GET api/query/queryEntity/{queryName}` | `:52-57` | the `QueryEntity` row |
| `POST api/query/parseTokens` | `:59-74` | `{ queryKey, tokens: string[] }` → `QueryTokenTS[]` **with parents** |
| `POST api/query/subTokens` | `:76-93` | `{ queryKey, token? }` → the legal next tokens |
| `POST api/query/executeQuery/{queryKey}` | `:95-102` | `QueryRequestTS` → `ResultTable` |
| `POST api/query/lites/{queryKey}` | `:104-108` | `QueryEntitiesRequestTS` → `List<Lite<Entity>>` |
| `POST api/query/entities/{queryKey}` | `:110-114` | `QueryEntitiesRequestTS` → `List<Entity>` |
| `POST api/query/queryValue/{queryKey}` | `:116-123` | `QueryValueRequestTS` → a scalar |
| `GET api/query/findLiteLike?types=&subString=&count=` | `:18-24` | autocomplete over `Implementations` (comma-separated clean type names) |
| `GET api/query/allLites?types=` | `:26-38` | all lites; **refuses `EntityData.Transactional` types** (`:33-34`) |

The DTOs (`/Signum/API/Json/FilterJsonConverter.cs`):

```csharp
public class QueryRequestTS                          // :225
{
    public required string queryKey;
    public required bool groupResults;
    public required List<FilterTS> filters;
    public required List<OrderTS> orders;
    public required List<ColumnTS> columns;
    public required PaginationTS pagination;
    public SystemTimeRequest? systemTime;
}
public class ColumnTS     { public required string token; public string? displayName; }   // :144
public class OrderTS      { public required string token; public required OrderType orderType; }  // :301
public class PaginationTS { public PaginationMode mode; public int? elementsPerPage; public int? currentPage; }  // :162
public class FilterConditionTS : FilterTS { public required string token; public FilterOperation operation; public object? value; }  // :79
public class FilterGroupTS     : FilterTS { public FilterGroupOperation groupOperation; public string? token; public required List<FilterTS> filters; }  // :125
```

`FilterJsonConverter.Read` (`:23-49`) discriminates the two filter shapes **structurally**: presence of an `"operation"` property → condition; presence of `"groupOperation"` → group; otherwise `"Impossible to determine type of filter"`. So a CLI can emit exactly:

```json
{
  "queryKey": "Album",
  "groupResults": false,
  "filters": [
    { "token": "Author.Name", "operation": "StartsWith", "value": "Mich" },
    { "groupOperation": "Or", "filters": [
        { "token": "Year", "operation": "GreaterThanOrEqual", "value": 1970 },
        { "token": "Label.Name", "operation": "EqualTo", "value": "Virgin;3" }
    ]}
  ],
  "orders":  [ { "token": "Year", "orderType": "Descending" } ],
  "columns": [ { "token": "Entity" }, { "token": "Name" }, { "token": "Author.Name" } ],
  "pagination": { "mode": "Paginate", "elementsPerPage": 50, "currentPage": 1 }
}
```

**The `SubTokensOptions` differ per slot**, and a CLI must mirror this or it will reject valid tokens:

```csharp
// ColumnTS.ToColumn                                   FilterJsonConverter.cs:149-156
QueryUtils.Parse(token, qd, SubTokensOptions.CanElement | CanToArray | CanSnippet
    | (canAggregate ? CanAggregate : CanOperation | CanManual)
    | (canTimeSeries ? CanTimeSeries : 0));

// FilterConditionTS.ToFilter                          :85-88
SubTokensOptions.CanElement | CanAnyAll | (canAggregate ? CanAggregate : 0) | (canTimeSeries ? CanTimeSeries : 0)

// OrderTS.ToOrder                                     :306-312
SubTokensOptions.CanElement | CanSnippet | (canAggregate ? CanAggregate : 0) | (canTimeSeries ? CanTimeSeries : 0)

// QueryValueRequestTS.ToQueryValueRequest             :210
SubTokensOptions.CanAggregate | SubTokensOptions.CanElement
```

Note `canAggregate` is simply `groupResults` (`:263-265`) — **aggregate tokens are only legal when `groupResults: true`**, and conversely operation/manual tokens are only legal as columns when *not* grouping.

Value coercion (`FilterConditionTS.ToFilter`, `:85-120`): the raw `JsonElement` is deserialized into `FilterCondition.GetValueType(parsedToken, operation)`, with a friendly `"Invalid value when filtering by " + token` on failure (`:98-101`), then `DateTime` values are re-kinded to the token's `DateTimeKind` (`:103-117`). `Lite<T>` values serialize as the `"Type;Id"` key form, `Entity` values as full JSON objects.

`QueryTokenTS` (`QueryController.cs:172-272`) is the token metadata DTO and is exactly what a CLI needs for help/completion output:

```csharp
public required string key;             public required string fullKey;
public required string? toStr;          public required string? niceName;
public QueryTokenType? queryTokenType;  // Aggregate|Element|AnyOrAll|OperationContainer|ToArray|Manual|Nested|Snippet|TimeSeries|IndexerContainer  (:274-286)
public required TypeReferenceTS type;   public FilterType? filterType;
public string? format;                  public string? unit;
public bool isGroupable;                public bool hasOrderAdapter;
public bool preferEquals;               // string + has an index → default to EqualTo not Contains  (:197-200)
public IReadOnlyList<string>? tsVectorFor;
public QueryTokenTS? parent;            public string? propertyRoute;
public bool autoExpand;                 public bool hideInAutoExpand;
public Dictionary<string, QueryTokenTS>? subTokens;
```

`QueryDescriptionTS` (`:139-170`) always injects two synthetic root tokens before the real columns — the `Count` aggregate (`:148-149`) and the `TimeSeries` token (`:151-152`) — and has a `[JsonExtensionData]` bag plus an `AddExtension` event (`:166-169`) so extension modules can bolt on more.

### 5.9 Surprising things in DynamicQuery

- **Query names are `object`, and the string is `Reflector.CleanTypeName`** — so `"Album"`, not `"AlbumEntity"`. Named queries use an enum's `ToString()`.
- **`ColumnDescription.Entity` ("Entity") is reserved and always added to the projection**, even if you didn't ask for it (`AutoDynamicQuery.cs:97-98`), then split back out of `ResultTable.Columns` (`ResultTable.cs:53-54`). A CLI must expect an extra hidden column.
- **The token split regex tolerates dots inside brackets** (`QueryUtils.cs:370`), which is required because `AsTypeToken` keys look like `(PersonEntity)` and indexer keys like `[SomeValue]`.
- **`Filter.GetEmbeddingForSmartSearch`** is a static `Func<VectorColumnToken, string, Vector>` that **throws unless configured at startup** (`Filter.cs:25`) — vector/semantic search requires the host app to wire an embedding provider.
- **Full-text filters get rewritten into joins.** `CombineFullTextFilters()` (`QueryRequest.cs:101-118`) + `Filter.ToTableFilter()` (`Filter.cs:174-238`, `:302-325`) group multiple `FreeText`/`ComplexCondition` conditions on the same value into a single `FilterSqlServerFullText`, and convert a `SmartSearch` on a `VectorColumnToken` into a `FilterSqlServerVectorSearch` with a metric and `TopN = 100` — but **only on SQL Server**; Postgres uses inline distance calculation (`Filter.cs:308-325`). `Order.ToFullText()` (`Order.cs:26-37`) rewrites a snippet order into a `FullTextRankToken` and **inverts the direction**.
- `Filter.GetDeepestNestedToken()` (`Filter.cs:98-122`) throws `"Unable to use independent nested tokens in the same filter"` when two sibling `Nested` tokens appear — a real constraint on filter trees.
- `FilterCondition.ToLowerString` is a static `Func<QueryToken?, bool>` hook (`Filter.cs:346`) used to force case-insensitive `IsIn` comparisons per-token.

---

## 6. Symbols, registration and the canonical startup sequence

### 6.1 The `*Logic.Start(sb)` convention

Every module exposes `public static void Start(SchemaBuilder sb)` whose **first line is an idempotence guard**:

```csharp
public static void Start(SchemaBuilder sb)
{
    if (sb.AlreadyDefined(MethodInfo.GetCurrentMethod())) return;
    ...
}
```

Seen at `/Signum/Operations/OperationLogic.cs:86-87`, `/Signum/Basics/TypeLogic.cs:49-50`, `/Signum/Basics/QueryLogic.cs:64-65`, `/Signum.Test/Environment/MusicLogic.cs:17-18`, `/Signum/Basics/PermissionLogic.cs:28-29`, `/Signum/Basics/CultureInfoLogic.cs:28-29`, `/Signum/Basics/PropertyRouteLogic.cs:19-20`. The implementation is a `HashSet<(Type, string)>` in `SchemaBuilder.LoadedModules` (`/Signum/Engine/Schema/SchemaBuilder/SchemaBuilder.cs:451-457`), which doubles as a `HeavyProfiler` switch point.

Dependencies are asserted, not documented: `sb.AssertDefined(methodInfo)` throws `"Call {0} first"` (`SchemaBuilder.cs:459-465`). Wrappers: `OperationLogic.AssertStarted(sb)` (`OperationLogic.cs:79-82`), `TypeLogic.AssertStarted` (`TypeLogic.cs:42-45`), `QueryLogic.AssertStarted` (`QueryLogic.cs:53-56`), `CultureInfoLogic.AssertStarted` (`CultureInfoLogic.cs:16-19`). E.g. `OperationAuthLogic.Start` opens with `AuthLogic.AssertStarted(sb); OperationLogic.AssertStarted(sb);` (`/Extensions/Signum.Authorization/Rules/OperationAuthLogic.cs:22-23`).

### 6.2 The canonical sequence

In a real application the file is `{AppName}/Starter.cs` (confirmed by the generated project instructions at `/Signum.Upgrade/Upgrades/Upgrade_20260212_UpdateCopilotInstructions3.cs:33`: "`{an}/Starter.cs` — Central bootstrapping. Registers all framework extensions and app modules via `Start()`", with `{an}.Server/Program.cs` calling `Starter.Start()`). The framework's own instance is `/Signum.Test/Environment/MusicStarter.cs`.

**Phase A — outer bootstrap** (`/Signum.Test/Environment/MusicStarter.cs:12-53`):

```csharp
Start(connectionString);                                    // :38  build the schema (Phase B)
Administrator.TotalGeneration(interactive: false);          // :40  drop + CREATE everything
Schema.Current.Initialize();                                // :42  load all GlobalLazys
(Connector.Current as PostgreSqlConnector)?.ReloadTypes();  // :44
MusicLoader.Load();                                         // :46  seed data through operations
```

In production, `:40` is replaced by `Administrator.TotalSynchronizeScript(out var rep)` / `SynchronizeSchema` (`/Signum/Engine/Administrator.cs:191-206`); `TotalGeneration` is `CleanAllDatabases` + `ExecuteGenerationScript` (`:23-56`).

**Phase B — schema definition** (`MusicStarter.cs:55-110`), in this exact order:

```csharp
public static void Start(string connectionString)
{
    SchemaBuilder sb = new SchemaBuilder();                                              // :57

    // 1. Connector.Default FIRST — Schema.Current is Connector.Current.Schema
    var sqlVersion = SqlServerVersionDetector.Detect(connectionString, SqlServerVersion.SqlServer2017);
    Connector.Default = new SqlServerConnector(connectionString, sb.Schema, sqlVersion); // :61-62
    // ... or PostgreSqlConnector with builder.EnableArrays()/EnableLTree()/EnableRanges()/UseVector()  :66-73

    // 2. Global settings, BEFORE any Include<T>
    sb.Schema.Version = typeof(MusicStarter).Assembly.GetName().Version!;                // :76
    sb.Schema.Settings.ImplementedByAllPrimaryKeyTypes.Add(typeof(long));                // :77
    sb.Schema.Settings.ImplementedByAllPrimaryKeyTypes.Add(typeof(Guid));                // :78
    sb.Schema.Settings.FieldAttributes((OperationLogEntity ol) => ol.User).Add(new ImplementedByAttribute());  // :79
    sb.Schema.Settings.FieldAttributes((ExceptionEntity e) => e.User).Add(new ImplementedByAttribute());       // :80
    Lite.RegisterLiteModelConstructor((AmericanMusicAwardEntity a) => new AwardLiteModel { ... });             // :82
    if (Connector.Current.SupportsTemporalTables)
        sb.Schema.Settings.TypeAttributes<FolderEntity>().Add(new SystemVersionedAttribute());                 // :87
    Validator.PropertyValidator((OperationLogEntity e) => e.User).Validators.Clear();    // :99

    // 3. Module Start methods, core first, app last
    TypeLogic.Start(sb);        // :101
    OperationLogic.Start(sb);   // :103
    ExceptionLogic.Start(sb);   // :104
    QueryLogic.Start(sb);       // :106
    MusicLogic.Start(sb);       // :107

    // 4. Freeze
    sb.Schema.OnSchemaCompleted();   // :109
}
```

Hard ordering rules enforced by the code, not by convention:
- `Connector.Default` must be set before anything reads `Schema.Current` — because `Schema.Current => Connector.Current.Schema` (`/Signum/Engine/Schema/Schema.cs:701-704`).
- Attribute overrides (`sb.Schema.Settings.FieldAttributes(...)`) and `MixinDeclarations.Register` must happen **before** the entity is included; `SchemaBuilder.Include` throws once completed (`SchemaBuilder.cs:338-339`).
- `OperationLogic.Register` throws once completed (`OperationLogic.cs:352-353`).

**Phase C — `OnSchemaCompleted()`** (`Schema.cs:562-573`) runs all `SchemaCompleted` handlers inside `ExecutionMode.Global()`, nulls the event, sets `IsCompleted = true`. Pre-wired in the `Schema` ctor (`:697-698`): `CheckImplementedByAllPrimaryKeyTypes` (which literally prints the `ImplementedByAllPrimaryKeyTypes.Add(typeof(long))` lines you need, `:584-608`) and `CascadeDeleteLogic.RegisterCascadeDeleteHandlers`. Also here: `OperationLogic_Initializing`'s EntityKind/save-operation validation (`OperationLogic.cs:241-269`), `RegisterCurrentLogs`, `QueryLogic`'s conditional `QueryTimeSeriesLogic.Start` (`QueryLogic.cs:117-123`), and any deferred `Schema.WhenIncluded<T>(action)` (`Schema.cs:575-582`).

**Phase D — `Schema.Current.Initialize()`** (`Schema.cs:631-646`) is where all DB-dependent caches load, i.e. where symbols and types get their ids:

```csharp
public void Initialize()
{
    OnBeforeDatabaseAccess();     // throws if OnSchemaCompleted wasn't called (:614-615)
    if (Initializing == null) return;
    InvalidateCache();
    using (ExecutionMode.Global())
        foreach (var init in Initializing.GetInvocationListTyped())
            using (HeavyProfiler.Log("Initialize", () => init.Method.DeclaringType!.ToString()))
                init();
    Initializing = null;
}
```

Subscribers, all registered during Phase B:
- `TypeLogic` → `schema.typeCachesLazy.Load()` (`/Signum/Basics/TypeLogic.cs:75-80`), the cache built by joining `TypeEntity` rows to `Schema.Tables.Keys` on full class name (`TypeCaches`, `:268-285`).
- `SymbolLogic<T>` → `lazy.Load()` per symbol type (`/Signum/Basics/SymbolLogic.cs:56`) — this is what calls `Symbol.SetSymbolIds<T>`.
- `SemiSymbolLogic<T>` likewise (`/Signum/Basics/SemiSymbolLogic.cs:30`).
- `QueryLogic` → `queryNamesLazy.Load(); queryNameToEntityLazy.Load();` (`/Signum/Basics/QueryLogic.cs:81-86`).

**Phase E (sync axis)** — `Generating` / `Synchronizing` handlers are registered in the same `Start` methods and consumed only by the generate/sync scripts: `TypeLogic` wired in the `Schema` ctor (`Schema.cs:683`, `:693`); `SymbolLogic<T>` at `SymbolLogic.cs:57-58`; `SemiSymbolLogic` at `:31-32`; `QueryLogic` at `QueryLogic.cs:95-96`; `PropertyRouteLogic` at `:32`; `CultureInfoLogic` at `:51`.

`ExecutionMode` (`/Signum/Security/ExecutionMode.cs`) is not called by `Start` itself — it is an ambient `AsyncThreadVariable` flag set *around* startup phases (`Global()` inside `OnSchemaCompleted`, `Initialize`, `OnBeforeDatabaseAccess`, `SaveLog`) and by request pipelines (`UserInterface()`).

### 6.3 Security primitives in core vs Extensions

`/Signum/Security/` contains only three files, all pure mechanism with **zero policy**:

- `ExecutionMode.cs` — ambient `InGlobal` / `InUserInterface` / `IsCacheDisabled` flags plus the `OnApiRetrieved` and `OnSetIsolation` extension events (`:47-58`).
- `IUserEntity.cs` — `IUserEntity` is a **completely empty marker interface** (`:5-7`); plus `UserWithClaims` (a `Lite<IUserEntity>` + a `Dictionary<string, object?>` claim bag filled by a `FillClaims` event, `:9-33`) and `UserHolder`, a session-variable holder with `CurrentUserChanged` and `UserSession(...)` (`:35-66`).
- `PasswordEncoding.cs` — a swappable `HashPassword` delegate defaulting to PBKDF2-SHA256 / 100k iterations, with an `HashPasswordAlternatives` list that **still contains MD5 for backwards compatibility** and a `CryptorEngine` MD5 helper (`:12-16`, `:29-35`, `:38-65`).

Everything with actual policy — `UserEntity`, roles, `RuleOperationEntity`, `TypeAuthLogic`, `OperationAuthLogic`, login/token handling — lives in `/Extensions/Signum.Authorization/`. Core only exposes join points: `OperationLogic.AllowOperation`, `PermissionLogic.IsAuthorizedImplementation`, `DynamicQueryContainer.AllowQuery`, `Schema.EntityEvents<T>.FilterQuery`, `UserWithClaims.FillClaims`, `ExecutionMode.OnSetIsolation`. That is why `PermissionSymbol` + `PermissionLogic` sit in `/Signum/Basics/` while their *evaluation* does not.

---

## 7. Reflection / metadata — and what works without a database

### 7.1 `Reflector`

`/Signum/Entities/Reflection/Reflector.cs:25` — a static class, **no DB dependency at all**:

| Member | Line | Purpose |
|---|---|---|
| `CleanTypeName(Type)` | `:86` | strips the `Entity`/`Embedded`/`Model`/`Symbol` suffix; honours `[CleanTypeName]`. **This is the wire identifier for types and queries.** |
| `IsMList`, `IsModifiable`, `IsIEntity`, `IsIRootEntity`, `IsModifiableEntity`, `IsEntity`, `IsEmbeddedEntity`, `IsMixinEntity`, `IsModelEntity` | `:119-164` | the type predicates used everywhere |
| `InstanceFieldsInOrder(Type)` | `:169` | **declaration order** of fields (base class first) — this is what fixes column order in the DB |
| `PublicInstancePropertiesInOrder(Type)` / `...DeclaredPropertiesInOrder` | `:190`, `:183` | declaration order of properties — fixes token order in the UI |
| `GetMemberList<T,S>(lambda)` / `GetMemberListUntyped` / `GetMemberListBase` | `:205-218` | expression → `MemberInfo[]`, the basis of `PropertyRoute.Construct` |
| `FindFieldInfo(type, pi)` / `TryFindFieldInfo` | `:277`, `:288` | property → backing field (handles the auto-property naming and `Signum.MSBuildTask`'s `AutoPropertyConverter` rewrite) |
| `FindPropertyInfo(fi)` / `TryFindPropertyInfo` | `:317`, `:327` | the inverse |
| **`QueryableProperty(type, pi)`** | `:367` | whether a property becomes a query token — the gate used by `QueryToken.SubTokensBaseProperties` |
| `GetFormatString(PropertyRoute)` / `GetUnit(PropertyRoute)` / `FormatString(Type)` / `NumDecimals(format)` / `GetPropertyFormatter` | `:409`, `:401`, `:448`, `:478`, `:383` | display metadata, from `[Format]`/`[Unit]`/validators |
| `NiceCount(type, count)` / `NewNiceName(type)` | `:488`, `:496` | localized strings |

`processedAssemblies` (`:306`) is a `ConcurrentDictionary<Assembly, bool>` used to lazily verify that `Signum.MSBuildTask` ran for an assembly.

### 7.2 `PropertyRoute`

`/Signum/Basics/PropertyRoute.cs:1` — a canonical, comparable, string-round-trippable path from a root entity to a "column". **No DB dependency for construction or naming**; only implementations/authorization need callbacks.

```csharp
public PropertyRouteType PropertyRouteType { get; }   // Root|FieldOrProperty|Mixin|LiteEntity|MListItems
public FieldInfo? FieldInfo { get; }    public PropertyInfo? PropertyInfo { get; }
public PropertyRoute? Parent { get; }
public MemberInfo[] Members { get; }    public PropertyInfo[] Properties { get; }
public Type Type { get; }               public Type RootType { get; }
```

Construction / navigation: `Construct<T,S>(lambda, avoidLastCasting)` (`:34`), `Continue<T,S>(lambda)` (`:41`), `Continue(MemberInfo[])` (`:53`), `AddMany(string)` (`:64`), `Add(string)` (`:72`), `Add(MemberInfo)` (`:116`), `Root(Type)` (cached in a `ConcurrentDictionary`, `:216-217`).

String form and parsing:

```csharp
public override string ToString() => cachedToString ??= CalculateToString();   // :267  e.g. "(OrderEntity).Details[0].SubTotalPrice"
public string PropertyString() => cachedPropertyString ??= CalculatePropertyString();  // :288  "Details[0].SubTotalPrice"
public static PropertyRoute Parse(string fullToString);                        // :316
public static PropertyRoute Parse(Type rootType, string propertyString);       // :344
```

Route notation: `(RootEntity)` for root, `.Prop` for a field/property, `[MixinType]` for a mixin (`ExtractMixin`, `:104`), `[0]` / `.Item` for MList items, `.Entity` for a `Lite<T>`'s entity.

Useful derived operations: `GenerateRoutes(type, includeIgnored, includeMixinItself, includeMListElements)` (`:449`) — **enumerate every route of a type, DB-free**; `GenerateEmbeddedProperties` (`:494`); `SimplifyToProperty()` (`:578`) / `SimplifyToPropertyOrRoot()` (`:590`); `GetMListItemsRoute()` (`:604`); `IsId()` (`:339`); `IsToStringProperty()` (`:710`); `MatchesEntity(entity)` (`:719`); and the codegen workhorses `GetLambdaExpression<T,R>(safeNullAccess, skipBefore, toLite)` (`:620`) and `GetLambdaExpression(fromType, resultType, ...)` (`:635`) — these build a compiled accessor for an arbitrary route, exactly what a CLI needs to read/write a property by string path.

Two **pluggable callbacks** are the only DB-ish coupling:

```csharp
public static void SetFindImplementationsCallback(Func<PropertyRoute, Implementations> findImplementations);  // :399
public Implementations? TryGetImplementations();   // :406   (null if callback unset)
public Implementations  GetImplementations();      // :423   (throws if unset)
public static void SetIsAllowedCallback(Func<PropertyRoute, string?> isAllowed);  // :431
public string? IsAllowed();                        // :438
```

The engine wires `SetFindImplementationsCallback` to `Schema.FindImplementations`, so `TryGetImplementations()` works as soon as a Schema exists — still no connection needed.

`ModifiableEntity.TryGetPropertyRoute()` (`/Signum/Entities/ModifiableEntity.cs:381-410`) reconstructs a route **from a live object graph** by walking the `parentEntity` chain and matching property validators — handy for error reporting without any schema at all.

`PropertyRouteLogic` (`/Signum/Basics/PropertyRouteLogic.cs`) is the DB side: it persists `PropertyRouteEntity` rows and synchronizes them, so routes can be referenced by FK (used by property authorization and translation).

### 7.3 `TypeLogic`

`/Signum/Basics/TypeLogic.cs:8`. **This one is DB-backed.** Every accessor goes through `Schema.Current.typeCachesLazy.Value`:

```csharp
public static Dictionary<PrimaryKey, Type> IdToType   => Schema.Current.typeCachesLazy.Value.IdToType;    // :10-13
public static Dictionary<Type, PrimaryKey> TypeToId   => ...TypeToId;                                     // :15
public static Dictionary<Type, TypeEntity> TypeToEntity => ...;                                           // :20
public static Dictionary<TypeEntity, Type> EntityToType => ...;                                           // :25
public static Dictionary<Lite<TypeEntity>, Type> LiteToType => ...;                                       // :30
```

```csharp
schema.typeCachesLazy = sb.GlobalLazy(() => new TypeCaches(schema),
    new InvalidateWith(typeof(TypeEntity)), Schema.Current.InvalidateMetadata);       // :80
```

The name↔type mapping is the part a CLI leans on most:

```csharp
public static Dictionary<string, Type> NameToType => ...;   // :208
public static Dictionary<Type, string> TypeToName => ...;   // :213
public static Type   GetType(string cleanName);              // :218
public static Type?  TryGetType(string cleanName);           // :223
public static string GetCleanName(Type type);                // :228
public static string? TryGetCleanName(Type type);            // :233
public static bool IsIncluded(Type type) / IsIncluded<T>();   // :244, :249
public static void AssertLoaded();                           // :254
```

**Important nuance:** `SchemaBuilder.Include` already registers `NameToType`/`TypeToName` in memory (`SchemaBuilder.cs:361-363`), so the *name* mapping is available without a DB. But `TypeToId`/`IdToType` — needed for `ImplementedByAll` and for `Lite.Parse` of an IBA column — require the `TypeEntity` table (`TypeCaches`, `:268-285`).

`TypeLogic.Start` (`:47-81`) also installs the `SchemaCompleted` check that **every table type has an `[EntityKind]`** (`:65-73`), and registers `Schema_Synchronizing` (`:105`) / `Schema_Generating` which reconcile `TypeEntity` rows including table renames (`TryEntityToType(replacements)`, `:98-103`).

### 7.4 `DescriptionManager`

`/Signum.Utilities/DescriptionManager.cs:127` — localization of types, properties and enums via **XML translation files**, not resx. **Entirely DB-free.**

```csharp
public static Func<Type, string> CleanTypeName = t => t.Name;      // :129  overridden by the engine
public static Func<Type, Type>   CleanType = t => t;               // :130  to unwrap Lite<T>
public static string TranslationDirectory = Path.Combine(Path.GetDirectoryName(
    typeof(DescriptionManager).Assembly.Location)!, "Translations");  // :132
public static event Func<Type, DescriptionOptions?> DefaultDescriptionOptions =
    t => t.IsEnum && t.Name.EndsWith("Message") ? DescriptionOptions.Members : null;   // :134
public static event Func<MemberInfo, bool> ShouldLocalizeMemeber = m => true;           // :135
public static event Action<CultureInfo, MemberInfo>? NotLocalizedMember;                // :136
public static Dictionary<Type, Func<MemberInfo, string>> ExternalEnums = ...;            // :138
public static Action? Invalidated;  public static void Invalidate();                     // :361-362
```

Public API: `NiceName(this Type)` (`:182`), `NicePluralName(this Type)` (`:200`), `NiceToString(this Enum[, args])` (`:213`, `:218`), `NiceName(this PropertyInfo/FieldInfo)` (`:242`, `:237`), `NiceName<T,R>(Expression<Func<T,R>>)` (`:232`), `IsDefaultName(this PropertyInfo)` (`:248`), `GetGender(this Type)` (`:278`), `GetLocalizedType(type, culture)` (`:306`), `GetLocalizedAssembly(assembly, culture)` (`:324`).

`DescriptionOptions` flags (`:24-34`): `None, Members, Description, PluralDescription, Gender, All`. Defaults (per `/Signum.Utilities/DescriptionManager.md:31-37`): enums ending in `Message` → Members; Symbols/SemiSymbols → Members; enums used in entity properties → Members|Description; enums ending in `Query` → Members. Overridable with `[DescriptionOptions]`; `ModifiableEntity` carries `Members|Description` (`/Signum/Entities/ModifiableEntity.cs:20`) so all entities inherit it, and `Entity` upgrades to `All` (`/Signum/Entities/Entity.cs:10`).

Resolution order for `NiceToString` (`DescriptionManager.md:65-72`): current-culture XML → parent-culture XML → assembly-default-culture XML → `[Description]` attribute → `NiceName` of the field (underscores → spaces, else `SpacePascal`).

`LocalizedAssembly` (`:381`) / `LocalizedType` (`:515`) with `TranslationFileName(assembly, culture)` (`:393`), `ImportXml` (`:466`), `FromXml` (`:485`) — so a CLI can read/write translation files directly.

### 7.5 What works without a database connection

**Works with no connection at all (but still needs a `Connector` *object* and therefore a `Schema`):**

- Building a `SchemaBuilder`, `Include<T>()`, every `GenerateField*`, `Table.GenerateColumns()`, `TableMList` construction, `AllIndexes()`, index-name computation.
- `Schema.Table/Field/TryField/FindImplementations/GetDatabaseTables/DatabaseNames/ToDirectedGraph`.
- `ObjectName`/`SchemaName`/`DatabaseName` rendering.
- **So yes: you can build a Schema and inspect every table, column, type, nullability, index and FK with no database.**
- `SchemaGenerator.CreateTablesScript`, `CreateSchemasScript`, `CreatePartitioningFunctionScript`, `CreatePostgresExtensions`, `InsertEnumValuesScript` (`/Signum/Engine/Sync/SchemaGenerator.cs:8-143`) — pure in-memory string generation.
- All of `Reflector`, `PropertyRoute` (construction, `ToString`, `Parse`, `GenerateRoutes`, `GetLambdaExpression`), `DescriptionManager`, `Validator`/`ValidationAttributes`, `GraphExplorer`, `EntityKindCache`, `MixinDeclarations`.
- `TypeLogic.GetType(cleanName)` / `GetCleanName(type)` — because `SchemaBuilder.Include` fills those dictionaries eagerly.
- Symbol objects: `Key`, `ToString()`, `NiceToString()`, `Equals`, dictionary use, `OperationLogic.Register`, `OperationLogic.TryFindOperation`.
- `QueryToken` construction and `QueryUtils.Parse`/`TryParse`/`SubTokens` **given a `QueryDescription`** — the token machinery itself is metadata-only.

**Caveat: a `Connector` object must exist**, because `SchemaBuilder.FixNameLength` reads `Connector.Current.MaxNameLength` (`SchemaBuilder.cs:920`), `TableIndex.MaxNameLength()`/`ViewName` read `MaxNameLength`/`AllowsIndexWithWhere` (`/Signum/Engine/Schema/TableIndexes.cs:70`, `:100`), and `Field.GenerateUniqueIndex`, `AbstractDbType.Equals/ToString`, the `FieldReader` ctor all read `Schema.Current.Settings.IsPostgres`. None of those touch the wire — `MaxNameLength` is a constant (128 / 63) and version-dependent capabilities read the in-memory `Version` field.

**Requires a live connection:**

- `SqlServerVersionDetector.Detect` / `PostgresVersionDetector.Detect` (they connect, but swallow failures and return the fallback — `SqlServerConnector.cs:40-90`, `PostgreSqlConnector.cs:17-42`).
- `SqlServerConnector.SupportsFullTextSearch` (`:131`), `PostgreSqlConnector.SupportsVectorsLazy` (`:54`), `LocalTimeZoneLazy`, `DateFirstLazy` (`:94`), `HasTables()`, `CleanDatabase()`.
- **`Administrator.TotalGenerationScript()` — despite being "just a script"** — because `SchemaGenerator.SnapshotIsolation` queries `sys.databases` (`SchemaGenerator.cs:145-180`), and `Schema.GenerationScipt()` calls `OnBeforeDatabaseAccess()` which throws unless `OnSchemaCompleted()` ran (`Schema.cs:528`, `:612-615`).
- Everything in the sync path: `Schema.SynchronizationScript`, `Administrator.TotalSynchronizeScript`, `NeedsSynchronization` — because the DB model is read via LINQ over `sys.*` / `pg_*` views.
- `Schema.Initialize()` and therefore: `TypeLogic.TypeToId`/`IdToType`/`TypeToEntity`, `SymbolLogic<T>.ToSymbol(key)` and symbol **ids**, `QueryLogic.QueryNames` / `ToQueryName(string)`, `Lite.Parse` (needs `TypeLogic.TryGetType` — name mapping is in memory, but the id parse needs `PrimaryKey.PrimaryKeyType` which *is* in memory, so `Lite.Parse` actually works schema-only for non-IBA cases; `Lite.Parse` of an IBA column and any query using IBA equality does need `TypeToId`).
- `QueryLogic.Queries.QueryDescription(queryName)` — the container's per-user filtering calls into authorization, and `ToQueryName(string)` needs `queryNamesLazy`.
- `Administrator.ExistsTable/ExistSchema/GetIndixesNames/TruncateTable/MoveAllForeignKeys*/DropUniqueIndexes/CreateVectorIndex` (`Administrator.cs:300-343`, `:585-753`), `Transaction.CurrentConnection`, all of `Executor`, `FieldReader`, `BulkInserter`, and of course any `Database.*` call.

### 7.6 The metadata HTTP surface (bonus for a CLI)

`/Signum/API/Controllers/ReflectionController.cs`:

| Endpoint | Line | Result |
|---|---|---|
| `GET api/reflection/types` | `:14-27` | `Dictionary<string, TypeInfoTS>` — **the whole entity model as JSON**, with `Last-Modified`/`304` support (`:17-25`) and `[SignumAllowAnonymous]` |
| `GET api/reflection/typeEntity/{typeName}` | `:29-32` | the `TypeEntity` row |
| `GET api/reflection/enumEntities/{typeName}` | `:34-41` | all values of an enum table |
| `GET api/reflection/typeInDomains` | `:43-60` | per-type read/write id sets for domain authorization |

`ReflectionServer.GetTypeInfoTS()` is what the React client consumes to render every form — meaning **the complete entity metadata (types, members, CLR/filter types, formats, units, validators, operations, query keys) is already exposed as a single cacheable JSON document.**

---

## 8. Where a CLI plugs in

Ranked by leverage.

1. **DynamicQuery is already a data-only query language.** `queryKey` (clean type name) + token strings + `FilterOperation` enum names + `OrderType` + a pagination record. Build `QueryRequestTS` JSON and POST it to `api/query/executeQuery/{queryKey}`, or construct `QueryRequest` in-process and call `QueryLogic.Queries.ExecuteQuery`. `ResultTable.ToDataTable(converter)` (`/Signum/DynamicQuery/Requests/ResultTable.cs:66`) gives you CSV/table output for free.
2. **Token discovery and completion are first-class.** `QueryUtils.TryParse(tokenString, qd, options, out error, out lastParsedToken)` (`/Signum/DynamicQuery/QueryUtils.cs:396`) + `QueryDescription.NextAlternatives(qd, options, partial)` (`:506`) + `api/query/subTokens` (`QueryController.cs:76`) give shell tab-completion with zero extra work. `QueryUtils.GetFilterOperations(token)` (`:101`) tells you the legal operations for the token the user just typed; `CanFilter`/`CanColumn`/`CanOrder` (`:432`, `:446`, `:511`) give you pre-flight validation with human-readable messages.
3. **Operations are string-addressable and untyped-arg.** `SymbolLogic<OperationSymbol>.ToSymbol("AlbumOperation.Save")` + `OperationLogic.ServiceExecute/ServiceExecuteLite/ServiceConstruct/ServiceConstructFrom/ServiceDelete` (`/Signum/Operations/OperationLogic.cs:481-598`), or the REST endpoints under `api/operation/*`. `ServiceCanExecute(entity)` gives you a dry-run. `Graph<T,S>.ToDGML()` (`/Signum/Operations/GraphState.cs:328`) renders the state machine.
4. **`Lite<T>` keys are the natural CLI entity handle.** `"Album;3"` / `"Album;3;Dark Side of the Moon"`, parsed by `Lite.Parse` (`/Signum/Entities/Lite.cs:185`), produced by `Key()`/`KeyLong()`. Autocomplete via `api/query/findLiteLike?types=Album,Band&subString=dark&count=10` (`QueryController.cs:18`).
5. **Schema introspection needs no database.** Build a `SchemaBuilder`, set a `Connector` (a real connection string is not required for pure inspection), include your entities, and you can dump every table/column/index/FK, plus `PropertyRoute.GenerateRoutes(type, ...)` for every route of every type, plus `Reflector`/`DescriptionManager` for names, formats, units and localization. A `signum schema dump` / `signum schema diff --script` command is very cheap.
6. **Migration is already a scripted, reviewable artefact.** `Administrator.TotalGenerationScript()` and `Administrator.TotalSynchronizeScript(out Replacements, interactive, schemaOnly)` (`/Signum/Engine/Administrator.cs:118`, `:191`) return a `SqlPreCommand` tree with `PlainSql()`, `Leaves()`, `ExtractNoTransaction()`. **Caveat:** the synchronizer is *interactive by design* — rename detection prompts via `SafeConsole.Ask`, and non-interactive mode **throws rather than guessing** (`/Signum/Engine/Sync/Synchronizer.cs:402-403`). To automate it you must supply `Replacements.AutoReplacement` / `GlobalAutoReplacement` / `ResponseRecorder`. That is exactly a CLI's job: record answers once, replay them in CI.
7. **`BatchExecute`** (`/Signum/DynamicQuery/DynamicQueryContainer.cs:228`) runs N heterogeneous requests in one round trip — one CLI invocation, one dashboard.
8. **`ReflectionServer.GetTypeInfoTS()`** (`api/reflection/types`) is the whole entity model as one cacheable JSON document — a CLI can cache it locally and do all completion/validation offline.
9. **Validation without a DB.** `entity.IntegrityCheck()` / `FullIntegrityCheck()` / `Entity.EntityIntegrityCheck()` (`/Signum/Entities/ModifiableEntity.cs:306`, `:423`; `/Signum/Entities/Entity.cs:118`) work purely in memory — a `signum validate <file.json>` command needs no connection.
10. **`request.Dump()`** (`/Signum/DynamicQuery/Requests/QueryRequest.cs:54`, `:359`, `:401`, `:446`) prints a human-readable form of any request — an `--explain` flag for free.

**Traps a CLI must respect:**

- `SubTokensOptions` differ per slot (columns vs filters vs orders vs value), and aggregate tokens are only legal when `groupResults: true` (`/Signum/API/Json/FilterJsonConverter.cs:85-88`, `:149-156`, `:263-265`).
- The `Entity` column is always present in results whether requested or not, and is exposed as `ResultTable.EntityColumn`, not in `Columns`.
- `IsIn`/`IsNotIn` cannot express null; `Between`/`BetweenNoEnd` want a two-element list.
- Saving a `RequiresSaveOperation` entity outside an operation throws — a CLI import path needs `using (OperationLogic.AllowSave<T>())` or must go through the operation.
- Symbols have no `Id` until `Schema.Current.Initialize()` has run against a real DB.
- The synchronizer will block on console prompts unless you pre-seed `Replacements`.
- `[AutoInit]` and `[AutoExpressionField]` only work if `Signum.MSBuildTask` ran over the assembly; a CLI that loads entity assemblies built without it will see `null` symbol fields and `"...has the default value 'auto'"` errors.
