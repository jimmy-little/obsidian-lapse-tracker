# Lapse - Compact Time Tracker for Obsidian

A lightweight, powerful time tracking plugin for Obsidian that combines elegant inline timers with flexible querying, comprehensive reporting, and beautiful visualizations.

## Features

### Core Functionality
- **Compact Timer Widget**: Add time trackers to any note with a simple code block
- **Segmented Time Entries**: Track multiple time segments per page
- **Frontmatter Integration**: Automatically updates note frontmatter with tracking data
- **Activity Monitoring**: Real-time sidebar view showing all running timers across your vault
- **Card-Based Entry View**: Modern, mobile-friendly card layout for viewing and managing entries

### Reporting & Analytics
- **Inline Report Queries**: Create custom filtered reports directly in your notes with simple query syntax
- **Time Reports View**: Comprehensive reports with Daily, Weekly, and Monthly views
- **Flexible Grouping**: Group time data by Note, Project, Date, or Tag
- **Visual Charts**: Bar charts and pie charts for time distribution
- **Today's Summary**: Pie chart in sidebar showing project breakdown for today

### Advanced Features
- **Tag Support**: Add tags to time entries with automatic default tags
- **Project Tracking**: Group entries by project from frontmatter
- **Smart Default Labels**: Configure default labels from filename, frontmatter, or free text
- **Timestamp Removal**: Option to automatically remove timestamps from filenames when using filename as label
- **Entry Management**: Edit entries with modal dialogs, delete with confirmation
- **Time Adjustments**: Fine-tune start times with quick adjustment buttons
- **Command Palette**: Quick access to add timers, start/stop timers, and open views
- **Performance Optimized**: Persistent cache for fast reporting across large vaults
- **Folder Exclusion**: Exclude folders with glob patterns to improve performance and reduce noise

## Usage

### Basic Timer

Add a time tracker to any note using a code block:

````markdown
```lapse
```
````

### Quick Start Timer

Use the **"Add and start time tracker"** command from the command palette to insert a timer and immediately start tracking. This creates a `lapse` block and starts the timer in one action.

### Timer Controls

- **Play/Stop Button**: Start or stop the active timer
- **Expand Button**: Show/hide the list of all time entries
- **Adjust Buttons** (<< >>): Adjust the start time of the active timer
- **Add Entry**: Manually add time entries

### Inline Reports

Create custom time reports directly in your notes using query blocks:

````markdown
```lapse-report
project: taxonomy
period: thisWeek
display: summary
chart: pie
```
````

#### Query Options

**Filters:**
- `project: text` - Filter by project name (partial match, case-insensitive)
- `tag: text` - Filter by tag (searches both note tags and entry tags, partial match)
- `note: text` - Filter by note name (partial match, case-insensitive)
- `from: YYYY-MM-DD` - Start date (defaults to today)
- `to: YYYY-MM-DD` - End date (defaults to today)
- `period: preset` - Use a preset date range: `today`, `thisWeek`, `thisMonth`, `lastWeek`, `lastMonth`

**Display Options:**
- `display: table` - Show grouped table with entry counts (default)
- `display: summary` - Show only totals and breakdown
- `display: chart` - Show only chart and legend (no table or summary)

**Grouping:**
- `group-by: project` - Group by project (default)
- `group-by: date` - Group by date
- `group-by: tag` - Group by first tag

**Charts:**
- `chart: pie` - Show pie chart
- `chart: bar` - Show bar chart
- `chart: none` - No chart (default)

#### Examples

**This week's summary:**
````markdown
```lapse-report
period: thisWeek
display: summary
chart: pie
```
````

**Project time this month:**
````markdown
```lapse-report
project: client work
period: thisMonth
display: table
chart: bar
```
````

**Last week by date:**
````markdown
```lapse-report
period: lastWeek
group-by: date
display: table
```
````

**Custom date range:**
````markdown
```lapse-report
from: 2026-01-01
to: 2026-01-07
group-by: date
display: table
chart: bar
```
````

