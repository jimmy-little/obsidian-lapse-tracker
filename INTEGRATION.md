# Lapse — integration for other Obsidian plugins

Use this when building a companion plugin (e.g. a project manager) that should show Lapse Quick Start actions when **Lapse** is installed.

**Lapse manifest id:** `lapse-tracker`  
**Public surface:** `app.plugins.getPlugin('lapse-tracker')?.api` (same object as `.lapsePublicApi`)

There is **no** required entry in your `manifest.json` — treat Lapse as an optional dependency and check at runtime.

---

## Detect Lapse

```ts
import type { Plugin } from 'obsidian';

// Minimal typing (copy into your plugin; Lapse exports these from its source if you vendor types)
export interface LapseQuickStartItemPublic {
  kind: 'template' | 'project';
  templatePath: string | null;
  templateName: string;
  project: string | null;
  projectColor: string | null;
  groupValue: string | null;
  projectSourcePath: string | null;
  area: string | null;
  timerDescription: string | null;
}

export interface LapsePublicApi {
  readonly pluginId: 'lapse-tracker';
  getQuickStartItems(): Promise<LapseQuickStartItemPublic[]>;
  executeQuickStart(item: LapseQuickStartItemPublic): Promise<void>;
  invalidateQuickStartCache(): void;
}

type LapsePlugin = Plugin & { api?: LapsePublicApi };

function getLapseApi(app: App): LapsePublicApi | undefined {
  return (app.plugins.getPlugin('lapse-tracker') as LapsePlugin | null)?.api;
}
```

If your plugin may load **after** Lapse, also listen once:

```ts
window.addEventListener('lapse-tracker:public-api-ready', (e: Event) => {
  const ce = e as CustomEvent<{ pluginId: string; api: LapsePublicApi }>;
  const { api } = ce.detail;
  // e.g. refresh your project UI to show Lapse buttons
});
```

On Lapse unload: `lapse-tracker:public-api-unload` (same `detail.pluginId`).

---

## Fetch Quick Start rows

Same data as Lapse’s Quick Start view (template-folder timers + optional default project folder).

```ts
const api = getLapseApi(this.app);
if (!api) return;

const items = await api.getQuickStartItems();
```

Filter however you need (by `project`, `groupValue`, `templateName`, etc.):

```ts
const projectName = 'My Project'; // wikilink text or plain name — match how Lapse stores `project` in frontmatter
const forProject = items.filter(
  (i) =>
    (i.project && i.project.replace(/\[\[|\]\]/g, '').trim() === projectName) ||
    i.groupValue === projectName
);
```

---

## Run the same action as clicking Quick Start

```ts
try {
  await api.executeQuickStart(item);
} catch (err) {
  console.error('Lapse executeQuickStart failed', err);
  // invalid item, missing template path, vault error, etc.
}
```

- **`kind: 'template'`** — `templatePath` must be the vault path to the `.md` template (as returned by `getQuickStartItems`).
- **`kind: 'project'`** — folder/hub shortcut; `project` must be set; `templatePath` is `null`.

Do **not** mutate frozen objects returned from `getQuickStartItems`; pass them through or shallow-copy if you change fields.

---

## Invalidate Lapse’s Quick Start cache

After bulk template/folder changes (optional):

```ts
api.invalidateQuickStartCache();
```

---

## UX notes

- `executeQuickStart` opens new notes / tabs using Lapse’s existing rules (save path, default template, project shortcuts, etc.).
- If Lapse is disabled, `getPlugin('lapse-tracker')` is falsy — hide Lapse UI in your plugin.

---

## Cursor prompt (paste into the other repo)

You can paste the block below into Cursor when implementing the feature:

```
Integrate optional Obsidian plugin Lapse (id: lapse-tracker).

1. At runtime, resolve the API with:
   (app.plugins.getPlugin('lapse-tracker') as any)?.api
   Type it as LapsePublicApi with methods:
   - getQuickStartItems(): Promise<LapseQuickStartItemPublic[]>
   - executeQuickStart(item): Promise<void>  // throws on error
   - invalidateQuickStartCache(): void

2. LapseQuickStartItemPublic fields: kind ('template'|'project'), templatePath (string|null), templateName, project, projectColor, groupValue, projectSourcePath, area, timerDescription.

3. If Lapse is missing, hide Lapse-related UI. Optionally listen on window for 'lapse-tracker:public-api-ready' to refresh when Lapse loads after us.

4. See upstream doc: INTEGRATION.md in the lapse-tracker repo for full examples.
```
