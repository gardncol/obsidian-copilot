# BYOK Settings UI — Tech Design Spec

**Audience:** the agent / engineer implementing the first BYOK UI PR on `zero/model-settings-redesign` (or its successor).

**Status:** ready to implement. All backend services this spec references are already wired on the branch (see `src/modelManagement/createModelManagement.ts`, the registries under `src/modelManagement/`, and the React context in `src/modelManagement/ui/ModelManagementContext.tsx`).

**Companion docs:** read [`MODEL_DATA_MODEL_SPEC.md`](./MODEL_DATA_MODEL_SPEC.md) for the persisted-data invariants this UI must preserve, and `AGENTS.md` (repo root) for the project conventions (`cn()` wrapping, `tw-` prefix, popout-window safety, no global `app`).

**Reference prototype branch:** `model-settings-redesign-prototype` — same UX, older data model. Copy _visual / Tailwind_ patterns from these files only; the logic must be re-derived against the new injection-based API documented below.

| Component                                                        | Reference path (on `model-settings-redesign-prototype`)      |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| Tab root                                                         | `src/modelManagement/ui/tabs/ByokPanel.tsx`                  |
| Provider table                                                   | `src/modelManagement/ui/components/ByokGlobalTable.tsx`      |
| Model checkbox list                                              | `src/modelManagement/ui/components/ProviderCatalogList.tsx`  |
| "Add provider" dialog                                            | `src/modelManagement/ui/dialogs/AddProviderDialog.tsx`       |
| "Configure provider" dialog                                      | `src/modelManagement/ui/dialogs/ConfigureProviderDialog.tsx` |
| "Add custom model" dialog (style only — not implemented this PR) | `src/modelManagement/ui/dialogs/AddCustomModelDialog.tsx`    |

---

## 1. Goal & user flow

> The user opens **Copilot Settings → Models**, sees a (initially empty) table of BYOK providers. They click **+ Add a provider**, pick a catalog provider (Anthropic, OpenAI, Google, …), enter their API key, click **Test** (verification ✓), check N models from the catalog, click **Verify & save**. A `Provider` row plus N `ConfiguredModel` rows are persisted to `settings`, and the new models are auto-enrolled into the `chat` + `opencode` backends. Back at the table, the user can expand the provider to see its models, edit the provider's display name / models, or remove the provider entirely (cascades through every backend).

Screens:

```
┌──────────────── Models tab ─────────────────┐
│ [🔍 Search]                                 │
│ ┌─────────────────────────────────────────┐ │
│ │ ▾ [An] Anthropic    [2 models]      ⋮  │ │
│ │     claude-sonnet-4-5   200K  Sep '25  │ │
│ │     claude-opus-4-5     200K  Sep '25  │ │
│ └─────────────────────────────────────────┘ │
│ [+ Add a provider]   [⟳ Refresh catalog]    │
└─────────────────────────────────────────────┘

Add a provider:                Configure provider:
┌────────────────────┐         ┌──────────────────────────────┐
│ [🔍 Search]        │         │ [An] Anthropic        ✓ Verified │
│ Recommended        │         │ Display name [_____________] │
│  [An] Anthropic ›  │         │ API key      [********] Test │
│  [Op] OpenAI    ›  │         │ Base URL     [api.…]         │
│  [Go] Google    ›  │         │ ─ Models ────────────────────│
│ More providers     │         │  ☑ claude-sonnet-4-5         │
│  [Co] Cohere    +  │         │  ☑ claude-opus-4-5           │
│  ...               │         │  ☐ claude-haiku-4-5          │
│ [+ Custom (soon)]  │         │ [Cancel] [Verify & save]     │
└────────────────────┘         └──────────────────────────────┘
```

---

## 2. Scope of the first UI PR

Implement:

- The **Models** tab in `SettingsMainV2` (replaces the legacy `model` tab).
- Catalog-driven provider add flow.
- Edit flow (open dialog with existing provider data, save display name / base URL / model selection).
- Remove flow with confirm modal.
- Background catalog refresh.

Out of scope (future PR):

- Built-in template providers (Ollama, LM Studio, Azure, Bedrock, custom OpenAI-compatible). Backend stubs `ByokSetupApi.addTemplateProvider` / `addModels` still throw `not implemented yet` — leave them alone.
- `AddCustomModelDialog` and the "Just added" model row UI.
- Per-model removal (kebab on a model row). `ModelManagementCoordinator.removeConfiguredModel` is a stub too.
- The "Add a custom provider" dashed CTA at the bottom of `AddProviderDialog` — render it but **disable it with a "Coming soon" tooltip**.