**Entries with specific tag:**
````markdown
```lapse-report
tag: urgent
period: today
group-by: project
display: table
```
````

**Chart only (no table or summary):**
````markdown
```lapse-report
period: thisWeek
display: chart
chart: pie
```
````

### Views & Commands

**Sidebar Views:**
- **Activity Sidebar**: Click the clock icon in the ribbon or use Command Palette → "Lapse: Show activity"
- **Time Reports**: Click the bar chart icon in the ribbon or use Command Palette → "Lapse: Show time reports"

**Available Commands:**
- `Lapse: Add time tracker` - Insert a `lapse` code block at cursor
- `Lapse: Add and start time tracker` - Insert a `lapse` code block and immediately start the timer
- `Lapse: Quick start timer` - Toggle timer in current note (start/stop)
- `Lapse: Show activity` - Open Activity sidebar
- `Lapse: Show time reports` - Open Time Reports view

## Installation

### From Obsidian Community Plugins (Coming Soon)

1. Open Settings → Community Plugins
2. Search for "Lapse"
3. Click Install, then Enable

### Manual Installation

1. Download the latest release from GitHub
2. Extract files to `.obsidian/plugins/lapse-tracker/`
3. Reload Obsidian
4. Enable the plugin in Settings → Community Plugins

### Using BRAT (Beta Release Auto-update Tool)

1. Install the BRAT plugin
2. Add repository: `jimmy-little/obsidian-lapse-tracker`
3. Enable the plugin in Settings → Community Plugins

## Configuration

### Default Time Entry Label

Configure how default labels are determined:
- **Free Text**: Use a custom default label
- **Frontmatter**: Use a value from note frontmatter (e.g., project name)
- **File Name**: Use the note's filename (with optional timestamp removal)

### Display Options

- **Hide timestamps in views**: Remove timestamps from note names in Activity and Reports views
- **First day of week**: Set the first day of the week for weekly reports (Sunday, Monday, etc.)

### Tags

- **Default tag on note**: Tag to add to notes when entries are created (default: `#lapse`)
- **Default tag on time entries**: Tag to automatically add to new time entries

### Timer Controls

- **Show seconds**: Display seconds in timer (default: true)
- **Time Adjustment**: Number of minutes to adjust with << and >> buttons (default: 5)

### Performance

- **Excluded folders**: Folders to exclude from time tracking indexing and reports
  - Supports glob patterns for flexible matching
  - Example patterns:
    - `Templates` - Exclude exact folder name
    - `*/2020/*` - Exclude 2020 folders one level deep
    - `**/2020/**` - Exclude 2020 folders at any depth
    - `**/Archive` - Exclude any folder ending in "Archive"
  - Improves performance for large vaults
  - Reduces cache size and memory usage

### Frontmatter Keys

Customize the frontmatter keys used:
- `startTimeKey`: Key for earliest start time (default: `startTime`)
- `endTimeKey`: Key for latest end time (default: `endTime`)
- `entriesKey`: Key for entries array (default: `lapseEntries`)
- `totalTimeKey`: Key for total time tracked (default: `totalTimeTracked`)
- `projectKey`: Key for project name (default: `project`)

## Development

```bash
# Install dependencies
npm install

# Start development build (watches for changes)
npm run dev

# Create production build
npm run build

# Install to Obsidian vault
npm install

# Create release zip
npm run release-zip
```

## Project Structure

```
obsidian-lapse-tracker/
├── main.ts              # Main plugin code
├── styles.css           # Plugin styles
├── manifest.json        # Plugin manifest
├── package.json         # NPM dependencies
├── tsconfig.json        # TypeScript configuration
├── esbuild.config.mjs   # Build configuration
├── install.mjs          # Installation script
├── version-bump.mjs     # Version bumping script
├── create-release-zip.mjs # Release zip creation
└── .github/
    └── workflows/
        └── release.yml  # GitHub Actions release workflow
```

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Author

Jimmy Little - [GitHub](https://github.com/jimmylittle)
