# Research: TaskNotes Custom Views for Obsidian Bases

## How TaskNotes Works

Based on the `.base` files you provided, TaskNotes registers **custom view types** that appear in Bases' view configuration dropdown. When you create or configure a Base, you can select from:

- Standard Bases views: `table`, `cards`, `list`
- **TaskNotes custom views**: `tasknotesTaskList`, `tasknotesKanban`, `tasknotesCalendar`, `tasknotesMiniCalendar`

These custom view types are defined in the `.base` files like this:

```yaml
views:
  - type: tasknotesTaskList
    name: Task List
    # ... configuration options
  - type: tasknotesKanban
    name: Kanban Board
    # ... configuration options
  - type: tasknotesCalendar
    name: Calendar
    # ... configuration options
```

## Key Insight from BasesDataAdapter

**TaskNotes views consume Bases data through a public API**, not by registering view types directly. The [BasesDataAdapter](https://raw.githubusercontent.com/callumalpass/tasknotes/main/src/bases/BasesDataAdapter.ts) shows:

1. **Views receive a `basesView` object** that contains:
   - `basesView.data.data` - array of entries from Bases query
   - `basesView.data.groupedData` - pre-grouped data
   - `basesView.config.getSort()` - sort configuration
   - `basesView.config.getOrder()` - visible property IDs
   - `entry.getValue(propertyId)` - property values

2. **This suggests**:
   - TaskNotes views are likely registered with Bases somehow (still need to find this)
   - Bases instantiates TaskNotes view classes when `.base` files specify `type: tasknotesTaskList`
   - Bases passes the `basesView` object to the view constructor or through view state
   - Views use the public API to extract and display data

3. **What we still need to find**:
   - How TaskNotes registers view types with Bases (the registration mechanism)
   - How Bases passes `basesView` to custom views (constructor signature or view state)

## Current Implementation in Lapse Tracker

Your plugin currently uses standalone views via the `ItemView` class. Here's how it works:

### Basic Pattern

1. **Register the view** in `onload()`:
```typescript
this.registerView(
    'lapse-sidebar',
    (leaf) => new LapseSidebarView(leaf, this)
);
```

2. **Create a view class** extending `ItemView`:
```typescript
class LapseSidebarView extends ItemView {
    getViewType(): string {
        return 'lapse-sidebar';
    }
    
    getDisplayText(): string {
        return 'Activity';
    }
    
    getIcon(): string {
        return 'clock';
    }
    
    async onOpen() {
        await this.render();
    }
    
    async render() {
        const container = this.containerEl.children[1];
        // Build your custom UI here
    }
}
```

3. **Activate the view**:
```typescript
activateView() {
    const workspace = this.app.workspace;
    let leaf = workspace.getLeavesOfType('lapse-sidebar')[0];
    
    if (!leaf) {
        leaf = workspace.getRightLeaf(false);
        await leaf.setViewState({ type: 'lapse-sidebar' });
    }
    
    workspace.revealLeaf(leaf);
}
```

## Investigating TaskNotes

### Finding the Repository

1. **Search GitHub**:
   - Go to https://github.com/search
   - Search for: `TaskNotes obsidian plugin`
   - Look for repositories with names like `obsidian-tasknotes` or similar

2. **Check Obsidian Community Plugins**:
   - Visit https://obsidian.md/plugins
   - Search for "TaskNotes"
   - The plugin page usually links to the GitHub repository

### What to Look For

Once you find the TaskNotes repository, examine:

1. **View Registration**:
   - Search for `registerView` in the codebase
   - Look for view types related to "Bases" or custom views

2. **Bases Integration**:
   - Search for "Bases" or "base" in the code
   - Look for any special APIs or methods related to Bases
   - Check if they're using a specific Obsidian API for Bases

3. **Custom View Implementation**:
   - Find classes extending `ItemView` or similar
   - Look at how they render custom content
   - Check if they're intercepting or modifying existing Bases views

4. **Obsidian API Usage**:
   - Check for imports from `obsidian` package
   - Look for workspace manipulation
   - See if they're using any special view types

### Key Files to Examine

- `main.ts` or `main.js` - Main plugin file
- `manifest.json` - Plugin metadata and dependencies
- Any view-related TypeScript files
- README.md - May contain documentation about Bases integration

## How to Implement Custom Bases Views

Based on the TaskNotes implementation, here's what you need to do:

### 1. Register Custom View Types with Bases

Bases must have a plugin API method to register custom view types. Look for something like:

```typescript
// Hypothetical API - need to find actual method
this.app.plugins.plugins.bases?.registerViewType('lapseTimeTracker', {
    name: 'Lapse Time Tracker',
    icon: 'clock',
    viewClass: LapseBasesView
});
```

### 2. Create a View Class for Bases

The view class likely needs to:
- Extend a Bases-specific view class (not `ItemView`)
- Implement methods to render your custom UI
- Handle Bases data (filters, formulas, etc.)
- Respond to Bases configuration changes

```typescript
class LapseBasesView extends BasesView { // Hypothetical class name
    render(data: BasesData) {
        // Render your custom time tracking UI
        // Use data from Bases (filtered notes, formulas, etc.)
    }
}
```

### 3. Configuration in .base Files

Once registered, users can add your view type to their `.base` files:

```yaml
views:
  - type: lapseTimeTracker
    name: Time Tracking View
    options:
      showDuration: true
      timePeriod: thisWeek
```

## Finding the Actual API

To find the real implementation:

## Next Steps

1. **Find TaskNotes Repository**:
   - Check Obsidian Community Plugins: https://obsidian.md/plugins
   - Search GitHub for "TaskNotes obsidian"
   - The plugin page should link to the repository

2. **Examine TaskNotes Source Code**:
   ```bash
   git clone <tasknotes-repo-url>
   cd <tasknotes-repo>
   # Look for Bases integration
   grep -r "registerViewType" .
   grep -r "Bases" .
   grep -r "tasknotes" . --include="*.ts"
   # Look for how they register custom view types
   ```

3. **Check Obsidian Type Definitions**:
   ```bash
   # In your plugin's node_modules
   grep -r "registerViewType\|BasesView\|BaseView" node_modules/obsidian/
   # Look for Bases plugin API
   find node_modules/obsidian -name "*.d.ts" -exec grep -l "Bases\|Base" {} \;
   ```

4. **Check Bases Plugin**:
   - Bases is itself a plugin
   - Look for Bases plugin in `.obsidian/plugins/`
   - Examine its source or type definitions
   - Look for public APIs it exposes to other plugins

5. **Ask in Community**:
   - Obsidian Discord or Forum
   - GitHub Discussions on TaskNotes repo
   - Contact TaskNotes developer directly

## Resources

- **Obsidian Plugin API**: Check `node_modules/obsidian/` for type definitions
- **Obsidian Developer Docs**: https://docs.obsidian.md/
- **Plugin Examples**: Other plugins that integrate with Obsidian features
- **TaskNotes Repository**: (To be found)

## Example: What a Lapse Tracker Bases View Might Look Like

Based on the TaskNotes pattern, here's what you might implement:

### 1. Register the View Type

```typescript
// In your plugin's onload()
async onload() {
    // ... existing code ...
    
    // Register custom Bases view type
    if (this.app.plugins.plugins.bases) {
        this.app.plugins.plugins.bases.registerViewType('lapseTimeTracker', {
            name: 'Lapse Time Tracker',
            icon: 'clock',
            viewClass: LapseBasesTimeView
        });
    }
}
```

### 2. Create the View Class

```typescript
class LapseBasesTimeView extends BasesView {
    plugin: LapsePlugin;
    
    constructor(plugin: LapsePlugin, config: BasesViewConfig) {
        super(config);
        this.plugin = plugin;
    }
    
    async render(data: BasesData) {
        // data contains filtered notes from Bases
        // Calculate time tracking data
        const timeEntries = await this.plugin.getTimeEntriesForNotes(data.notes);
        
        // Render custom UI
        const container = this.containerEl;
        container.empty();
        
        // Build your time tracking visualization
        // Use data from Bases (filters, formulas, etc.)
    }
}
```

### 3. User Configuration in .base File

```yaml
views:
  - type: lapseTimeTracker
    name: Weekly Time Report
    filters:
      and:
        - file.hasTag("lapse")
    options:
      timePeriod: thisWeek
      groupBy: project
      showChart: true
```

## Implementation Status

### ✅ Completed

1. **Created `LapseBasesListView` class** - Displays notes and their time tracking entries in a list format
2. **Created `LapseBasesCalendarView` class** - Displays time tracking entries on a calendar grid
3. **Added `getTimeTrackingDataForNotes()` method** - Helper to extract time tracking data from Bases-filtered notes
4. **Added `registerBasesViews()` method** - Registers view types with Bases (placeholder API)
5. **Added CSS styles** - Styling for both list and calendar views

### ⚠️ Needs Verification

1. **Bases API Method Name** - The actual method to register view types needs to be verified:
   - Current implementation tries multiple methods: `registerViewType()`, `addViewType()`, `registerCustomView()`, `viewTypes.set()`, direct property assignment
   - TaskNotes repository: https://github.com/callumalpass/tasknotes
   - The code now logs available methods for debugging
   - Check console output when plugin loads to see which method works

2. **View Class Interface** - The exact interface Bases expects for view classes:
   - Current: Constructor takes `(plugin, containerEl, config)` and has `render(notes)` method
   - May need to extend a specific Bases class or implement an interface

3. **Data Format** - How Bases passes filtered notes to custom views:
   - Current assumption: `render(notes: TFile[])`
   - May include additional metadata or configuration

### 🔍 Next Steps

1. **Check Console Output** (IMPORTANT):
   - Open Obsidian Developer Console (Ctrl/Cmd + Shift + I)
   - Reload Obsidian
   - Look for messages starting with "Lapse:"
   - Share the console output - it will show:
     - Whether Bases plugin is found
     - What methods are available
     - Which registration method was attempted
     - Any errors

2. **Examine TaskNotes Source Code**:
   - Repository: https://github.com/callumalpass/tasknotes
   - Look in `src/` directory for Bases integration
   - Search for "registerViewType", "tasknotesTaskList", or "bases"
   - Check `main.ts` for how they register views

3. **Alternative Approach**:
   - If Bases doesn't expose a public API, TaskNotes might:
     - Use a different registration mechanism
     - Register views through a manifest or configuration file
     - Use Bases' internal APIs (may require different approach)
   - Check if Bases has documentation for plugin developers

4. **Check Bases Plugin Installation**:
   - Look in `.obsidian/plugins/bases/` for source files
   - Check for type definitions or API documentation
   - Look for examples of how other plugins integrate

## Notes

- **Bases is a plugin** - it likely exposes a public API for other plugins
- **View types are registered differently** than standalone `ItemView` views
- **Custom view types appear in Bases UI** - they're integrated into Bases' view system
- **Configuration is in .base files** - users configure your views via YAML
- **Current implementation is ready** - just needs the correct API method name

## Current Status (Last Updated)

### ✅ Completed
1. **Registration Working**: Successfully registered `lapseTimeList` and `lapseTimeCalendar` view types with Bases
2. **Registration Method**: Using `factory` function pattern (matching TaskNotes) - registered in `basesPlugin.instance.registrations`
3. **Factory Function**: Factory receives plugin instance as first argument, creates view instances
4. **Views Loading**: Views are being instantiated - factory and constructors are being called

### 🔧 In Progress
1. **Constructor Parameters**: Bases calls constructor with `[basesView, containerEl, null]` pattern:
   - `args[0]` = basesView object (has properties: `_loaded`, `_events`, `_children`, `currentFile`, `query`)
   - `args[1]` = containerEl (HTMLElement with class `bases-view`)
   - `args[2]` = null
   - Need to update constructors to extract basesView from args[0] instead of args[2]

2. **basesView Data Extraction**: Views need to extract data from `basesView.data.data` to get the filtered files
   - Currently `basesView` is being set to null in constructors
   - Need to properly extract `basesView` from constructor args[0]

### 📝 Next Steps
1. **Fix Constructor Parameter Extraction**:
   - Update `LapseBasesListView` and `LapseBasesCalendarView` constructors
   - Extract `basesView` from `args[0]` (not args[2])
   - Extract `containerEl` from `args[1]`
   - Get plugin from factory closure or extract from basesView

2. **Test Data Extraction**:
   - Verify `basesView.data.data` contains the filtered files
   - Check if `basesView.data.groupedData` exists
   - Ensure `basesView.config` is available for configurationn

3. **Implement Render Logic**:
   - Call `render()` method after constructor
   - Extract files from `basesView.data.data`
   - Get time tracking data using `plugin.getTimeTrackingDataForNotes(files)`
   - Display the data in the view

4. **Clean Up Debug Logging**:
   - Remove excessive console.log statements once views are working
   - Keep essential error logging

### 🔍 Key Findings
- **Registration Structure**: Must use `{ name, icon, factory, options }` - not `viewClass`
- **Factory Signature**: `factory(plugin, containerEl?)` - receives plugin as first arg
- **Constructor Signature**: Bases calls with `(basesView, containerEl, null)` - basesView is first arg!
- **Registration Location**: `app.internalPlugins.plugins.bases.instance.registrations[viewType]`

### 📍 Files to Update Next
- `main.ts`: Update `LapseBasesListView` and `LapseBasesCalendarView` constructors (lines ~5984 and ~6117)
- `bases/registration.ts`: Factory function might need adjustment if plugin extraction is needed