---

## 3. File layout

Create:

```
src/modelManagement/ui/
├── tabs/
│   └── ByokPanel.tsx                  # root component
├── components/
│   ├── ByokGlobalTable.tsx            # provider list, collapsible model rows
│   └── ProviderCatalogList.tsx        # checkbox list, used inside ConfigureProviderDialog
├── dialogs/
│   ├── AddProviderDialog.tsx
│   └── ConfigureProviderDialog.tsx
├── utils/
│   └── formatModelMetadata.ts         # "128K context" / "Sep '25" helpers
```

Update:

```
src/settings/v2/SettingsMainV2.tsx     # swap `model` tab → `models`, render <ByokPanel app={...}>
```

Adjacent `.test.tsx` files per the existing pattern (e.g. `ByokPanel.test.tsx`). Use `@testing-library/react`. Mock `useModelManagement` with a hand-rolled object for component-level tests; integration-test the panel against the real registries (jsdom + `resetSettings()`).

**Do not create** any new UI primitives. The full design fits inside the existing `src/components/ui/` set.

---

## 4. Component contracts

### 4.1 `ByokPanel`

```tsx
interface ByokPanelProps {
  app: App; // threaded for popout-window safety; pass to confirm modals
}
```

**State:**

- `query: string` — filters the table.
- `addProviderOpen: boolean`.
- `configureState: { mode: "new"; catalog: CatalogProvider } | { mode: "edit"; providerId: string } | null`.
- `loadState: "loading" | "ready"` — gated on `catalogService.ensureLoaded()`.
- `catalogVersion: number` — bumped by `useSyncExternalStore` over `catalogService.onChange`.

**Reads:**

- `useAtomValue(byokProvidersAtom, { store: settingsStore })` — provider rows.
- `useAtomValue(configuredModelsAtom, { store: settingsStore })` — all configured models, then group client-side by `providerId`.
- `useSyncExternalStore(catalogService.onChange.bind(catalogService), () => catalogService.getAllProviders())` — catalog snapshot. The catalog service is _not_ Jotai-backed.

**Mutations:**

- `api.catalogService.ensureLoaded()` on mount.
- `api.catalogService.refresh()` from the Refresh button.
- `api.coordinator.removeProvider(id)` behind a confirm modal.

**Layout sketch** (Tailwind strings to copy verbatim from prototype `ByokPanel.tsx`):

```tsx
<div className="tw-flex tw-flex-col tw-gap-4">
  <SearchBar value={query} onChange={setQuery} placeholder="Search providers…" />
  {loadState === "loading"
    ? <div className="tw-text-sm tw-text-muted">Loading catalog…</div>
    : <ByokGlobalTable groups={tableGroups} onConfigure={...} onRemove={...} />}
  <div className="tw-flex tw-items-center tw-gap-2">
    <Button onClick={() => setAddProviderOpen(true)}>
      <Plus className="tw-size-4" /> Add a provider
    </Button>
    <Button variant="secondary" onClick={() => api.catalogService.refresh()}>
      Refresh catalog
    </Button>
  </div>
  <AddProviderDialog
    open={addProviderOpen}
    onOpenChange={setAddProviderOpen}
    onPickCatalog={(catalog) => {
      setAddProviderOpen(false);
      setConfigureState({ mode: "new", catalog });
    }}
  />
  <ConfigureProviderDialog
    state={configureState}
    onClose={() => setConfigureState(null)}
  />
</div>
```

### 4.2 `ByokGlobalTable`

```tsx
interface ByokTableGroup {
  provider: Provider;
  models: ConfiguredModel[];
}
interface ByokGlobalTableProps {
  groups: readonly ByokTableGroup[];
  onConfigure: (providerId: string) => void;
  onRemove: (providerId: string) => void;
}
```

- One section per group. Header row is clickable to expand / collapse — local state per row, no global tracking.
- Header layout (copy verbatim from prototype `ByokGlobalTable.tsx`):
  - Glyph badge (2 initials, `tw-size-6 tw-rounded-sm tw-bg-secondary-alt`).
  - Display name (`tw-font-medium`).
  - Model count badge (`<Badge variant="outline" className="tw-text-ui-smaller">`).
  - `MoreVertical` icon → `DropdownMenu` with "Configure" / "Remove provider". Portal to the settings modal container via `useTabOptional().modalContainer`.
