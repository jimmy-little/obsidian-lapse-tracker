# Lapse - Compact Time Tracker for Obsidian

A lightweight time tracking plugin for Obsidian that combines the best of task management and time tracking with powerful reporting and visualization.

## Features

### Core Functionality
- **Compact Timer Widget**: Add time trackers to any note with a simple code block
- **Segmented Time Entries**: Track multiple time segments per page
- **Frontmatter Integration**: Automatically updates note frontmatter with tracking data
- **Active Timer Monitoring**: Real-time sidebar view showing all running timers across your vault
- **Card-Based Entry View**: Modern, mobile-friendly card layout for viewing and managing entries

### Reporting & Analytics
- **Time Reports View**: Comprehensive reports with Daily, Weekly, and Monthly views
- **Flexible Grouping**: Group time data by Note, Project, or Date
- **Visual Charts**: Bar charts and pie charts for time distribution
- **Today's Summary**: Pie chart in sidebar showing project breakdown for today

### Advanced Features
- **Tag Support**: Add tags to time entries with automatic default tags
- **Project Tracking**: Group entries by project from frontmatter
- **Smart Default Labels**: Configure default labels from filename, frontmatter, or free text
- **Timestamp Removal**: Option to automatically remove timestamps from filenames when using filename as label
- **Entry Management**: Edit entries with modal dialogs, delete with confirmation
- **Time Adjustments**: Fine-tune start times with quick adjustment buttons

## Usage

### Basic Timer

Add a time tracker to any note using a code block:

````markdown
```lapse
```
````

### Timer with Label

You can optionally provide a label when creating the timer:

````markdown
```lapse
Working on feature X
```
````

### Timer Controls

- **Play/Stop Button**: Start or stop the active timer
- **Expand Button**: Show/hide the list of all time entries
- **Adjust Buttons** (<< >>): Adjust the start time of the active timer
- **Add Entry**: Manually add time entries

### Views

- **Active Timers Sidebar**: Click the clock icon in the ribbon or use Command Palette → "Show active timers"
- **Time Reports**: Command Palette → "Show time reports" for detailed analytics

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

### Tags

- **Default tag on note**: Tag to add to notes when entries are created (default: `#lapse`)
- **Default tag on time entries**: Tag to automatically add to new time entries

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
