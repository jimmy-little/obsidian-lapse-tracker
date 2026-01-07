# Lapse - Compact Time Tracker for Obsidian

A lightweight time tracking plugin for Obsidian that combines the best of task management and time tracking.

## Features

- **Compact Timer Widget**: Add time trackers to any note with a simple code block
- **Segmented Time Entries**: Track multiple time segments per page
- **Frontmatter Integration**: Automatically updates note frontmatter with tracking data
- **Active Timer Sidebar**: Monitor all running timers in a dedicated sidebar view
- **Reporting & Charts**: Visualize your time tracking data

## Usage

Add a time tracker to any note using a code block:

\`\`\`lapse
\`\`\`

Or with a custom label:

\`\`\`lapse
Working on feature X
\`\`\`

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

## Development

```bash
# Install dependencies
npm install

# Start development build (watches for changes)
npm run dev

# Create production build
npm run build
```

## License

MIT License - see [LICENSE](LICENSE) file for details.