- Model rows grid: `tw-grid tw-grid-cols-[1fr_auto_auto] tw-items-center tw-gap-3 tw-px-3 tw-py-1.5 tw-pl-10`.
- Empty state when `groups.length === 0`: muted text + "No providers yet — click + Add a provider to start."

### 4.3 `AddProviderDialog`

```tsx
interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPickCatalog: (catalog: CatalogProvider) => void;
}
```

- Reads catalog via `useSyncExternalStore` on `api.catalogService`.
- Filters out catalog providers that **already exist as BYOK rows** (the user edits via Configure rather than re-add). Match on `(provider.providerType, catalog.id)` — catalog id maps 1:1 to a built-in (e.g. `"anthropic"` catalog → BYOK row with `providerType: "anthropic"`).
- Two sections:
  - **Recommended** — hardcoded ids: `["anthropic", "openai", "google"]` (filter to ones actually present in the catalog). Larger rows with a short description ("Claude family", "GPT family", "Gemini family"). Description map lives next to the component.
  - **More providers** — every other `CatalogProvider`, alphabetical by `displayName`.
- Search filters across both sections. Empty-result state: muted message.
- "Add a custom provider" CTA at the bottom — **disabled** with `tw-cursor-not-allowed tw-opacity-50` and a `Tooltip` saying _"Coming soon — Ollama / LM Studio / Azure / Bedrock support is in the next release"_.
- Tailwind strings for Recommended / More / dashed-CTA rows: copy verbatim from prototype `AddProviderDialog.tsx`. Key patterns:

```tsx
// Recommended row
className={cn(
  "tw-group tw-flex tw-w-full tw-cursor-pointer tw-items-center tw-gap-3 tw-rounded-md",
  "tw-border tw-border-solid tw-border-border tw-bg-primary tw-px-3 tw-py-2 tw-text-left",
  "hover:tw-border-interactive-accent hover:tw-bg-primary-alt/40"
)}

// More-providers row
className={cn(
  "tw-flex tw-w-full tw-cursor-pointer tw-items-center tw-gap-3 tw-rounded-md",
  "tw-border tw-border-solid tw-border-transparent tw-px-3 tw-py-1.5 tw-text-left",
  "hover:tw-border-border hover:tw-bg-primary-alt/40"
)}

// Custom-provider dashed CTA (disabled)
className={cn(
  "tw-mt-2 tw-flex tw-w-full tw-flex-col tw-items-center tw-gap-1 tw-rounded-md tw-p-4",
  "tw-border tw-border-dashed tw-border-interactive-accent/40 tw-bg-interactive-accent/5",
  "tw-cursor-not-allowed tw-opacity-50"
)}
```

### 4.4 `ConfigureProviderDialog`

```tsx
type ConfigureState =
  | { mode: "new"; catalog: CatalogProvider }
  | { mode: "edit"; providerId: string };

interface ConfigureProviderDialogProps {
  state: ConfigureState | null;
  onClose: () => void;
}
```

**Local component state** (resets each time the dialog opens):

- `displayName: string`
- `apiKey: string` — never read back from the keychain in `new` mode; in `edit` mode, start blank and only set if the user types something.
- `baseUrl: string`
- `extras: Record<string, unknown>` — for `azure` / `bedrock` provider types only.
- `selectedWireIds: Set<string>` — checked models.
- `verification: { ok: boolean; message?: string } | null`
- `testing: boolean`
- `saving: boolean`

**Initial values:**

- `new`: derive from `state.catalog` (`displayName = catalog.displayName`, `baseUrl = catalog.defaultBaseUrl ?? ""`).
- `edit`: derive from `api.providerRegistry.get(state.providerId)` and the slice of `configuredModelsAtom` filtered by that providerId.

**Sections (top → bottom):**

1. **Header** — glyph + provider display name + verification badge:
   ```tsx
   {
     verification && (
       <Badge variant={verification.ok ? "success" : "error"}>
         {verification.ok ? "✓ Verified" : "✗ " + verification.message}
       </Badge>
     );
   }
   ```
2. **Credentials** — `<FormField>` wrappers:
   - Display name: `<Input>`.
   - API key: `<div className="tw-flex tw-gap-2"><PasswordInput className="tw-flex-1" /><Button variant="secondary" size="sm" onClick={handleTest}>{testing ? <Loader2 className="tw-size-4 tw-animate-spin" /> : "Test"}</Button></div>`.
   - Base URL: `<Input>` (editable, prefilled from catalog `defaultBaseUrl`).
   - Conditional `extras` inputs (azure / bedrock).
3. **Models** — `<ProviderCatalogList catalog={catalog} selected={selectedWireIds} onToggle={...} />`. In `edit` mode, the catalog source is `api.catalogService.getProvider(<derive id>)` — if not found (catalog offline or unknown provider), render the model list from the existing `ConfiguredModel.info` snapshots instead, with checkboxes pre-checked.
4. **Footer:**
   - `new`: `[Cancel] [Verify & save]`. Save is enabled only when `verification?.ok === true` _and_ `selectedWireIds.size > 0`. Order: `await byokSetup.addCatalogProvider({...})` → `onClose()`.
   - `edit`: `[Remove provider]` (destructive, left side) | `[Cancel] [Save changes]` (right side). Save runs `await providerRegistry.update(...) ; await configuredModelRegistry.bulkSet(providerId, infos)` (`infos` derived from `selectedWireIds` ⨯ catalog snapshot, falling back to the existing `ConfiguredModel.info` for ids that aren't in the live catalog). After save, also `await backendConfigRegistry.enableModel(backend, id)` for newly-added ids in `BYOK_DEFAULT_AUTO_ENROLL` (re-import default — same UX as the new flow).

**Test button behavior** (the key UX subtlety):

| Mode   | Action                                                                                                                                                                                                                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new`  | Do **not** persist anything yet. Build a synthetic `Provider` shape from the form (`providerId: "test"`, `providerType: catalog.providerType`, `baseUrl`, `extras`) and call `api.adapters.verifyCredentials(catalog.providerType, { provider, apiKey, extras })` directly. Store the result in `verification` local state. |
| `edit` | Persist key first so the registry's `verify()` can read it: `await providerRegistry.setApiKey(providerId, apiKey)`, then `await providerRegistry.verify(providerId)`.                                                                                                                                                       |

`adapters` is on the api object (`api.adapters` — see `createModelManagement.ts` return shape).

### 4.5 `ProviderCatalogList`

```tsx
interface ProviderCatalogListProps {
  catalog: CatalogProvider;
  selected: ReadonlySet<string>; // wire ids
  onToggle: (wireId: string, next: boolean) => void;
  query?: string; // optional search
}
```

- Render each `catalog.models[wireId]` as a row: `<Checkbox> | name | context-window | release-date`.
- Grid: `tw-grid tw-grid-cols-[auto_1fr_auto_auto] tw-items-center tw-gap-3 tw-px-3 tw-py-1.5`.
- Use `formatModelMetadata.formatContextWindow(limits?.context)` and `formatReleaseDate(releaseDate)` helpers.
- No internal state; controlled purely by props.

### 4.6 `formatModelMetadata.ts`

Two pure functions, no imports:

```ts
export function formatContextWindow(context?: number): string {
  if (!context) return "";
  if (context >= 1_000_000) return `${(context / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (context >= 1_000) return `${Math.round(context / 1_000)}K`;
  return String(context);
}

export function formatReleaseDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", year: "2-digit" }); // e.g. "Sep '25"
}
```

Copy verbatim from prototype's `src/modelManagement/ui/utils/formatModelMetadata.ts` if it diverges.

---

## 5. Mutation paths — UI action → API call

| UI action                                 | API call                                                                                                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mount `ByokPanel`                         | `api.catalogService.ensureLoaded()`                                                                                                                                                                                     |
| Click `Refresh catalog`                   | `api.catalogService.refresh()`                                                                                                                                                                                          |
| Open Add Provider                         | (no API call; just opens dialog)                                                                                                                                                                                        |
| Pick a catalog provider                   | (no API call; transitions panel state to `{ mode: "new", catalog }`)                                                                                                                                                    |
| Click `Test` (new)                        | `api.adapters.verifyCredentials(catalog.providerType, { provider: synthetic, apiKey, extras })`                                                                                                                         |
| Click `Test` (edit)                       | `api.providerRegistry.setApiKey(id, key)` then `api.providerRegistry.verify(id)`                                                                                                                                        |
| Click `Verify & save` (new)               | `api.setup.byok.addCatalogProvider({ template, displayName, baseUrl, apiKey, extras, selectedWireModelIds })`                                                                                                           |
| Click `Save changes` (edit)               | `api.providerRegistry.update(id, { displayName, baseUrl, extras })` → `api.configuredModelRegistry.bulkSet(id, infos)` → for new ids, `api.backendConfigRegistry.enableModel(backend, id)` ⨯ `BYOK_DEFAULT_AUTO_ENROLL` |
| Kebab → `Remove provider` (after confirm) | `api.coordinator.removeProvider(id)`                                                                                                                                                                                    |

`api` here means the return of `useModelManagement()`.

---

## 6. Existing primitives to consume

From `src/components/ui/`:
`dialog.tsx`, `dropdown-menu.tsx`, `checkbox.tsx`, `button.tsx`, `badge.tsx`, `collapsible.tsx`, `form-field.tsx`, `password-input.tsx`, `SearchBar.tsx`, `tooltip.tsx`, `input.tsx`, `label.tsx`.

From `src/components/modals/`:
Pattern for the confirm modal — see `ResetSettingsConfirmModal` for the canonical shape. Open via `new ConfirmModal(app, ...).open()`; pass `app` through props (never the global).

Lucide icons used: `Plus`, `ChevronDown`, `ChevronRight`, `MoreVertical`, `Settings2`, `Trash2`, `CheckCircle2`, `XCircle`, `Loader2`.

---

## 7. Hard constraints (must-pass review)

1. **Reads via Jotai atoms only.** Never call `api.providerRegistry.list()` or `api.configuredModelRegistry.list()` from React render. Use `byokProvidersAtom` / `configuredModelsAtom`. Catalog is the exception (it's not Jotai-backed — use `useSyncExternalStore`).
2. **Mutations via `useModelManagement()`.** No imports of singletons (there are none) and no constructor calls.
3. **Every Tailwind class string wrapped in `cn()`** (`@/lib/utils`). `eslint-plugin-tailwindcss` only sees classes inside `cn()` calls or literal `className=` attributes.
4. **Thread `app` through props** to anything that opens a modal. Never `declare const app: App`. Never `app.workspace.getActiveLeaf()...` to find documents — use `element.doc` / `element.win` (see `AGENTS.md` → "popout-window safety").
5. **Referential stability** — empty arrays / configs in component-local memos should reuse a module-level `EMPTY` constant rather than freshly allocating `[]`.
6. **Component tests** colocated, mocking `useModelManagement()` with a hand-rolled object for unit tests and using the real registries (with `resetSettings()`) for the panel integration test.
7. **No edits to** `addTemplateProvider`, `addModels`, `removeConfiguredModel` — leave them as throwing stubs with their `TODO(byok)` comments.

---

## 8. Verification checklist

1. `npm run build` — typecheck passes.
2. `npm run lint && npm run format:check`.
3. `npm test` — all new component / panel tests pass.
4. `npm run test:vault` — deploys to `$COPILOT_TEST_VAULT_PATH`. Live walkthrough:
   - Open Copilot Settings → **Models** tab. Empty state visible.
   - Click `+ Add a provider`. Modal opens with Recommended (Anthropic / OpenAI / Google) + More providers.
   - Pick **Anthropic**. Configure dialog opens. Catalog default base URL is prefilled.
   - Paste a real Anthropic key. Click **Test**. Spinner → green ✓ Verified badge.
   - Check `claude-sonnet-4-5` + `claude-opus-4-5`. Click **Verify & save**.
   - Back at the table — Anthropic row appears, "2 models" badge, expand chevron reveals the two model rows with context window + release date columns.
   - Inspect `data.json`:
     - `providers.<uuid>` exists with `origin: { kind: "byok" }`, `apiKeyKeychainId` set.
     - `configuredModels` has 2 entries under that providerId.
     - `backends.chat.enabledModels` and `backends.opencode.enabledModels` both include those 2 ids.
   - Kebab → **Configure**. Dialog opens prefilled. Add `claude-haiku-4-5` → **Save changes**. Table now shows 3 models.
   - Kebab → **Remove provider**. Confirm. Row disappears. `data.json`: provider, configured models, and both backend entries are gone (no orphans).
   - Reopen Obsidian. State persists; catalog loads from disk cache, no network call.

---

## 9. Anticipated follow-up PRs (out of scope here, but design with them in mind)

- **Template flow PR**: Implements `addTemplateProvider` + `addModels`, enables the dashed CTA, adds `AddCustomModelDialog`, surfaces `BUILTIN_PROVIDER_TEMPLATES`. Reuses `ConfigureProviderDialog` with a `mode: "new-template"` state.
- **Per-model edit PR**: Adds the kebab on individual model rows in `ByokGlobalTable`, calls `coordinator.removeConfiguredModel`.
- **Backend pickers migration PR**: Migrates the Simple Chat / OpenCode model pickers to read from `backendPickerAtomFamily(<backend>)` instead of the legacy `settings.activeModels` array. Out of scope here but unblocked once this PR lands.
