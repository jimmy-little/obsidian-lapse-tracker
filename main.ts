import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, MarkdownPostProcessorContext, TFile, setIcon, Modal } from 'obsidian';

interface LapseSettings {
	dateFormat: string;
	showSeconds: boolean;
	startTimeKey: string;
	endTimeKey: string;
	entriesKey: string;
	totalTimeKey: string;
	projectKey: string;
	defaultLabelType: 'freeText' | 'frontmatter' | 'fileName';
	defaultLabelText: string;
	defaultLabelFrontmatterKey: string;
	removeTimestampFromFileName: boolean;
	hideTimestampsInViews: boolean;
	defaultTagOnNote: string;
	defaultTagOnTimeEntries: string;
	timeAdjustMinutes: number;
	firstDayOfWeek: number; // 0 = Sunday, 1 = Monday, etc.
	excludedFolders: string[]; // Glob patterns for folders to exclude
	showStatusBar: boolean; // Show active timer(s) in status bar
}

const DEFAULT_SETTINGS: LapseSettings = {
	dateFormat: 'YYYY-MM-DD HH:mm:ss',
	showSeconds: true,
	startTimeKey: 'startTime',
	endTimeKey: 'endTime',
	entriesKey: 'lapseEntries',
	totalTimeKey: 'totalTimeTracked',
	projectKey: 'project',
	defaultLabelType: 'freeText',
	defaultLabelText: '',
	defaultLabelFrontmatterKey: 'project',
	removeTimestampFromFileName: false,
	hideTimestampsInViews: true,
	defaultTagOnNote: '#lapse',
	defaultTagOnTimeEntries: '',
	timeAdjustMinutes: 5,
	firstDayOfWeek: 0, // 0 = Sunday
	excludedFolders: [], // No folders excluded by default
	showStatusBar: true // Show active timers in status bar by default
}

interface TimeEntry {
	id: string;
	label: string;
	startTime: number | null;
	endTime: number | null;
	duration: number;
	isPaused: boolean;
	tags: string[];
}

interface LapseQuery {
	project?: string;
	tag?: string;
	note?: string;
	from?: string;
	to?: string;
	period?: 'today' | 'thisWeek' | 'thisMonth' | 'lastWeek' | 'lastMonth';
	groupBy?: 'project' | 'date' | 'tag';
	display?: 'table' | 'summary' | 'chart';
	chart?: 'bar' | 'pie' | 'none';
}

interface PageTimeData {
	entries: TimeEntry[];
	totalTimeTracked: number;
}

interface CachedFileData {
	lastModified: number; // File mtime in milliseconds
	entries: TimeEntry[];
	project: string | null;
	totalTime: number;
}

interface EntryCache {
	[filePath: string]: CachedFileData;
}

export default class LapsePlugin extends Plugin {
	settings: LapseSettings;
	timeData: Map<string, PageTimeData> = new Map();
	entryCache: EntryCache = {}; // Persistent cache indexed by file path
	cacheSaveTimeout: number | null = null; // Debounce cache saves
	cacheLoading: boolean = false; // Track if cache is still loading
	cacheLoaded: Promise<void> | null = null; // Promise to wait for cache loading
	statusBarItem: HTMLElement | null = null; // Status bar element
	statusBarUpdateInterval: number | null = null; // Interval for updating status bar
	pendingSaves: Promise<void>[] = []; // Track pending save operations

	async onload() {
		const pluginStartTime = Date.now();
		await this.loadSettings();

		console.log(`Lapse: Plugin loading... (${Date.now() - pluginStartTime}ms)`);

		// Register the code block processors
		this.registerMarkdownCodeBlockProcessor('lapse', this.processTimerCodeBlock.bind(this));
		this.registerMarkdownCodeBlockProcessor('lapse-report', this.processReportCodeBlock.bind(this));

		// Register the sidebar view
		this.registerView(
			'lapse-sidebar',
			(leaf) => new LapseSidebarView(leaf, this)
		);

		// Register the reports view
		this.registerView(
			'lapse-reports',
			(leaf) => new LapseReportsView(leaf, this)
		);

		// Add ribbon icons
		this.addRibbonIcon('clock', 'Lapse: Show Activity', () => {
			this.activateView();
		});

		this.addRibbonIcon('bar-chart-2', 'Lapse: Show Time Reports', () => {
			this.activateReportsView();
		});

		// Add command to insert timer
		this.addCommand({
			id: 'insert-lapse-timer',
			name: 'Add time tracker',
			editorCallback: (editor) => {
				editor.replaceSelection('```lapse\n\n```');
			},
			hotkeys: []
		});

		// Add command to insert timer and auto-start it
		this.addCommand({
			id: 'insert-lapse-autostart',
			name: 'Add and start time tracker',
			editorCallback: async (editor, view) => {
				const file = view.file;
				if (!file) return;
				
				const filePath = file.path;
				
				// Insert the lapse code block
				editor.replaceSelection('```lapse\n\n```');
				
				// Create the timer entry in memory
				if (!this.timeData.has(filePath)) {
					this.timeData.set(filePath, {
						entries: [],
						totalTimeTracked: 0
					});
				}
				
				const pageData = this.timeData.get(filePath)!;
				
				// Check if there's already an active timer
				const hasActiveTimer = pageData.entries.some(e => e.startTime !== null && e.endTime === null);
				
				if (!hasActiveTimer) {
					// Get default label
					const label = await this.getDefaultLabel(filePath);
					
					// Create new timer entry
					const newEntry: TimeEntry = {
						id: `${filePath}-${Date.now()}-${Math.random()}`,
						label: label,
						startTime: Date.now(),
						endTime: null,
						duration: 0,
						isPaused: false,
						tags: this.getDefaultTags()
					};
					
					pageData.entries.push(newEntry);
					
					// Add default tag to note
					await this.addDefaultTagToNote(filePath);
					
					// Update frontmatter
					await this.updateFrontmatter(filePath);
					
					// Update sidebar
					this.app.workspace.getLeavesOfType('lapse-sidebar').forEach(leaf => {
						if (leaf.view instanceof LapseSidebarView) {
							leaf.view.refresh();
						}
					});
				}
				
				// Switch to reading mode so the widget appears immediately
				const activeLeaf = this.app.workspace.activeLeaf;
				if (activeLeaf && activeLeaf.view.getViewType() === 'markdown') {
					const state = activeLeaf.view.getState();
					await activeLeaf.setViewState({
						type: 'markdown',
						// @ts-ignore - state has mode property
						state: { ...state, mode: 'preview' }
					});
				}
			},
			hotkeys: []
		});

		// Add command to quick-start timer in current note
		this.addCommand({
			id: 'quick-start-timer',
			name: 'Quick start timer',
			editorCallback: async (editor, view) => {
				const file = view.file;
				if (!file) return;
				
				const filePath = file.path;
				
				// Check if there's already an active timer
				const pageData = this.timeData.get(filePath);
				const hasActiveTimer = pageData?.entries.some(e => e.startTime !== null && e.endTime === null);
				
				if (hasActiveTimer) {
					// Stop the active timer instead
					const activeEntry = pageData!.entries.find(e => e.startTime !== null && e.endTime === null);
					if (activeEntry) {
						activeEntry.endTime = Date.now();
						activeEntry.duration += (activeEntry.endTime - activeEntry.startTime!);
						await this.updateFrontmatter(filePath);
						
						// Update sidebar
						this.app.workspace.getLeavesOfType('lapse-sidebar').forEach(leaf => {
							if (leaf.view instanceof LapseSidebarView) {
								leaf.view.refresh();
							}
						});
					}
				} else {
					// Start a new timer
					const label = await this.getDefaultLabel(filePath);
					const newEntry: TimeEntry = {
						id: `${filePath}-${Date.now()}-${Math.random()}`,
						label: label,
						startTime: Date.now(),
						endTime: null,
						duration: 0,
						isPaused: false,
						tags: this.getDefaultTags()
					};
					
					if (!this.timeData.has(filePath)) {
						this.timeData.set(filePath, {
							entries: [],
							totalTimeTracked: 0
						});
					}
					
					const data = this.timeData.get(filePath)!;
					data.entries.push(newEntry);
					
					// Add default tag to note
					await this.addDefaultTagToNote(filePath);
					
					// Update frontmatter
					await this.updateFrontmatter(filePath);
					
					// Update sidebar
					this.app.workspace.getLeavesOfType('lapse-sidebar').forEach(leaf => {
						if (leaf.view instanceof LapseSidebarView) {
							leaf.view.refresh();
						}
					});
				}
				
				// Force widget to update by briefly toggling view mode
				const activeLeaf = this.app.workspace.activeLeaf;
				if (activeLeaf && activeLeaf.view.getViewType() === 'markdown') {
					const state = activeLeaf.view.getState();
					// @ts-ignore - state has mode property
					const currentMode = state.mode || 'source';
					const tempMode = currentMode === 'source' ? 'preview' : 'source';
					
					// Toggle away from current mode
					await activeLeaf.setViewState({
						type: 'markdown',
						// @ts-ignore
						state: { ...state, mode: tempMode }
					});
					
					// Toggle back to original mode after 50ms
					setTimeout(async () => {
						await activeLeaf.setViewState({
							type: 'markdown',
							// @ts-ignore
							state: { ...state, mode: currentMode }
						});
					}, 50);
				}
			}
		});

		// Add command to show activity sidebar
		this.addCommand({
			id: 'show-lapse-sidebar',
			name: 'Show activity',
			callback: () => {
				this.activateView();
			}
		});

		// Add command to show reports view
		this.addCommand({
			id: 'show-lapse-reports',
			name: 'Show time reports',
			callback: () => {
				this.activateReportsView();
			}
		});

		// Settings tab
		this.addSettingTab(new LapseSettingTab(this.app, this));

		// Status bar setup
		if (this.settings.showStatusBar) {
			this.statusBarItem = this.addStatusBarItem();
			this.statusBarItem.addClass('lapse-status-bar');
			this.updateStatusBar();
			// Update status bar every second
			this.statusBarUpdateInterval = window.setInterval(() => {
				this.updateStatusBar();
			}, 1000);
		}

		const totalLoadTime = Date.now() - pluginStartTime;
		console.log(`Lapse: Plugin loaded in ${totalLoadTime}ms`);
	}

	updateStatusBar() {
		if (!this.settings.showStatusBar || !this.statusBarItem) {
			return;
		}

		// Find all active timers
		const activeTimers: Array<{ filePath: string; entry: TimeEntry }> = [];
		
		for (const [filePath, pageData] of this.timeData) {
			for (const entry of pageData.entries) {
				if (entry.startTime !== null && entry.endTime === null) {
					activeTimers.push({ filePath, entry });
				}
			}
		}

		if (activeTimers.length === 0) {
			this.statusBarItem.setText('');
			this.statusBarItem.hide();
		} else if (activeTimers.length === 1) {
			// Single timer: "{Time Entry Name} - {elapsed time}"
			const { entry } = activeTimers[0];
			const elapsed = entry.duration + (Date.now() - entry.startTime!);
			const timeText = this.formatTimeForTimerDisplay(elapsed);
			this.statusBarItem.setText(`${entry.label} - ${timeText}`);
			this.statusBarItem.show();
		} else {
			// Multiple timers: "{2} timers - {total elapsed time}"
			let totalElapsed = 0;
			for (const { entry } of activeTimers) {
				totalElapsed += entry.duration + (Date.now() - entry.startTime!);
			}
			const timeText = this.formatTimeForTimerDisplay(totalElapsed);
			this.statusBarItem.setText(`${activeTimers.length} timers - ${timeText}`);
			this.statusBarItem.show();
		}
	}

	async loadEntriesFromFrontmatter(filePath: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!file || !(file instanceof TFile)) return;

		try {
			const content = await this.app.vault.read(file);
			const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
			const match = content.match(frontmatterRegex);

			if (!match) {
				return;
			}

			const frontmatter = match[1];
			const lines = frontmatter.split('\n');
			
			// Parse entries using configured key
			const entriesKey = this.settings.entriesKey;
			let inEntries = false;
			let currentEntry: any = null;
			const entries: TimeEntry[] = [];

			for (let i = 0; i < lines.length; i++) {
				const originalLine = lines[i];
				const trimmed = originalLine.trim();
				const indent = originalLine.length - originalLine.trimStart().length;
				
				if (trimmed.startsWith(`${entriesKey}:`)) {
					inEntries = true;
					continue;
				}

				if (inEntries) {
					// Check if we've exited the entries block (new top-level field with no indent)
					if (trimmed && indent === 0 && !trimmed.startsWith('-')) {
						// Save current entry if exists
						if (currentEntry) {
							entries.push({
								id: `${filePath}-${entries.length}-${Date.now()}`,
								label: currentEntry.label || 'Untitled',
								startTime: currentEntry.start ? new Date(currentEntry.start).getTime() : null,
								endTime: currentEntry.end ? new Date(currentEntry.end).getTime() : null,
								duration: (currentEntry.duration || 0) * 1000,
								isPaused: false,
								tags: currentEntry.tags || []
							});
							currentEntry = null;
						}
						inEntries = false;
						continue;
					}

					// Parse array items (indented with -)
					if (trimmed.startsWith('- label:')) {
						// Save previous entry if exists
						if (currentEntry) {
							entries.push({
								id: `${filePath}-${entries.length}-${Date.now()}`,
								label: currentEntry.label || 'Untitled',
								startTime: currentEntry.start ? new Date(currentEntry.start).getTime() : null,
								endTime: currentEntry.end ? new Date(currentEntry.end).getTime() : null,
								duration: (currentEntry.duration || 0) * 1000,
								isPaused: false,
								tags: currentEntry.tags || []
							});
						}
						currentEntry = {};
						// Extract label value, handling quotes
						const labelMatch = trimmed.match(/^- label:\s*"?([^"]*)"?/);
						currentEntry.label = labelMatch ? labelMatch[1].trim() : 'Untitled';
					} else if (trimmed.startsWith('start:') && currentEntry) {
						currentEntry.start = trimmed.replace(/start:\s*/, '').trim();
					} else if (trimmed.startsWith('end:') && currentEntry) {
						const endValue = trimmed.replace(/end:\s*/, '').trim();
						currentEntry.end = endValue || null;
					} else if (trimmed.startsWith('duration:') && currentEntry) {
						const durationStr = trimmed.replace(/duration:\s*/, '').trim();
						currentEntry.duration = parseInt(durationStr) || 0;
					} else if (trimmed.startsWith('tags:') && currentEntry) {
						// Parse tags - can be array or comma-separated
						const tagsStr = trimmed.replace(/tags:\s*/, '').trim();
						if (tagsStr.startsWith('[')) {
							// Array format: tags: [tag1, tag2]
							try {
								currentEntry.tags = JSON.parse(tagsStr);
							} catch {
								currentEntry.tags = [];
							}
						} else {
							// Comma-separated or single tag
							currentEntry.tags = tagsStr.split(',').map(t => t.trim()).filter(t => t);
						}
					}
				}
			}

			// Add last entry if exists
			if (currentEntry) {
				entries.push({
					id: `${filePath}-${entries.length}-${Date.now()}`,
					label: currentEntry.label || 'Untitled',
					startTime: currentEntry.start ? new Date(currentEntry.start).getTime() : null,
					endTime: currentEntry.end ? new Date(currentEntry.end).getTime() : null,
					duration: (currentEntry.duration || 0) * 1000,
					isPaused: false,
					tags: currentEntry.tags || []
				});
			}

			// Update page data
			if (!this.timeData.has(filePath)) {
				this.timeData.set(filePath, {
					entries: [],
					totalTimeTracked: 0
				});
			}

			const pageData = this.timeData.get(filePath)!;
			pageData.entries = entries;
			pageData.totalTimeTracked = entries.reduce((sum, e) => sum + e.duration, 0);
		} catch (error) {
			console.error('Error loading entries from frontmatter:', error);
		}
	}

	getDefaultTags(): string[] {
		const defaultTag = this.settings.defaultTagOnTimeEntries.trim();
		if (defaultTag) {
			// Remove # if present, we'll add it when displaying
			const tag = defaultTag.startsWith('#') ? defaultTag.substring(1) : defaultTag;
			return [tag];
		}
		return [];
	}

	async addDefaultTagToNote(filePath: string): Promise<void> {
		const defaultTag = this.settings.defaultTagOnNote.trim();
		if (!defaultTag) {
			return;
		}

		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!file || !(file instanceof TFile)) {
			return;
		}

		try {
			const content = await this.app.vault.read(file);
			const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
			const match = content.match(frontmatterRegex);

			// Normalize tag (remove # if present, we'll add it in frontmatter)
			const tagName = defaultTag.startsWith('#') ? defaultTag.substring(1) : defaultTag;

			if (match) {
				// Check if tag already exists in frontmatter
				const frontmatter = match[1];
				if (frontmatter.includes(`tags:`) || frontmatter.includes(`tag:`)) {
					// Tags already exist, check if our tag is there
					const tagsMatch = frontmatter.match(/tags?:\s*\[?([^\]\n]+)\]?/);
					if (tagsMatch) {
						const existingTags = tagsMatch[1].split(',').map(t => t.trim().replace(/['"#]/g, ''));
						if (existingTags.includes(tagName)) {
							return; // Tag already exists
						}
					}
					// Add tag to existing tags - use multiline flag and match only on the tags line
					const newContent = content.replace(
						/(^tags?:\s*)(.+?)$/m,
						(match, prefix, existingTagsStr) => {
							// Parse existing tags - handle both array [a, b] and single value formats
							let tagList: string[] = [];
							const arrayMatch = existingTagsStr.match(/\[(.+)\]/);
							if (arrayMatch) {
								// Array format: tags: [a, b]
								tagList = arrayMatch[1].split(',').map((t: string) => t.trim().replace(/['"#]/g, '')).filter((t: string) => t);
							} else {
								// Single value or space-separated: tags: #meeting or tags: meeting
								tagList = existingTagsStr.split(/[\s,]+/).map((t: string) => t.trim().replace(/['"#]/g, '')).filter((t: string) => t);
							}
							
							if (!tagList.includes(tagName)) {
								tagList.push(tagName);
							}
							return `${prefix}[${tagList.map((t: string) => `"${t}"`).join(', ')}]`;
						}
					);
					await this.app.vault.modify(file, newContent);
				} else {
					// Add tags field to frontmatter
					const newFrontmatter = frontmatter + `\ntags: ["${tagName}"]`;
					const newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
					await this.app.vault.modify(file, newContent);
				}
			} else {
				// No frontmatter, create it with tag
				const newContent = `---\ntags: ["${tagName}"]\n---\n\n${content}`;
				await this.app.vault.modify(file, newContent);
			}
		} catch (error) {
			console.error('Error adding tag to note:', error);
		}
	}

	async getDefaultLabel(filePath: string): Promise<string> {
		const settings = this.settings;
		
		if (settings.defaultLabelType === 'freeText') {
			return settings.defaultLabelText || 'Untitled timer';
		} else if (settings.defaultLabelType === 'frontmatter') {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (!file || !(file instanceof TFile)) {
				return 'Untitled timer';
			}
			
			try {
				const content = await this.app.vault.read(file);
				const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
				const match = content.match(frontmatterRegex);
				
				if (match) {
					const frontmatter = match[1];
					const key = settings.defaultLabelFrontmatterKey;
					const lines = frontmatter.split('\n');
					
					// Look for the key
					for (let i = 0; i < lines.length; i++) {
						const line = lines[i].trim();
						
						// Check if this line starts with the key
						if (line.startsWith(`${key}:`)) {
							// Get the value on the same line
							let value = line.replace(new RegExp(`^${key}:\\s*`), '').trim();
							
							// If empty, check next line for array item
							if (!value && i + 1 < lines.length) {
								const nextLine = lines[i + 1].trim();
								if (nextLine.startsWith('-')) {
									value = nextLine.replace(/^-\s*/, '').trim();
								}
							}
							
							if (value) {
								// Normalize: remove quotes, brackets, etc.
								value = value.replace(/^["']+|["']+$/g, ''); // Remove all surrounding quotes
								value = value.replace(/\[\[|\]\]/g, ''); // Remove [[ and ]]
								value = value.replace(/^[-*•]\s*/, ''); // Remove bullets
								value = value.trim();
								
								if (value) {
									return value;
								}
							}
							break;
						}
					}
				}
			} catch (error) {
				console.error('Error reading frontmatter for default label:', error);
			}
			
			return 'Untitled timer';
		} else if (settings.defaultLabelType === 'fileName') {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file && file instanceof TFile) {
				let fileName = file.basename || 'Untitled timer';
				if (settings.removeTimestampFromFileName) {
					fileName = this.removeTimestampFromFileName(fileName);
				}
				return fileName;
			}
			return 'Untitled timer';
		}
		
		return 'Untitled timer';
	}

	removeTimestampFromFileName(fileName: string): string {
		// Remove various timestamp patterns from filename
		// Patterns to match:
		// - ISO: 2024-01-07T18:30:00, 2024-01-07T18:30:00Z, 2024-01-07T18:30:00.000Z
		// - Obsidian: 2024-01-07, 20240107
		// - Dataview: 2024-01-07, 2024/01/07
		// - YYYYMMDD-HHMMSS: 20240107-183000, 20240107-1830
		// - Other: 2024-01-07 18:30, 2024-01-07_18:30, etc.
		
		let result = fileName;
		
		// Pattern 1: YYYYMMDD-HHMMSS or YYYYMMDD-HHMM (at start or after separator)
		result = result.replace(/(?:^|[-_\s])(\d{8})-(\d{4,6})(?:[-_\s]|$)/g, '');
		
		// Pattern 2: ISO format with T separator: YYYY-MM-DDTHH:MM:SS or variations
		result = result.replace(/(?:^|[-_\s])(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?(?:\.\d{3})?)(?:Z|[-+]\d{2}:\d{2})?(?:[-_\s]|$)/gi, '');
		
		// Pattern 3: Date with time: YYYY-MM-DD HH:MM or YYYY-MM-DD_HH:MM
		result = result.replace(/(?:^|[-_\s])(\d{4}-\d{2}-\d{2})[-_\s](\d{2}:\d{2}(?::\d{2})?)(?:[-_\s]|$)/g, '');
		
		// Pattern 4: Date only: YYYY-MM-DD or YYYY/MM/DD or YYYYMMDD (at start or after separator)
		result = result.replace(/(?:^|[-_\s])(\d{4}[-/]?\d{2}[-/]?\d{2})(?:[-_\s]|$)/g, '');
		
		// Pattern 5: Time only: HH:MM:SS or HH:MM (standalone or after separator)
		result = result.replace(/(?:^|[-_\s])(\d{2}:\d{2}(?::\d{2})?)(?:[-_\s]|$)/g, '');
		
		// Clean up multiple consecutive separators
		result = result.replace(/[-_\s]{2,}/g, ' ');
		
		// Clean up leading/trailing separators
		result = result.replace(/^[-_\s]+|[-_\s]+$/g, '');
		
		// Trim whitespace
		result = result.trim();
		
		// If result is empty after removing timestamp, return original
		return result || fileName;
	}

	patternToRegex(pattern: string): RegExp {
		// Normalize path separators to forward slash
		pattern = pattern.replace(/\\/g, '/');
		
		// Escape regex special characters except * and /
		pattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
		
		// Convert glob wildcards:
		// ** = match anything including / (use placeholder to avoid conflict)
		pattern = pattern.replace(/\*\*/g, '<<<DOUBLESTAR>>>');
		// * = match anything except /
		pattern = pattern.replace(/\*/g, '[^/]*');
		// Replace placeholder with regex for **
		pattern = pattern.replace(/<<<DOUBLESTAR>>>/g, '.*');
		
		return new RegExp('^' + pattern);
	}

	isFileExcluded(filePath: string): boolean {
		if (this.settings.excludedFolders.length === 0) {
			return false;
		}
		
		// Normalize path separators to forward slash
		const normalizedPath = filePath.replace(/\\/g, '/');
		
		return this.settings.excludedFolders.some(pattern => {
			if (!pattern.trim()) return false;
			const regex = this.patternToRegex(pattern);
			return regex.test(normalizedPath);
		});
	}

	async getProjectFromFrontmatter(filePath: string): Promise<string | null> {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!file || !(file instanceof TFile)) {
			return null;
		}
		
		try {
			const content = await this.app.vault.read(file);
			const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
			const match = content.match(frontmatterRegex);
			
			if (!match) {
				return null;
			}
			
			const frontmatter = match[1];
			const key = this.settings.projectKey;
			const lines = frontmatter.split('\n');
			
			// Look for the key
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i].trim();
				
				// Check if this line starts with the key
				if (line.startsWith(`${key}:`)) {
					// Get the value on the same line
					let value = line.replace(new RegExp(`^${key}:\\s*`), '').trim();
					
					// If empty, check next line for array item
					if (!value && i + 1 < lines.length) {
						const nextLine = lines[i + 1].trim();
						if (nextLine.startsWith('-')) {
							value = nextLine.replace(/^-\s*/, '').trim();
						}
					}
					
					if (value) {
						// Normalize: remove quotes, brackets, etc.
						value = value.replace(/^["']+|["']+$/g, ''); // Remove all surrounding quotes
						value = value.replace(/\[\[|\]\]/g, ''); // Remove [[ and ]]
						value = value.replace(/^[-*•]\s*/, ''); // Remove bullets
						value = value.trim();
						
						if (value) {
							return value;
						}
					}
					break;
				}
			}
		} catch (error) {
			console.error('Error reading frontmatter for project:', error);
		}
		
		return null;
	}

	async processTimerCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const filePath = ctx.sourcePath;

		// Load existing entries from frontmatter
		await this.loadEntriesFromFrontmatter(filePath);

		// Get or create page data
		if (!this.timeData.has(filePath)) {
			this.timeData.set(filePath, {
				entries: [],
				totalTimeTracked: 0
			});
		}

		const pageData = this.timeData.get(filePath)!;

		// Find active timer (has startTime but no endTime)
		const activeTimer = pageData.entries.find(e => e.startTime !== null && e.endTime === null);

		// Build the container
		const container = el.createDiv({ cls: 'lapse-container' });
		
		// Main layout wrapper with two columns
		const mainLayout = container.createDiv({ cls: 'lapse-main-layout' });
		
		// LEFT COLUMN: Timer container (timer display + adjust buttons in bordered box)
		const timerContainer = mainLayout.createDiv({ cls: 'lapse-timer-container' });
		
		// Timer display
		const timerDisplay = timerContainer.createDiv({ cls: 'lapse-timer-display' });
		timerDisplay.setText('--:--');
		
		// Adjust buttons container
		const adjustButtonsContainer = timerContainer.createDiv({ cls: 'lapse-adjust-buttons' });
		
		// - button (adjust start time backward)
		const adjustBackBtn = adjustButtonsContainer.createEl('button', { 
			cls: 'lapse-btn-adjust',
			text: `-${this.settings.timeAdjustMinutes}`
		});
		adjustBackBtn.disabled = !activeTimer;
		
		// + button (adjust start time forward)
		const adjustForwardBtn = adjustButtonsContainer.createEl('button', { 
			cls: 'lapse-btn-adjust',
			text: `+${this.settings.timeAdjustMinutes}`
		});
		adjustForwardBtn.disabled = !activeTimer;
		
		// RIGHT COLUMN: Label/buttons/counters
		const rightColumn = mainLayout.createDiv({ cls: 'lapse-right-column' });
		
		// TOP LINE: Label/Input, Stop, Expand
		const topLine = rightColumn.createDiv({ cls: 'lapse-top-line' });
		
		// Label display/input - use span when timer is running, input when editable
		let labelDisplay: HTMLElement;
		let labelInput: HTMLInputElement | null = null;
		
		if (activeTimer) {
			// Show as plain text when timer is running
			labelDisplay = topLine.createEl('div', {
				text: activeTimer.label,
				cls: 'lapse-label-display-running'
			});
		} else {
			// Show as input when editable
			labelInput = topLine.createEl('input', {
				type: 'text',
				placeholder: 'Timer label...',
				cls: 'lapse-label-input'
			}) as HTMLInputElement;
			labelDisplay = labelInput;
		}

		// Play/Stop button
		const playStopBtn = topLine.createEl('button', { cls: 'lapse-btn-play-stop' });
		if (activeTimer) {
			setIcon(playStopBtn, 'square');
			playStopBtn.classList.add('lapse-btn-stop');
		} else {
			setIcon(playStopBtn, 'play');
			playStopBtn.classList.add('lapse-btn-play');
		}

		// Chevron button to toggle panel
		const chevronBtn = topLine.createEl('button', { cls: 'lapse-btn-chevron' });
		setIcon(chevronBtn, 'chevron-down');

		// BOTTOM LINE: Entry count | Today total
		const bottomLine = rightColumn.createDiv({ cls: 'lapse-bottom-line' });
		
		// Entry count and total time (middle, flexible)
		const summaryLeft = bottomLine.createDiv({ cls: 'lapse-summary-left' });
		
		// Today total (right-aligned)
		const todayLabel = bottomLine.createDiv({ cls: 'lapse-today-label' });

		// Helper function to calculate total time (including active timer if running)
		const calculateTotalTime = (): number => {
			return pageData.entries.reduce((sum, e) => {
				if (e.endTime !== null) {
					return sum + e.duration;
				} else if (e.startTime !== null) {
					// Active timer - include current elapsed time
					return sum + e.duration + (Date.now() - e.startTime);
				}
				return sum;
			}, 0);
		};

		// Helper function to calculate today's total time
		const calculateTodayTotal = (): number => {
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const todayStart = today.getTime();

			return pageData.entries.reduce((sum, e) => {
				if (e.startTime && e.startTime >= todayStart) {
					if (e.endTime !== null) {
						return sum + e.duration;
					} else if (e.startTime !== null) {
						// Active timer - include current elapsed time
						return sum + e.duration + (Date.now() - e.startTime);
					}
				}
				return sum;
			}, 0);
		};

		// Update timer display and summary
		const updateDisplays = () => {
			// Find current active timer
			const currentActiveTimer = pageData.entries.find(e => e.startTime !== null && e.endTime === null);
			
			// Update button states
			adjustBackBtn.disabled = !currentActiveTimer;
			adjustForwardBtn.disabled = !currentActiveTimer;
			
			// Update timer display
			if (currentActiveTimer && currentActiveTimer.startTime) {
				const elapsed = currentActiveTimer.duration + (Date.now() - currentActiveTimer.startTime);
				timerDisplay.setText(this.formatTimeForTimerDisplay(elapsed));
			} else {
				timerDisplay.setText('--:--');
			}

			// Update summary
			const entryCount = pageData.entries.length;
			const totalTime = calculateTotalTime();
			summaryLeft.setText(`${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}, ${this.formatTimeAsHHMMSS(totalTime)}`);

			const todayTotal = calculateTodayTotal();
			todayLabel.setText(`Today: ${this.formatTimeAsHHMMSS(todayTotal)}`);
		};

		// Initial update
		updateDisplays();

		// Set up interval to update displays if timer is running
		let updateInterval: number | null = null;
		if (activeTimer) {
			updateInterval = window.setInterval(updateDisplays, 1000);
		}

		// Adjust start time backward (<<)
		adjustBackBtn.onclick = async () => {
			const currentActiveTimer = pageData.entries.find(e => e.startTime !== null && e.endTime === null);
			if (currentActiveTimer && currentActiveTimer.startTime) {
				const adjustMinutes = this.settings.timeAdjustMinutes;
				const adjustMs = adjustMinutes * 60 * 1000;
				currentActiveTimer.startTime = currentActiveTimer.startTime - adjustMs;
				// Update frontmatter
				await this.updateFrontmatter(filePath);
				updateDisplays();
			}
		};

		// Adjust start time forward (>>)
		adjustForwardBtn.onclick = async () => {
			const currentActiveTimer = pageData.entries.find(e => e.startTime !== null && e.endTime === null);
			if (currentActiveTimer && currentActiveTimer.startTime) {
				const adjustMinutes = this.settings.timeAdjustMinutes;
				const adjustMs = adjustMinutes * 60 * 1000;
				currentActiveTimer.startTime = currentActiveTimer.startTime + adjustMs;
				// Update frontmatter
				await this.updateFrontmatter(filePath);
				updateDisplays();
			}
		};

		// Collapsible panel for entries cards
		const panel = container.createDiv({ cls: 'lapse-panel' });
		panel.style.display = 'none'; // Start collapsed

		// Cards container
		const cardsContainer = panel.createDiv({ cls: 'lapse-cards-container' });

		// Render all entries as cards
		this.renderEntryCards(cardsContainer, pageData.entries, filePath, labelDisplay, labelInput);

		// Add button to add new entry
		const addButton = panel.createEl('button', { 
			text: '+ Add Entry', 
			cls: 'lapse-btn-add' 
		});

		// Panel toggle
		let isPanelOpen = false;
		chevronBtn.onclick = () => {
			isPanelOpen = !isPanelOpen;
			if (isPanelOpen) {
				panel.style.display = 'block';
				setIcon(chevronBtn, 'chevron-up');
			} else {
				panel.style.display = 'none';
				setIcon(chevronBtn, 'chevron-down');
			}
		};

		// Play/Stop button functionality
		playStopBtn.onclick = async () => {
			// Re-check for active timer in case state changed
			const currentActiveTimer = pageData.entries.find(e => e.startTime !== null && e.endTime === null);
			
			if (currentActiveTimer) {
				// Stop the active timer
				if (!currentActiveTimer.isPaused && currentActiveTimer.startTime) {
					currentActiveTimer.duration += (Date.now() - currentActiveTimer.startTime);
				}
				currentActiveTimer.endTime = Date.now();
				// Keep startTime for the record
				currentActiveTimer.isPaused = false;

				// Stop update interval
				if (updateInterval) {
					clearInterval(updateInterval);
					updateInterval = null;
				}

				// Update frontmatter
				await this.updateFrontmatter(filePath);

				// Refresh the UI - convert label display back to input
				if (labelInput) {
					labelInput.value = '';
			} else if (labelDisplay) {
				// Convert display to input
				labelDisplay.remove();
				// Insert input after timer display
				labelInput = topLine.createEl('input', {
					type: 'text',
					placeholder: 'Timer label...',
					cls: 'lapse-label-input'
				}) as HTMLInputElement;
				// Move input to correct position (after timer, before buttons)
				const playBtn = topLine.querySelector('.lapse-btn-play-stop');
				if (playBtn) {
					topLine.insertBefore(labelInput, playBtn);
				}
				labelDisplay = labelInput;
			}
			setIcon(playStopBtn, 'play');
			playStopBtn.classList.remove('lapse-btn-stop');
			playStopBtn.classList.add('lapse-btn-play');
			updateDisplays(); // Update displays immediately
			this.renderEntryCards(cardsContainer, pageData.entries, filePath, labelDisplay, labelInput);

			// Update sidebar
			this.app.workspace.getLeavesOfType('lapse-sidebar').forEach(leaf => {
				if (leaf.view instanceof LapseSidebarView) {
					leaf.view.refresh();
				}
			});
		} else {
			// Start a new timer
			let label = '';
			if (labelInput) {
				label = labelInput.value.trim();
			}
			if (!label) {
				// Get default label based on settings
				label = await this.getDefaultLabel(filePath);
			}
			const newEntry: TimeEntry = {
				id: `${filePath}-${Date.now()}-${Math.random()}`,
				label: label,
				startTime: Date.now(),
				endTime: null,
				duration: 0,
				isPaused: false,
				tags: this.getDefaultTags()
			};
			pageData.entries.push(newEntry);

			// Start update interval
			if (!updateInterval) {
				updateInterval = window.setInterval(updateDisplays, 1000);
			}

			// Add default tag to note if configured
			await this.addDefaultTagToNote(filePath);

			// Update frontmatter
			await this.updateFrontmatter(filePath);

			// Update UI - convert input to display when timer starts
			// Use the actual label value (from input or default) not just input.value
			if (labelInput) {
				labelInput.remove();
				labelDisplay = topLine.createEl('div', {
					text: label, // Use the resolved label value
					cls: 'lapse-label-display-running'
				});
				// Move display to correct position (after timer, before buttons)
				const playBtn = topLine.querySelector('.lapse-btn-play-stop');
				if (playBtn) {
					topLine.insertBefore(labelDisplay, playBtn);
				}
				labelInput = null;
			} else if (labelDisplay) {
				// Update existing display - just change the text
				labelDisplay.setText(label);
			} else {
				// Create display if it doesn't exist
				labelDisplay = topLine.createEl('div', {
					text: label,
					cls: 'lapse-label-display-running'
				});
				// Move display to correct position
				const playBtn = topLine.querySelector('.lapse-btn-play-stop');
				if (playBtn) {
					topLine.insertBefore(labelDisplay, playBtn);
				}
			}
			setIcon(playStopBtn, 'square');
			playStopBtn.classList.remove('lapse-btn-play');
			playStopBtn.classList.add('lapse-btn-stop');
				updateDisplays(); // Update displays immediately
				this.renderEntryCards(cardsContainer, pageData.entries, filePath, labelDisplay, labelInput);

				// Update sidebar
				this.app.workspace.getLeavesOfType('lapse-sidebar').forEach(leaf => {
					if (leaf.view instanceof LapseSidebarView) {
						leaf.view.refresh();
					}
				});
			}
		};

		addButton.onclick = async () => {
			const newEntry: TimeEntry = {
				id: `${filePath}-${Date.now()}-${Math.random()}`,
				label: 'New Entry',
				startTime: null,
				endTime: null,
				duration: 0,
				isPaused: false,
				tags: this.getDefaultTags()
			};
			pageData.entries.push(newEntry);
			await this.updateFrontmatter(filePath);
			this.renderEntryCards(cardsContainer, pageData.entries, filePath, labelDisplay, labelInput);
		};
	}


	async processReportCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		// Parse the query
		const query = this.parseQuery(source);
		
		console.log('Lapse Report Query:', query);
		
		// Calculate date range
		const { startTime, endTime } = this.getDateRange(query);
		
		console.log('Date Range:', { 
			startTime: new Date(startTime).toISOString(), 
			endTime: new Date(endTime).toISOString() 
		});
		
		// Get all matching entries
		const matchedEntries = await this.getMatchingEntries(query, startTime, endTime);
		
		console.log('Matched Entries:', matchedEntries.length);
		
		// Group the entries
		const groupedData = this.groupEntries(matchedEntries, query.groupBy || 'project');
		
		console.log('Grouped Data:', groupedData.size, 'groups');
		
		// Render based on display type
		const container = el.createDiv({ cls: 'lapse-report-container' });
		
		if (query.display === 'summary') {
			await this.renderReportSummary(container, groupedData, query);
		} else if (query.display === 'chart') {
			// Only show chart and legend, no table or summary
			await this.renderReportChartOnly(container, groupedData, query);
		} else {
			// Default to table
			await this.renderReportTable(container, groupedData, query);
		}
	}

	parseQuery(source: string): LapseQuery {
		const query: LapseQuery = {
			display: 'table',
			groupBy: 'project',
			chart: 'none'
		};
		
		const lines = source.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
		
		for (const line of lines) {
			const [key, ...valueParts] = line.split(':').map(s => s.trim());
			let value = valueParts.join(':').trim();
			
			if (!value) continue;
			
			// Clean up value: remove quotes, wiki-link brackets, etc.
			value = this.cleanQueryValue(value);
			
			switch (key.toLowerCase()) {
				case 'project':
					query.project = value;
					break;
				case 'tag':
					query.tag = value;
					break;
				case 'note':
					query.note = value;
					break;
				case 'from':
					query.from = value;
					break;
				case 'to':
					query.to = value;
					break;
				case 'period':
					const periodValue = value.toLowerCase();
					if (['today', 'thisweek', 'thismonth', 'lastweek', 'lastmonth'].includes(periodValue)) {
						// Normalize case variations
						if (periodValue === 'thisweek') query.period = 'thisWeek';
						else if (periodValue === 'thismonth') query.period = 'thisMonth';
						else if (periodValue === 'lastweek') query.period = 'lastWeek';
						else if (periodValue === 'lastmonth') query.period = 'lastMonth';
						else query.period = periodValue as 'today' | 'thisWeek' | 'thisMonth' | 'lastWeek' | 'lastMonth';
					}
					break;
				case 'group-by':
					if (['project', 'date', 'tag'].includes(value.toLowerCase())) {
						query.groupBy = value.toLowerCase() as 'project' | 'date' | 'tag';
					}
					break;
				case 'display':
					if (['table', 'summary', 'chart'].includes(value.toLowerCase())) {
						query.display = value.toLowerCase() as 'table' | 'summary' | 'chart';
					}
					break;
				case 'chart':
					if (['bar', 'pie', 'none'].includes(value.toLowerCase())) {
						query.chart = value.toLowerCase() as 'bar' | 'pie' | 'none';
					}
					break;
			}
		}
		
		return query;
	}

	cleanQueryValue(value: string): string {
		// Remove wiki-link brackets [[ ]]
		value = value.replace(/\[\[/g, '').replace(/\]\]/g, '');
		// Remove quotes (single or double)
		value = value.replace(/^["']|["']$/g, '');
		// Remove # from tags
		value = value.replace(/^#/, '');
		return value.trim();
	}

	getDateRange(query: LapseQuery): { startTime: number; endTime: number } {
		let startTime: number;
		let endTime: number;
		
		// If period is specified, use it instead of from/to
		if (query.period) {
			const now = new Date();
			let startDate: Date;
			let endDate: Date = new Date(now);
			
			if (query.period === 'today') {
				startDate = new Date(now);
				startDate.setHours(0, 0, 0, 0);
			} else if (query.period === 'thisWeek') {
				startDate = new Date(now);
				const dayOfWeek = startDate.getDay();
				const daysFromFirstDay = (dayOfWeek - this.settings.firstDayOfWeek + 7) % 7;
				startDate.setDate(startDate.getDate() - daysFromFirstDay);
				startDate.setHours(0, 0, 0, 0);
			} else if (query.period === 'thisMonth') {
				startDate = new Date(now.getFullYear(), now.getMonth(), 1);
				startDate.setHours(0, 0, 0, 0);
			} else if (query.period === 'lastWeek') {
				const firstDayOfWeek = this.settings.firstDayOfWeek;
				const today = new Date(now);
				const dayOfWeek = today.getDay();
				const daysFromFirstDay = (dayOfWeek - firstDayOfWeek + 7) % 7;
				// Go to start of this week, then back 7 days
				startDate = new Date(today);
				startDate.setDate(today.getDate() - daysFromFirstDay - 7);
				startDate.setHours(0, 0, 0, 0);
				// End date is 6 days later (end of last week)
				endDate = new Date(startDate);
				endDate.setDate(startDate.getDate() + 6);
				endDate.setHours(23, 59, 59, 999);
			} else { // lastMonth
				const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
				startDate = new Date(lastMonth);
				startDate.setHours(0, 0, 0, 0);
				// Last day of last month
				endDate = new Date(now.getFullYear(), now.getMonth(), 0);
				endDate.setHours(23, 59, 59, 999);
			}
			
			startTime = startDate.getTime();
			endTime = endDate.getTime();
		} else {
			// Use from/to if specified
			if (query.from) {
				const startDate = new Date(query.from);
				startDate.setHours(0, 0, 0, 0);
				startTime = startDate.getTime();
			} else {
				// Default to today
				const today = new Date();
				today.setHours(0, 0, 0, 0);
				startTime = today.getTime();
			}
			
			if (query.to) {
				const endDate = new Date(query.to);
				endDate.setHours(23, 59, 59, 999);
				endTime = endDate.getTime();
			} else {
				// Default to end of today
				const today = new Date();
				today.setHours(23, 59, 59, 999);
				endTime = today.getTime();
			}
		}
		
		return { startTime, endTime };
	}

	async getMatchingEntries(query: LapseQuery, startTime: number, endTime: number): Promise<Array<{
		filePath: string;
		entry: TimeEntry;
		project: string | null;
		noteName: string;
		noteTags: string[];
	}>> {
		const matchedEntries: Array<{
			filePath: string;
			entry: TimeEntry;
			project: string | null;
			noteName: string;
			noteTags: string[];
		}> = [];
		
		const markdownFiles = this.app.vault.getMarkdownFiles();
		
		for (const file of markdownFiles) {
			const filePath = file.path;
			
			// Skip excluded folders
			if (this.isFileExcluded(filePath)) {
				continue;
			}
			
			// Get note name
			let noteName = file.basename;
			if (this.settings.hideTimestampsInViews) {
				noteName = this.removeTimestampFromFileName(noteName);
			}
			
			// Filter by note name if specified
			if (query.note && !noteName.toLowerCase().includes(query.note.toLowerCase())) {
				continue;
			}
			
			// Get entries and project from cache
			const { entries: fileEntries, project } = await this.getCachedOrLoadEntries(filePath);
			
			// Filter by project if specified
			if (query.project) {
				if (!project) {
					continue; // Skip files with no project if project filter is specified
				}
				if (!project.toLowerCase().includes(query.project.toLowerCase())) {
					continue;
				}
			}
			
			// Get note tags from frontmatter
			const noteTags = await this.getNoteTags(filePath);
			
			// Process entries
			for (const entry of fileEntries) {
				// Filter by date range
				if (!entry.startTime || entry.startTime < startTime || entry.startTime > endTime) {
					continue;
				}
				
				// Filter by tag if specified (check both note tags and entry tags)
				if (query.tag) {
					const tagLower = query.tag.toLowerCase();
					const hasNoteTag = noteTags.some(t => t.toLowerCase().includes(tagLower));
					const hasEntryTag = entry.tags && entry.tags.some(t => t.toLowerCase().includes(tagLower));
					
					if (!hasNoteTag && !hasEntryTag) {
						continue;
					}
				}
				
				// Include completed entries and active timers
				if (entry.endTime || (entry.startTime && !entry.endTime)) {
					matchedEntries.push({
						filePath,
						entry,
						project,
						noteName,
						noteTags
					});
				}
			}
		}
		
		return matchedEntries;
	}

	async getNoteTags(filePath: string): Promise<string[]> {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!file || !(file instanceof TFile)) {
			return [];
		}
		
		try {
			const content = await this.app.vault.read(file);
			const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
			const match = content.match(frontmatterRegex);
			
			if (!match) {
				return [];
			}
			
			const frontmatter = match[1];
			const tagsMatch = frontmatter.match(/tags?:\s*\[?([^\]]+)\]?/);
			
			if (tagsMatch) {
				return tagsMatch[1]
					.split(',')
					.map(t => t.trim().replace(/['"#]/g, ''))
					.filter(t => t);
			}
			
			return [];
		} catch (error) {
			return [];
		}
	}

	groupEntries(entries: Array<{
		filePath: string;
		entry: TimeEntry;
		project: string | null;
		noteName: string;
		noteTags: string[];
	}>, groupBy: 'project' | 'date' | 'tag'): Map<string, {
		totalTime: number;
		entryCount: number;
		entries: Array<{
			filePath: string;
			entry: TimeEntry;
			project: string | null;
			noteName: string;
			noteTags: string[];
		}>;
	}> {
		const grouped = new Map<string, {
			totalTime: number;
			entryCount: number;
			entries: Array<{
				filePath: string;
				entry: TimeEntry;
				project: string | null;
				noteName: string;
				noteTags: string[];
			}>;
		}>();
		
		for (const item of entries) {
			let groupKey: string;
			
			if (groupBy === 'project') {
				groupKey = item.project ? item.project.split('/').pop() || 'No Project' : 'No Project';
			} else if (groupBy === 'date') {
				const date = new Date(item.entry.startTime!);
				groupKey = date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
			} else { // tag
				groupKey = item.entry.tags && item.entry.tags.length > 0 ? `#${item.entry.tags[0]}` : 'No Tag';
			}
			
			if (!grouped.has(groupKey)) {
				grouped.set(groupKey, {
					totalTime: 0,
					entryCount: 0,
					entries: []
				});
			}
			
			const group = grouped.get(groupKey)!;
			const entryDuration = item.entry.endTime 
				? item.entry.duration 
				: item.entry.duration + (Date.now() - item.entry.startTime!);
			
			group.totalTime += entryDuration;
			group.entryCount++;
			group.entries.push(item);
		}
		
		return grouped;
	}

	async renderReportSummary(container: HTMLElement, groupedData: Map<string, any>, query: LapseQuery) {
		container.createEl('h4', { text: 'Summary', cls: 'lapse-report-title' });
		
		// Calculate total time
		let totalTime = 0;
		groupedData.forEach(group => {
			totalTime += group.totalTime;
		});
		
		// Display total time
		const summaryDiv = container.createDiv({ cls: 'lapse-report-summary-total' });
		summaryDiv.createEl('span', { text: 'Total Time: ', cls: 'lapse-report-summary-label' });
		summaryDiv.createEl('span', { text: this.formatTimeAsHHMMSS(totalTime), cls: 'lapse-report-summary-value' });
		
		// Show breakdown by group
		const breakdownDiv = container.createDiv({ cls: 'lapse-report-breakdown' });
		
		// Sort groups by time descending
		const sortedGroups = Array.from(groupedData.entries()).sort((a, b) => b[1].totalTime - a[1].totalTime);
		
		for (const [groupName, group] of sortedGroups) {
			const groupDiv = breakdownDiv.createDiv({ cls: 'lapse-report-breakdown-item' });
			groupDiv.createEl('span', { text: groupName, cls: 'lapse-report-breakdown-name' });
			groupDiv.createEl('span', { text: this.formatTimeAsHHMMSS(group.totalTime), cls: 'lapse-report-breakdown-time' });
		}
		
		// Render chart if specified
		if (query.chart && query.chart !== 'none' && sortedGroups.length > 0) {
			const chartContainer = container.createDiv({ cls: 'lapse-report-chart-container' });
			const chartData = sortedGroups.map(([group, data]) => ({
				group,
				totalTime: data.totalTime
			}));
			await this.renderReportChart(chartContainer, chartData, totalTime, query.chart);
		}
	}

	async renderReportTable(container: HTMLElement, groupedData: Map<string, any>, query: LapseQuery) {
		container.createEl('h4', { text: 'Report', cls: 'lapse-report-title' });
		
		// Calculate total time
		let totalTime = 0;
		groupedData.forEach(group => {
			totalTime += group.totalTime;
		});
		
		// Display total time
		const summaryDiv = container.createDiv({ cls: 'lapse-report-summary-total' });
		summaryDiv.createEl('span', { text: 'Total: ', cls: 'lapse-report-summary-label' });
		summaryDiv.createEl('span', { text: this.formatTimeAsHHMMSS(totalTime), cls: 'lapse-report-summary-value' });
		
		// Create table
		const tableContainer = container.createDiv({ cls: 'lapse-report-table-container' });
		const table = tableContainer.createEl('table', { cls: 'lapse-reports-table' });
		
		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		headerRow.createEl('th', { text: this.getGroupByLabel(query.groupBy || 'project') });
		headerRow.createEl('th', { text: 'Entries' });
		headerRow.createEl('th', { text: 'Time' });
		
		const tbody = table.createEl('tbody');
		
		// Sort groups by time descending
		const sortedGroups = Array.from(groupedData.entries()).sort((a, b) => b[1].totalTime - a[1].totalTime);
		
		for (const [groupName, group] of sortedGroups) {
			const row = tbody.createEl('tr');
			row.createEl('td', { text: groupName });
			row.createEl('td', { text: group.entryCount.toString() });
			row.createEl('td', { text: this.formatTimeAsHHMMSS(group.totalTime) });
		}
		
		// Render chart if specified
		if (query.chart && query.chart !== 'none' && sortedGroups.length > 0) {
			const chartContainer = container.createDiv({ cls: 'lapse-report-chart-container' });
			const chartData = sortedGroups.map(([group, data]) => ({
				group,
				totalTime: data.totalTime
			}));
			await this.renderReportChart(chartContainer, chartData, totalTime, query.chart);
		}
	}

	getGroupByLabel(groupBy: string): string {
		switch (groupBy) {
			case 'project': return 'Project';
			case 'date': return 'Date';
			case 'tag': return 'Tag';
			default: return 'Group';
		}
	}

	async renderReportChartOnly(container: HTMLElement, groupedData: Map<string, any>, query: LapseQuery) {
		// Calculate total time
		let totalTime = 0;
		groupedData.forEach(group => {
			totalTime += group.totalTime;
		});
		
		// Sort groups by time descending
		const sortedGroups = Array.from(groupedData.entries()).sort((a, b) => b[1].totalTime - a[1].totalTime);
		
		// Only render chart if chart type is specified and not 'none'
		if (query.chart && query.chart !== 'none' && sortedGroups.length > 0) {
			const chartContainer = container.createDiv({ cls: 'lapse-report-chart-container' });
			const chartData = sortedGroups.map(([group, data]) => ({
				group,
				totalTime: data.totalTime
			}));
			await this.renderReportChart(chartContainer, chartData, totalTime, query.chart);
		} else {
			// If no chart specified or 'none', show a message
			container.createEl('p', { 
				text: 'Please specify a chart type (chart: pie or chart: bar)', 
				cls: 'lapse-report-error' 
			});
		}
	}

	async renderReportChart(container: HTMLElement, data: Array<{ group: string; totalTime: number }>, totalTime: number, chartType: 'bar' | 'pie') {
		if (chartType === 'pie') {
			await this.renderPieChart(container, data, totalTime);
		} else {
			await this.renderBarChart(container, data, totalTime);
		}
	}

	async renderPieChart(container: HTMLElement, data: Array<{ group: string; totalTime: number }>, totalTime: number) {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'lapse-report-pie-chart');
		svg.setAttribute('width', '300');
		svg.setAttribute('height', '300');
		svg.setAttribute('viewBox', '0 0 300 300');
		container.appendChild(svg);

		const colors = [
			'#4A90E2', '#50C878', '#FF6B6B', '#FFD93D', 
			'#9B59B6', '#E67E22', '#1ABC9C', '#E74C3C'
		];

		const centerX = 150;
		const centerY = 150;
		const radius = 100;
		let currentAngle = -Math.PI / 2; // Start at top

		data.forEach(({ group, totalTime: time }, index) => {
			const percentage = time / totalTime;
			const angle = percentage * 2 * Math.PI;

			const startAngle = currentAngle;
			const endAngle = currentAngle + angle;

			const x1 = centerX + radius * Math.cos(startAngle);
			const y1 = centerY + radius * Math.sin(startAngle);
			const x2 = centerX + radius * Math.cos(endAngle);
			const y2 = centerY + radius * Math.sin(endAngle);

			const largeArc = angle > Math.PI ? 1 : 0;

			const pathData = [
				`M ${centerX} ${centerY}`,
				`L ${x1} ${y1}`,
				`A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`,
				'Z'
			].join(' ');

			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', pathData);
			path.setAttribute('fill', colors[index % colors.length]);
			path.setAttribute('stroke', 'var(--background-primary)');
			path.setAttribute('stroke-width', '2');
			svg.appendChild(path);

			currentAngle += angle;
		});

		// Add legend
		const legend = container.createDiv({ cls: 'lapse-report-legend' });
		data.forEach(({ group, totalTime: time }, index) => {
			const legendItem = legend.createDiv({ cls: 'lapse-report-legend-item' });
			const colorBox = legendItem.createDiv({ cls: 'lapse-report-legend-color' });
			colorBox.style.backgroundColor = colors[index % colors.length];
			const label = legendItem.createDiv({ cls: 'lapse-report-legend-label' });
			label.createSpan({ text: group });
			label.createSpan({ text: this.formatTimeAsHHMMSS(time), cls: 'lapse-report-legend-time' });
		});
	}

	async renderBarChart(container: HTMLElement, data: Array<{ group: string; totalTime: number }>, totalTime: number) {
		const viewBoxWidth = 800;
		const chartHeight = 250;
		const labelHeight = 80;
		const totalHeight = chartHeight + labelHeight;
		const padding = 40;
		const chartAreaWidth = viewBoxWidth - (padding * 2);
		
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'lapse-report-bar-chart');
		svg.setAttribute('width', '100%');
		svg.setAttribute('height', '300');
		svg.setAttribute('viewBox', `0 0 ${viewBoxWidth} ${totalHeight}`);
		svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
		container.appendChild(svg);

		const colors = [
			'#4A90E2', '#50C878', '#FF6B6B', '#FFD93D', 
			'#9B59B6', '#E67E22', '#1ABC9C', '#E74C3C'
		];

		const maxTime = Math.max(...data.map(d => d.totalTime));
		const barCount = data.length;
		const barWidth = chartAreaWidth / barCount;
		const maxBarHeight = chartHeight - padding * 2;

		data.forEach((item, index) => {
			const barHeight = maxTime > 0 ? (item.totalTime / maxTime) * maxBarHeight : 0;
			const x = padding + index * barWidth;
			const y = chartHeight - padding - barHeight;

			const barGap = barWidth * 0.1;
			const actualBarWidth = barWidth - barGap;
			
			const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
			rect.setAttribute('x', (x + barGap / 2).toString());
			rect.setAttribute('y', y.toString());
			rect.setAttribute('width', actualBarWidth.toString());
			rect.setAttribute('height', barHeight.toString());
			rect.setAttribute('fill', colors[index % colors.length]);
			rect.setAttribute('rx', '4');
			svg.appendChild(rect);

			// Label
			const labelY = chartHeight + 10;
			const foreignObject = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
			foreignObject.setAttribute('x', (x + barGap / 2).toString());
			foreignObject.setAttribute('y', labelY.toString());
			foreignObject.setAttribute('width', actualBarWidth.toString());
			foreignObject.setAttribute('height', labelHeight.toString());
			
			const labelDiv = document.createElement('div');
			labelDiv.setAttribute('class', 'lapse-chart-label');
			labelDiv.style.width = '100%';
			labelDiv.style.height = '100%';
			labelDiv.style.display = 'flex';
			labelDiv.style.alignItems = 'flex-start';
			labelDiv.style.justifyContent = 'center';
			labelDiv.style.fontSize = barCount > 15 ? '9px' : barCount > 10 ? '10px' : '11px';
			labelDiv.style.color = 'var(--text-muted)';
			labelDiv.style.textAlign = 'center';
			labelDiv.style.wordWrap = 'break-word';
			labelDiv.style.overflowWrap = 'break-word';
			labelDiv.style.lineHeight = '1.2';
			labelDiv.style.padding = '0 2px';
			
			if (barCount > 10) {
				labelDiv.style.writingMode = 'vertical-rl';
				labelDiv.style.textOrientation = 'mixed';
				labelDiv.style.transform = 'rotate(180deg)';
				labelDiv.style.alignItems = 'center';
			}
			
			labelDiv.textContent = item.group;
			foreignObject.appendChild(labelDiv);
			svg.appendChild(foreignObject);
		});
	}

	renderEntryCards(cardsContainer: HTMLElement, entries: TimeEntry[], filePath: string, labelDisplay?: HTMLElement, labelInput?: HTMLInputElement | null) {
		cardsContainer.empty();

		entries.forEach((entry) => {
			const card = cardsContainer.createDiv({ cls: 'lapse-entry-card' });
			
			// Top line: label and action buttons
			const topLine = card.createDiv({ cls: 'lapse-card-top-line' });
			const labelDiv = topLine.createDiv({ cls: 'lapse-card-label' });
			labelDiv.setText(entry.label);
			
			// Action buttons
			const actionsDiv = topLine.createDiv({ cls: 'lapse-card-actions' });
			const editBtn = actionsDiv.createEl('button', { cls: 'lapse-card-btn-edit' });
			const deleteBtn = actionsDiv.createEl('button', { cls: 'lapse-card-btn-delete' });
			
			setIcon(editBtn, 'pencil');
			setIcon(deleteBtn, 'trash');

			// Second line: start, end, duration
			const detailsLine = card.createDiv({ cls: 'lapse-card-details' });
			
			const startText = entry.startTime 
				? new Date(entry.startTime).toLocaleString('en-US', { 
					month: 'short', day: 'numeric', year: 'numeric',
					hour: 'numeric', minute: '2-digit'
				})
				: '--';
			const endText = entry.endTime 
				? new Date(entry.endTime).toLocaleString('en-US', { 
					month: 'short', day: 'numeric', year: 'numeric',
					hour: 'numeric', minute: '2-digit'
				})
				: '--';
			detailsLine.createSpan({ text: `Start: ${startText}`, cls: 'lapse-card-detail' });
			detailsLine.createSpan({ text: `End: ${endText}`, cls: 'lapse-card-detail' });

			// Third line: duration and tags on same line
			const bottomLine = card.createDiv({ cls: 'lapse-card-bottom-line' });
			const durationText = this.formatTimeAsHHMMSS(entry.duration);
			bottomLine.createSpan({ text: `Duration: ${durationText}`, cls: 'lapse-card-detail' });

			// Tags on the same line
			if (entry.tags && entry.tags.length > 0) {
				const tagsContainer = bottomLine.createDiv({ cls: 'lapse-card-tags-inline' });
				entry.tags.forEach(tag => {
					const tagEl = tagsContainer.createSpan({ text: `#${tag}`, cls: 'lapse-card-tag' });
				});
			}

			// Edit button handler - opens modal
			editBtn.onclick = async () => {
				await this.showEditModal(entry, filePath, labelDisplay, labelInput, () => {
					// Refresh cards after edit
					const pageData = this.timeData.get(filePath);
					if (pageData) {
						this.renderEntryCards(cardsContainer, pageData.entries, filePath, labelDisplay, labelInput);
					}
				});
			};

			// Delete button handler - shows confirmation
			deleteBtn.onclick = async () => {
				const confirmed = await this.showDeleteConfirmation(entry.label);
				if (confirmed) {
					const pageData = this.timeData.get(filePath);
					if (pageData) {
						pageData.entries = pageData.entries.filter(e => e.id !== entry.id);
						await this.updateFrontmatter(filePath);
						this.renderEntryCards(cardsContainer, pageData.entries, filePath, labelDisplay, labelInput);
					}
				}
			};
		});
	}

	async showEditModal(entry: TimeEntry, filePath: string, labelDisplay?: HTMLElement, labelInputParam?: HTMLInputElement | null, onSave?: () => void) {
		const modal = new Modal(this.app);
		modal.titleEl.setText('Edit Entry');
		
		const content = modal.contentEl;
		content.empty();

		// Label input
		const labelContainer = content.createDiv({ cls: 'lapse-modal-field' });
		labelContainer.createEl('label', { text: 'Label', attr: { for: 'lapse-edit-label' } });
		const labelInput = labelContainer.createEl('input', {
				type: 'text',
				value: entry.label,
			cls: 'lapse-modal-input',
			attr: { id: 'lapse-edit-label' }
		}) as HTMLInputElement;

		// Start input
		const startContainer = content.createDiv({ cls: 'lapse-modal-field' });
		startContainer.createEl('label', { text: 'Start Time', attr: { for: 'lapse-edit-start' } });
		const startInput = startContainer.createEl('input', {
				type: 'datetime-local',
			cls: 'lapse-modal-input',
			attr: { id: 'lapse-edit-start' }
		}) as HTMLInputElement;
			if (entry.startTime) {
			startInput.value = this.formatDateTimeLocal(new Date(entry.startTime));
		}

		// End input
		const endContainer = content.createDiv({ cls: 'lapse-modal-field' });
		endContainer.createEl('label', { text: 'End Time', attr: { for: 'lapse-edit-end' } });
		const endInput = endContainer.createEl('input', {
				type: 'datetime-local',
			cls: 'lapse-modal-input',
			attr: { id: 'lapse-edit-end' }
		}) as HTMLInputElement;
			if (entry.endTime) {
			endInput.value = this.formatDateTimeLocal(new Date(entry.endTime));
		}

		// Duration display (read-only)
		const durationContainer = content.createDiv({ cls: 'lapse-modal-field' });
		durationContainer.createEl('label', { text: 'Duration', attr: { for: 'lapse-edit-duration' } });
		const durationInput = durationContainer.createEl('input', {
				type: 'text',
				value: this.formatTimeAsHHMMSS(entry.duration),
			cls: 'lapse-modal-input',
			attr: { id: 'lapse-edit-duration', readonly: 'true' }
		}) as HTMLInputElement;
			durationInput.readOnly = true;

		// Tags input
		const tagsContainer = content.createDiv({ cls: 'lapse-modal-field' });
		tagsContainer.createEl('label', { text: 'Tags (comma-separated, without #)', attr: { for: 'lapse-edit-tags' } });
		const tagsInput = tagsContainer.createEl('input', {
			type: 'text',
			value: (entry.tags || []).join(', '),
			cls: 'lapse-modal-input',
			attr: { id: 'lapse-edit-tags', placeholder: 'tag1, tag2, tag3' }
		}) as HTMLInputElement;

		// Buttons
		const buttonContainer = content.createDiv({ cls: 'lapse-modal-buttons' });
		const saveBtn = buttonContainer.createEl('button', { text: 'Save', cls: 'mod-cta' });
		const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });

		// Update duration when start/end change
		const updateDuration = () => {
			const start = startInput.value ? new Date(startInput.value).getTime() : null;
			const end = endInput.value ? new Date(endInput.value).getTime() : null;
			if (start && end) {
				const duration = end - start;
				durationInput.value = this.formatTimeAsHHMMSS(duration);
			} else if (entry.startTime && !entry.endTime) {
				// Active timer - keep existing duration
				durationInput.value = this.formatTimeAsHHMMSS(entry.duration);
				} else {
				durationInput.value = this.formatTimeAsHHMMSS(entry.duration);
			}
		};

		startInput.addEventListener('change', updateDuration);
		endInput.addEventListener('change', updateDuration);

		// Save handler
		saveBtn.onclick = async () => {
			entry.label = labelInput.value;
					
					if (startInput.value) {
						entry.startTime = new Date(startInput.value).getTime();
					} else {
						entry.startTime = null;
					}
					
					if (endInput.value) {
						entry.endTime = new Date(endInput.value).getTime();
					} else {
						entry.endTime = null;
					}

			// Parse tags (remove # if present, split by comma)
			const tagsStr = tagsInput.value.trim();
			if (tagsStr) {
				entry.tags = tagsStr.split(',').map(t => {
					t = t.trim();
					// Remove # if present
					return t.startsWith('#') ? t.substring(1) : t;
				}).filter(t => t);
			} else {
				entry.tags = [];
					}

					// Calculate duration from start and end times
					if (entry.startTime && entry.endTime) {
						entry.duration = entry.endTime - entry.startTime;
					} else if (entry.startTime && !entry.endTime) {
						// Active timer - preserve existing duration
						// Don't recalculate
					}

					// Update action bar label if this is the active timer
					const isActiveTimer = entry.startTime !== null && entry.endTime === null;
					if (isActiveTimer && labelDisplay) {
				if (labelInputParam) {
					labelInputParam.value = entry.label;
						} else {
							labelDisplay.setText(entry.label);
						}
					}

					// Update frontmatter
					await this.updateFrontmatter(filePath);
					
			modal.close();
			if (onSave) {
				onSave();
			}
		};

		cancelBtn.onclick = () => {
			modal.close();
		};

		modal.open();
	}

	async showDeleteConfirmation(entryLabel: string): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.titleEl.setText('Delete Entry');
			
			const content = modal.contentEl;
			content.empty();
			content.createEl('p', { text: `Are you sure you want to delete "${entryLabel}"?` });
			
			const buttonContainer = content.createDiv({ cls: 'lapse-modal-buttons' });
			const deleteBtn = buttonContainer.createEl('button', { text: 'Delete', cls: 'mod-warning' });
			const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });

			deleteBtn.onclick = () => {
				modal.close();
				resolve(true);
			};

			cancelBtn.onclick = () => {
				modal.close();
				resolve(false);
			};

			modal.open();
		});
	}

	formatDateTimeLocal(date: Date): string {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		const hours = String(date.getHours()).padStart(2, '0');
		const minutes = String(date.getMinutes()).padStart(2, '0');
		return `${year}-${month}-${day}T${hours}:${minutes}`;
	}

	formatTimeAsHHMMSS(milliseconds: number): string {
		const totalSeconds = Math.floor(milliseconds / 1000);
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;
		return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
	}

	formatTimeForTimerDisplay(milliseconds: number): string {
		const totalSeconds = Math.floor(milliseconds / 1000);
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;
		
		if (hours > 0) {
			// Show hours without leading zero: 1:00:00, 12:34:56
			return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
		} else {
			// No hours, just MM:SS
			return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
		}
	}

	async updateFrontmatter(filePath: string) {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!file || !(file instanceof TFile)) return;

		const pageData = this.timeData.get(filePath);
		if (!pageData) return;

		const content = await this.app.vault.read(file);
		
		// Calculate startTime (earliest start from all entries that have started)
		const startedEntries = pageData.entries.filter(e => e.startTime !== null);
		const startTime = startedEntries.length > 0 
			? Math.min(...startedEntries.map(e => e.startTime!))
			: null;

		// Calculate endTime (latest end from all completed entries)
		const completedEntries = pageData.entries.filter(e => e.endTime !== null);
		const endTime = completedEntries.length > 0
			? Math.max(...completedEntries.map(e => e.endTime!))
			: null;

		// Build entries array (all entries - save everything)
		const entries = pageData.entries.map(entry => ({
			label: entry.label,
			start: entry.startTime ? new Date(entry.startTime).toISOString() : null,
			end: entry.endTime ? new Date(entry.endTime).toISOString() : null,
			duration: Math.floor(entry.duration / 1000),
			tags: entry.tags || []
		}));

		// Calculate totalTimeTracked (sum of all completed entry durations)
		const totalTimeTracked = pageData.entries
			.filter(e => e.endTime !== null)
			.reduce((sum, e) => sum + e.duration, 0);

		// Format totalTimeTracked as hh:mm:ss
		const totalTimeFormatted = this.formatTimeAsHHMMSS(totalTimeTracked);

		// Get configured keys
		const startTimeKey = this.settings.startTimeKey;
		const endTimeKey = this.settings.endTimeKey;
		const entriesKey = this.settings.entriesKey;
		const totalTimeKey = this.settings.totalTimeKey;

		// Build the Lapse frontmatter section as a string
		let lapseFrontmatter = '';
		
		if (startTime !== null) {
			lapseFrontmatter += `${startTimeKey}: ${new Date(startTime).toISOString()}\n`;
		}
		if (endTime !== null) {
			lapseFrontmatter += `${endTimeKey}: ${new Date(endTime).toISOString()}\n`;
		}
		
		// Add entries as YAML array
		if (entries.length > 0) {
			lapseFrontmatter += `${entriesKey}:\n`;
			entries.forEach(entry => {
				const escapedLabel = entry.label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
				lapseFrontmatter += `  - label: "${escapedLabel}"\n`;
				if (entry.start) {
					lapseFrontmatter += `    start: ${entry.start}\n`;
				}
				if (entry.end) {
					lapseFrontmatter += `    end: ${entry.end}\n`;
				}
				lapseFrontmatter += `    duration: ${entry.duration}\n`;
				if (entry.tags && entry.tags.length > 0) {
					lapseFrontmatter += `    tags: [${entry.tags.map((t: string) => `"${t}"`).join(', ')}]\n`;
				}
			});
		} else {
			lapseFrontmatter += `${entriesKey}: []\n`;
		}
		
		lapseFrontmatter += `${totalTimeKey}: "${totalTimeFormatted}"\n`;

		// Check if frontmatter exists
		const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
		
		if (frontmatterMatch) {
			const existingFM = frontmatterMatch[1];
			const lines = existingFM.split('\n');
			
			// Remove old Lapse entries by filtering out matching lines and their sub-items
			let inLapseArray = false;
			const filteredLines = lines.filter(line => {
				const trimmed = line.trim();
				
				// Check if entering lapse entries array
				if (trimmed.startsWith(`${entriesKey}:`)) {
					inLapseArray = true;
					return false;
				}
				
				// Skip lines inside lapse entries array
				if (inLapseArray) {
					if (line.match(/^\s+(-|\w+:)/)) {
						return false; // Still inside array
					}
					inLapseArray = false; // Exited array
				}
				
				// Skip other Lapse fields
				if (trimmed.startsWith(`${startTimeKey}:`) ||
				    trimmed.startsWith(`${endTimeKey}:`) ||
				    trimmed.startsWith(`${totalTimeKey}:`)) {
					return false;
				}
				
				return true;
			});
			
			// Rebuild frontmatter with existing fields + new Lapse fields
			const newFM = filteredLines.join('\n') + '\n' + lapseFrontmatter;
			const newContent = content.replace(/^---\n[\s\S]*?\n---/, `---\n${newFM}---`);
			
			await this.app.vault.modify(file, newContent);
		} else {
			// No frontmatter exists, create new
			const newContent = `---\n${lapseFrontmatter}---\n\n${content}`;
			await this.app.vault.modify(file, newContent);
		}
		
		// Invalidate cache for this file since we just modified it
		this.invalidateCacheForFile(filePath);
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType('lapse-sidebar');

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: 'lapse-sidebar', active: true });
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async activateReportsView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType('lapse-reports');

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: 'lapse-reports', active: true });
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async getActiveTimers(): Promise<Array<{ filePath: string; entry: TimeEntry }>> {
		const activeTimers: Array<{ filePath: string; entry: TimeEntry }> = [];

		// Check entries already loaded in memory
		this.timeData.forEach((pageData, filePath) => {
			pageData.entries.forEach(entry => {
				if (entry.startTime && !entry.endTime) {
					activeTimers.push({ filePath, entry });
				}
			});
		});

		// Also check frontmatter for any files with active timers that aren't in memory
		// Get all markdown files
		const markdownFiles = this.app.vault.getMarkdownFiles();
		
		for (const file of markdownFiles) {
			const filePath = file.path;
			
			// Skip excluded folders
			if (this.isFileExcluded(filePath)) {
				continue;
			}
			
			// Skip if already checked in memory
			if (this.timeData.has(filePath)) {
				continue;
			}
			
			// Load entries from frontmatter
			await this.loadEntriesFromFrontmatter(filePath);
			
			// Check for active timers
			const pageData = this.timeData.get(filePath);
			if (pageData) {
				pageData.entries.forEach(entry => {
					if (entry.startTime && !entry.endTime) {
						activeTimers.push({ filePath, entry });
					}
				});
			}
		}

		return activeTimers;
	}

	async onunload() {
		// Clean up status bar interval
		if (this.statusBarUpdateInterval) {
			window.clearInterval(this.statusBarUpdateInterval);
			this.statusBarUpdateInterval = null;
		}
		
		// Wait for any pending cache saves to complete
		if (this.pendingSaves.length > 0) {
			console.log(`Lapse: Waiting for ${this.pendingSaves.length} pending save(s) to complete...`);
			await Promise.all(this.pendingSaves);
		}
		
		// If there's a debounced save pending, trigger it immediately
		if (this.cacheSaveTimeout) {
			clearTimeout(this.cacheSaveTimeout);
			await this.saveData({
				...this.settings,
				entryCache: this.entryCache
			});
			this.cacheSaveTimeout = null;
		}
		
		console.log('Unloading Lapse plugin');
	}

	async loadSettings() {
		const startTime = Date.now();
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		
		// Load entry cache if it exists
		if (data && data.entryCache) {
			const cacheSize = Object.keys(data.entryCache).length;
			
			// For very large caches (>5000 files), warn and consider pruning
			if (cacheSize > 5000) {
				console.warn(`Lapse: Large cache detected (${cacheSize} files). Consider clearing cache if experiencing slowdowns.`);
				
				// Prune cache to only keep entries from last 90 days
				const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
				const prunedCache: EntryCache = {};
				let prunedCount = 0;
				
				for (const [filePath, cached] of Object.entries(data.entryCache as EntryCache)) {
					// Keep if any entries are recent
					const hasRecentEntries = cached.entries.some((e: TimeEntry) => 
						(e.startTime && e.startTime > ninetyDaysAgo) || 
						(e.endTime && e.endTime > ninetyDaysAgo)
					);
					
					if (hasRecentEntries || cached.lastModified > ninetyDaysAgo) {
						prunedCache[filePath] = cached;
					} else {
						prunedCount++;
					}
				}
				
				console.log(`Lapse: Pruned ${prunedCount} old cache entries, keeping ${Object.keys(prunedCache).length} recent files`);
				data.entryCache = prunedCache;
			}
			
			const finalCacheSize = Object.keys(data.entryCache).length;
			console.log(`Lapse: Loading cache with ${finalCacheSize} files...`);
			
			// For large caches, load in background to avoid blocking plugin init
			if (finalCacheSize > 100) {
				this.cacheLoading = true;
				// Load cache asynchronously without blocking
				this.cacheLoaded = new Promise<void>((resolve) => {
					setTimeout(async () => {
						this.entryCache = data.entryCache;
						this.cacheLoading = false;
						const loadTime = Date.now() - startTime;
						console.log(`Lapse: Cache loaded (${finalCacheSize} files) in ${loadTime}ms`);
						
						// Save pruned cache if we pruned anything
						if (finalCacheSize < cacheSize) {
							await this.saveCache();
						}
						
						resolve();
					}, 0);
				});
			} else {
				this.entryCache = data.entryCache;
				const loadTime = Date.now() - startTime;
				console.log(`Lapse: Cache loaded (${finalCacheSize} files) in ${loadTime}ms`);
			}
		}
	}

	async saveSettings() {
		await this.saveData({
			...this.settings,
			entryCache: this.entryCache
		});
	}

	async saveCache() {
		// Debounce cache saves to avoid excessive writes
		if (this.cacheSaveTimeout) {
			clearTimeout(this.cacheSaveTimeout);
		}

		// Create a promise that resolves when the save completes
		const savePromise = new Promise<void>((resolve) => {
			this.cacheSaveTimeout = window.setTimeout(async () => {
				try {
					// Save just the cache without triggering full settings save
					await this.saveData({
						...this.settings,
						entryCache: this.entryCache
					});
				} finally {
					this.cacheSaveTimeout = null;
					// Remove from pending saves
					const index = this.pendingSaves.indexOf(savePromise);
					if (index > -1) {
						this.pendingSaves.splice(index, 1);
					}
					resolve();
				}
			}, 2000); // Wait 2 seconds before saving
		});

		// Track this save operation
		this.pendingSaves.push(savePromise);
		return savePromise;
	}

	invalidateCacheForFile(filePath: string) {
		// Remove file from cache - will be re-indexed on next access
		delete this.entryCache[filePath];
	}

	async getCachedOrLoadEntries(filePath: string): Promise<{ entries: TimeEntry[]; project: string | null; totalTime: number }> {
		// Wait for cache to finish loading if it's still in progress
		if (this.cacheLoading && this.cacheLoaded) {
			await this.cacheLoaded;
		}
		
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!file || !(file instanceof TFile)) {
			return { entries: [], project: null, totalTime: 0 };
		}

		const currentMtime = file.stat.mtime;
		const cached = this.entryCache[filePath];

		// Check if cache is valid (file hasn't been modified)
		if (cached && cached.lastModified === currentMtime) {
			// Cache hit - return cached data
			return {
				entries: cached.entries,
				project: cached.project,
				totalTime: cached.totalTime
			};
		}

		// Cache miss or stale - load from frontmatter
		await this.loadEntriesFromFrontmatter(filePath);
		const pageData = this.timeData.get(filePath);
		const project = await this.getProjectFromFrontmatter(filePath);
		
		const entries = pageData ? pageData.entries : [];
		const totalTime = pageData ? pageData.totalTimeTracked : 0;

		// Update cache
		this.entryCache[filePath] = {
			lastModified: currentMtime,
			entries: entries,
			project: project,
			totalTime: totalTime
		};

		// Save cache to disk (debounced in real usage, but immediate for now)
		await this.saveCache();

		return { entries, project, totalTime };
	}
}

class LapseSidebarView extends ItemView {
	plugin: LapsePlugin;
	refreshInterval: number | null = null;
	timeDisplays: Map<string, HTMLElement> = new Map(); // Map of entry ID to time display element
	showTodayEntries: boolean = true; // Toggle for showing/hiding individual entries
	refreshCounter: number = 0; // Counter for periodic full refreshes

	constructor(leaf: WorkspaceLeaf, plugin: LapsePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

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
		container.empty();
		this.timeDisplays.clear();
		
		// Header with title and refresh button
		const header = container.createDiv({ cls: 'lapse-sidebar-header' });
		header.createEl('h4', { text: 'Activity' });
		
		const refreshBtn = header.createEl('button', { 
			cls: 'lapse-sidebar-refresh-btn clickable-icon',
			attr: { 'aria-label': 'Refresh' }
		});
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.onclick = async () => {
			// Force reload of all entries in view
			this.plugin.timeData.clear();
			await this.render();
		};

		// Get active timers from memory only (not all files) for faster rendering
		const activeTimers: Array<{ filePath: string; entry: TimeEntry }> = [];
		this.plugin.timeData.forEach((pageData, filePath) => {
			pageData.entries.forEach(entry => {
				if (entry.startTime && !entry.endTime) {
					activeTimers.push({ filePath, entry });
				}
			});
		});

		if (activeTimers.length === 0) {
			container.createEl('p', { text: 'No active timers', cls: 'lapse-sidebar-empty' });
		} else {
			// Active timers section with card layout
			for (const { filePath, entry } of activeTimers) {
				const card = container.createDiv({ cls: 'lapse-activity-card' });
				
				// Timer display - big and centered
				const elapsed = entry.duration + (entry.isPaused ? 0 : (Date.now() - entry.startTime!));
				const timeText = this.plugin.formatTimeAsHHMMSS(elapsed);
				const timerDisplay = card.createDiv({ 
					text: timeText, 
					cls: 'lapse-activity-timer' 
				});
				this.timeDisplays.set(entry.id, timerDisplay);
				
				// Get file name without extension
				const file = this.app.vault.getAbstractFileByPath(filePath);
				let fileName = file && file instanceof TFile ? file.basename : filePath.split('/').pop()?.replace('.md', '') || filePath;
				
				// Remove timestamps from filename if setting enabled
				if (this.plugin.settings.hideTimestampsInViews) {
					fileName = this.plugin.removeTimestampFromFileName(fileName);
				}
				
				// Details container - smaller text below timer
				const detailsContainer = card.createDiv({ cls: 'lapse-activity-details' });
				
				// Create link to the note
				const link = detailsContainer.createEl('a', { 
					text: fileName,
					cls: 'lapse-activity-page internal-link',
					href: filePath
				});
				
				// Add click handler to open the note
				link.onclick = (e) => {
					e.preventDefault();
					const file = this.app.vault.getAbstractFileByPath(filePath);
					if (file && file instanceof TFile) {
						this.app.workspace.openLinkText(filePath, '', false);
					}
				};
				
				// Get project from frontmatter
				const project = await this.plugin.getProjectFromFrontmatter(filePath);
				
				// Project (if available)
				if (project) {
					detailsContainer.createDiv({ text: project, cls: 'lapse-activity-project' });
				}
				
				// Entry label
				detailsContainer.createDiv({ text: entry.label, cls: 'lapse-activity-label' });
			}
		}

		// Get today's entries and group by note
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const todayStart = today.getTime();
		
		const todayEntries: Array<{ filePath: string; entry: TimeEntry; startTime: number }> = [];
		
		// First, get entries from memory
		this.plugin.timeData.forEach((pageData, filePath) => {
			pageData.entries.forEach(entry => {
				if (entry.startTime && entry.startTime >= todayStart && entry.endTime) {
					todayEntries.push({ filePath, entry, startTime: entry.startTime });
				}
			});
		});
		
		// Also check all files using cache for fast access
		const markdownFiles = this.app.vault.getMarkdownFiles();
		
		for (const file of markdownFiles) {
			const filePath = file.path;
			
			// Skip excluded folders
			if (this.plugin.isFileExcluded(filePath)) {
				continue;
			}
			
			// Skip if already checked in memory
			if (this.plugin.timeData.has(filePath)) {
				continue;
			}
			
			// Use cached data or load if needed
			const { entries: fileEntries } = await this.plugin.getCachedOrLoadEntries(filePath);
			
			for (const entry of fileEntries) {
				if (entry.startTime && entry.startTime >= todayStart && entry.endTime) {
					todayEntries.push({ filePath, entry, startTime: entry.startTime });
				}
			}
		}
		
		// Group entries by filePath
		const entriesByNote = new Map<string, Array<{ entry: TimeEntry; startTime: number }>>();
		todayEntries.forEach(({ filePath, entry, startTime }) => {
			if (!entriesByNote.has(filePath)) {
				entriesByNote.set(filePath, []);
			}
			entriesByNote.get(filePath)!.push({ entry, startTime });
		});
		
		// Sort entries within each note (newest to oldest)
		entriesByNote.forEach((entries) => {
			entries.sort((a, b) => b.startTime - a.startTime);
		});
		
		// Convert to array and sort by newest entry per note
		const noteGroups = Array.from(entriesByNote.entries()).map(([filePath, entries]) => {
			const totalTime = entries.reduce((sum, { entry }) => sum + entry.duration, 0);
			const newestStartTime = Math.max(...entries.map(e => e.startTime));
			return { filePath, entries, totalTime, newestStartTime };
		});
		
		// Sort notes by newest entry (newest to oldest)
		noteGroups.sort((a, b) => b.newestStartTime - a.newestStartTime);
		
		// Display today's entries grouped by note
		if (noteGroups.length > 0) {
			// Section header with toggle button
			const sectionHeader = container.createDiv({ cls: 'lapse-sidebar-section-header' });
			sectionHeader.createEl('h4', { text: "Today's Entries", cls: 'lapse-sidebar-section-title' });
			
			const toggleBtn = sectionHeader.createEl('button', {
				cls: 'lapse-sidebar-toggle-btn clickable-icon',
				attr: { 'aria-label': this.showTodayEntries ? 'Hide entries' : 'Show entries' }
			});
			setIcon(toggleBtn, this.showTodayEntries ? 'chevron-down' : 'chevron-right');
			toggleBtn.onclick = () => {
				this.showTodayEntries = !this.showTodayEntries;
				this.render();
			};
			
			const todayList = container.createEl('ul', { cls: 'lapse-sidebar-list' });
			
			for (const { filePath, entries, totalTime } of noteGroups) {
				const item = todayList.createEl('li', { cls: 'lapse-sidebar-note-group' });
				
				// Top line container - note name and total time
				const topLine = item.createDiv({ cls: 'lapse-sidebar-top-line' });
				
			// Get file name without extension
			const file = this.app.vault.getAbstractFileByPath(filePath);
			let fileName = file && file instanceof TFile ? file.basename : filePath.split('/').pop()?.replace('.md', '') || filePath;
			
			// Hide timestamps if setting is enabled
			if (this.plugin.settings.hideTimestampsInViews) {
				fileName = this.plugin.removeTimestampFromFileName(fileName);
			}
			
			// Create link to the note (without brackets)
			const link = topLine.createEl('a', { 
				text: fileName,
				cls: 'internal-link',
				href: filePath
			});
				
				// Add click handler to open the note
				link.onclick = (e) => {
					e.preventDefault();
					const file = this.app.vault.getAbstractFileByPath(filePath);
					if (file && file instanceof TFile) {
						this.app.workspace.openLinkText(filePath, '', false);
					}
				};
				
				// Total time tracked on the right
				const timeText = this.plugin.formatTimeAsHHMMSS(totalTime);
				topLine.createSpan({ text: timeText, cls: 'lapse-sidebar-time' });
				
				// Get project from frontmatter
				const project = await this.plugin.getProjectFromFrontmatter(filePath);
				
				// Second line: project (if available)
				if (project) {
					const secondLine = item.createDiv({ cls: 'lapse-sidebar-second-line' });
					secondLine.createSpan({ text: project, cls: 'lapse-sidebar-project' });
				}
				
				// List individual entries below (only if toggled on)
				if (this.showTodayEntries) {
					const entriesList = item.createDiv({ cls: 'lapse-sidebar-entries-list' });
					entries.forEach(({ entry }) => {
						const entryLine = entriesList.createDiv({ cls: 'lapse-sidebar-entry-line' });
						const entryTime = this.plugin.formatTimeAsHHMMSS(entry.duration);
						entryLine.createSpan({ text: entry.label, cls: 'lapse-sidebar-entry-label' });
						entryLine.createSpan({ text: entryTime, cls: 'lapse-sidebar-entry-time' });
					});
				}
			}
		}

		// Add pie chart section at the bottom
		await this.renderPieChart(container as HTMLElement, todayStart);

		// Set up refresh interval - always run to detect new timers
		// Clear any existing interval first
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
		}
		
		// Check more frequently (1 second) to catch changes faster
		this.refreshInterval = window.setInterval(() => {
			this.updateTimers().catch(err => console.error('Error updating timers:', err));
		}, 1000);
	}

	async updateTimers() {
		// Increment refresh counter
		this.refreshCounter++;
		
		// Every 10 seconds (10 calls at 1 second interval), do a full refresh to catch metadata changes
		if (this.refreshCounter >= 10) {
			this.refreshCounter = 0;
			// Clear cache for files that have active entries to reload fresh metadata
			this.plugin.timeData.forEach((pageData, filePath) => {
				this.plugin.invalidateCacheForFile(filePath);
			});
			await this.render();
			return;
		}
		
		// Get current active timers from memory only (don't scan all files)
		const currentActiveTimers: Array<{ filePath: string; entry: TimeEntry }> = [];
		this.plugin.timeData.forEach((pageData, filePath) => {
			pageData.entries.forEach(entry => {
				if (entry.startTime && !entry.endTime) {
					currentActiveTimers.push({ filePath, entry });
				}
			});
		});
		
		const displayedEntryIds = new Set(this.timeDisplays.keys());
		const activeEntryIds = new Set(currentActiveTimers.map(({ entry }) => entry.id));
		
		// If there are new active timers or timers that stopped, do a full refresh
		if (currentActiveTimers.length !== displayedEntryIds.size || 
		    ![...displayedEntryIds].every(id => activeEntryIds.has(id))) {
			// New timer started or timer stopped - do full refresh
			await this.render();
			return;
		}
		
		// Only update the time displays for existing timers
		this.timeDisplays.forEach((timeDisplay, entryId) => {
			// Find the entry in timeData
			let foundEntry: TimeEntry | null = null;
			let found = false;
			
			for (const [filePath, pageData] of this.plugin.timeData) {
				for (const entry of pageData.entries) {
					if (entry.id === entryId && entry.startTime && !entry.endTime) {
						foundEntry = entry;
						found = true;
						break;
					}
				}
				if (found) break;
			}
			
			if (foundEntry && foundEntry.startTime) {
				const elapsed = foundEntry.duration + (foundEntry.isPaused ? 0 : (Date.now() - foundEntry.startTime));
				const timeText = this.plugin.formatTimeAsHHMMSS(elapsed);
				timeDisplay.setText(timeText);
			} else {
				// Entry no longer active, remove from map
				this.timeDisplays.delete(entryId);
			}
		});
	}

	async renderPieChart(container: HTMLElement, todayStart: number) {
		// Calculate total time and project breakdown for today
		const projectTimes = new Map<string, number>();
		let totalTimeToday = 0;

		// Get all entries from today (including active timers)
		// First check entries already loaded in memory
		for (const [filePath, pageData] of this.plugin.timeData) {
			for (const entry of pageData.entries) {
				if (entry.startTime && entry.startTime >= todayStart) {
					let entryDuration = 0;
					if (entry.endTime !== null) {
						entryDuration = entry.duration;
					} else if (entry.startTime !== null) {
						// Active timer - include current elapsed time
						entryDuration = entry.duration + (Date.now() - entry.startTime);
					}

					if (entryDuration > 0) {
						totalTimeToday += entryDuration;
						
						// Get project for this entry
						const project = await this.plugin.getProjectFromFrontmatter(filePath);
						const projectName = project || 'No Project';
						
						const currentTime = projectTimes.get(projectName) || 0;
						projectTimes.set(projectName, currentTime + entryDuration);
					}
				}
			}
		}

		// Also check all files using cache for fast access
		const markdownFiles = this.app.vault.getMarkdownFiles();
		
		for (const file of markdownFiles) {
			const filePath = file.path;
			
			// Skip excluded folders
			if (this.plugin.isFileExcluded(filePath)) {
				continue;
			}
			
			// Skip if already checked in memory
			if (this.plugin.timeData.has(filePath)) {
				continue;
			}
			
			// Use cached data or load if needed
			const { entries: fileEntries, project } = await this.plugin.getCachedOrLoadEntries(filePath);
			
			for (const entry of fileEntries) {
				if (entry.startTime && entry.startTime >= todayStart) {
					let entryDuration = 0;
					if (entry.endTime !== null) {
						entryDuration = entry.duration;
					} else if (entry.startTime !== null) {
						// Active timer - include current elapsed time
						entryDuration = entry.duration + (Date.now() - entry.startTime);
					}

					if (entryDuration > 0) {
						totalTimeToday += entryDuration;
						const projectName = project || 'No Project';
						const currentTime = projectTimes.get(projectName) || 0;
						projectTimes.set(projectName, currentTime + entryDuration);
					}
				}
			}
		}

		// Only show chart if there's time tracked today
		if (totalTimeToday === 0) {
			return;
		}

		// Create section container
		const chartSection = container.createDiv({ cls: 'lapse-sidebar-chart-section' });
		chartSection.createEl('h4', { text: 'Today\'s Summary', cls: 'lapse-sidebar-section-title' });

		// Display total time in bigger text
		const totalTimeDiv = chartSection.createDiv({ cls: 'lapse-sidebar-total-time' });
		totalTimeDiv.setText(this.plugin.formatTimeAsHHMMSS(totalTimeToday));

		// Create pie chart container
		const chartContainer = chartSection.createDiv({ cls: 'lapse-sidebar-chart-container' });
		
		// Create SVG for pie chart
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'lapse-sidebar-pie-chart');
		svg.setAttribute('width', '200');
		svg.setAttribute('height', '200');
		svg.setAttribute('viewBox', '0 0 200 200');
		chartContainer.appendChild(svg);

		// Generate colors for projects
		const colors = [
			'#4A90E2', '#50C878', '#FF6B6B', '#FFD93D', 
			'#9B59B6', '#E67E22', '#1ABC9C', '#E74C3C',
			'#3498DB', '#2ECC71', '#F39C12', '#16A085'
		];

		// Convert map to array and sort by time (descending)
		const projectData = Array.from(projectTimes.entries())
			.map(([name, time], index) => ({
				name,
				time,
				color: colors[index % colors.length]
			}))
			.sort((a, b) => b.time - a.time);

		// Draw pie chart
		let currentAngle = -Math.PI / 2; // Start at top
		const centerX = 100;
		const centerY = 100;
		const radius = 80;

		projectData.forEach(({ name, time, color }) => {
			const percentage = time / totalTimeToday;
			const angle = percentage * 2 * Math.PI;

			// Create path for this slice
			const startAngle = currentAngle;
			const endAngle = currentAngle + angle;

			const x1 = centerX + radius * Math.cos(startAngle);
			const y1 = centerY + radius * Math.sin(startAngle);
			const x2 = centerX + radius * Math.cos(endAngle);
			const y2 = centerY + radius * Math.sin(endAngle);

			const largeArc = angle > Math.PI ? 1 : 0;

			const pathData = [
				`M ${centerX} ${centerY}`,
				`L ${x1} ${y1}`,
				`A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`,
				'Z'
			].join(' ');

			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', pathData);
			path.setAttribute('fill', color);
			path.setAttribute('stroke', 'var(--background-primary)');
			path.setAttribute('stroke-width', '2');
			svg.appendChild(path);

			currentAngle += angle;
		});

		// Create legend with labels
		const legend = chartSection.createDiv({ cls: 'lapse-sidebar-chart-legend' });
		
		projectData.forEach(({ name, time, color }) => {
			const legendItem = legend.createDiv({ cls: 'lapse-sidebar-legend-item' });
			
			// Color indicator
			const colorBox = legendItem.createDiv({ cls: 'lapse-sidebar-legend-color' });
			colorBox.style.backgroundColor = color;
			
			// Project name and time
			const label = legendItem.createDiv({ cls: 'lapse-sidebar-legend-label' });
			const nameSpan = label.createSpan({ text: name });
			const timeSpan = label.createSpan({ 
				text: this.plugin.formatTimeAsHHMMSS(time),
				cls: 'lapse-sidebar-legend-time'
			});
		});
	}

	async refresh() {
		// Full refresh - rebuild everything (called from external code)
		await this.render();
	}

	async onClose() {
		// Cleanup interval
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
			this.refreshInterval = null;
		}
	}
}

class LapseSettingTab extends PluginSettingTab {
	plugin: LapsePlugin;

	constructor(app: App, plugin: LapsePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h3', { text: 'Frontmatter Keys' });

		new Setting(containerEl)
			.setName('Start Time Key')
			.setDesc('Frontmatter key for start time')
			.addText(text => text
				.setPlaceholder('startTime')
				.setValue(this.plugin.settings.startTimeKey)
				.onChange(async (value) => {
					this.plugin.settings.startTimeKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('End Time Key')
			.setDesc('Frontmatter key for end time')
			.addText(text => text
				.setPlaceholder('endTime')
				.setValue(this.plugin.settings.endTimeKey)
				.onChange(async (value) => {
					this.plugin.settings.endTimeKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Total Time Key')
			.setDesc('Frontmatter key for total time tracked')
			.addText(text => text
				.setPlaceholder('totalTimeTracked')
				.setValue(this.plugin.settings.totalTimeKey)
				.onChange(async (value) => {
					this.plugin.settings.totalTimeKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Project Key')
			.setDesc('Frontmatter key for project name')
			.addText(text => text
				.setPlaceholder('project')
				.setValue(this.plugin.settings.projectKey)
				.onChange(async (value) => {
					this.plugin.settings.projectKey = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Default Time Entry Label' });

		new Setting(containerEl)
			.setName('Label Type')
			.setDesc('How to determine the default label for new time entries')
			.addDropdown(dropdown => dropdown
				.addOption('freeText', 'Free Text')
				.addOption('frontmatter', 'Frontmatter')
				.addOption('fileName', 'File Name')
				.setValue(this.plugin.settings.defaultLabelType)
				.onChange(async (value: 'freeText' | 'frontmatter' | 'fileName') => {
					this.plugin.settings.defaultLabelType = value;
					await this.plugin.saveSettings();
					this.display(); // Refresh to show/hide conditional inputs
				}));

		if (this.plugin.settings.defaultLabelType === 'freeText') {
			new Setting(containerEl)
				.setName('Default Label Text')
				.setDesc('Default text to use for new time entries')
				.addText(text => text
					.setPlaceholder('Enter default label')
					.setValue(this.plugin.settings.defaultLabelText)
					.onChange(async (value) => {
						this.plugin.settings.defaultLabelText = value;
						await this.plugin.saveSettings();
					}));
		}

		if (this.plugin.settings.defaultLabelType === 'frontmatter') {
			new Setting(containerEl)
				.setName('Frontmatter Key')
				.setDesc('Frontmatter key to use for default label')
				.addText(text => text
					.setPlaceholder('project')
					.setValue(this.plugin.settings.defaultLabelFrontmatterKey)
					.onChange(async (value) => {
						this.plugin.settings.defaultLabelFrontmatterKey = value;
						await this.plugin.saveSettings();
					}));
		}

		if (this.plugin.settings.defaultLabelType === 'fileName') {
			new Setting(containerEl)
				.setName('Remove timestamp from filename')
				.setDesc('When enabled, removes date and time stamps from filenames when setting the default label')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.removeTimestampFromFileName)
					.onChange(async (value) => {
						this.plugin.settings.removeTimestampFromFileName = value;
						await this.plugin.saveSettings();
					}));
		}

		containerEl.createEl('h3', { text: 'Display Options' });

		new Setting(containerEl)
			.setName('Hide timestamps in views')
			.setDesc('When enabled, removes the display of timestamps in note titles in Active Timers and Time Reports views. This does not change the name of any note, just hides the timestamp for cleaner display.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.hideTimestampsInViews)
				.onChange(async (value) => {
					this.plugin.settings.hideTimestampsInViews = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show status bar')
			.setDesc('Display active timer(s) in the status bar at the bottom of Obsidian')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showStatusBar)
				.onChange(async (value) => {
					this.plugin.settings.showStatusBar = value;
					await this.plugin.saveSettings();
					
					// Update status bar visibility
					if (value) {
						if (!this.plugin.statusBarItem) {
							this.plugin.statusBarItem = this.plugin.addStatusBarItem();
							this.plugin.statusBarItem.addClass('lapse-status-bar');
						}
						this.plugin.updateStatusBar();
						if (!this.plugin.statusBarUpdateInterval) {
							this.plugin.statusBarUpdateInterval = window.setInterval(() => {
								this.plugin.updateStatusBar();
							}, 1000);
						}
					} else {
						if (this.plugin.statusBarUpdateInterval) {
							window.clearInterval(this.plugin.statusBarUpdateInterval);
							this.plugin.statusBarUpdateInterval = null;
						}
						if (this.plugin.statusBarItem) {
							this.plugin.statusBarItem.setText('');
							this.plugin.statusBarItem.hide();
						}
					}
				}));

		new Setting(containerEl)
			.setName('First day of week')
			.setDesc('Set the first day of the week for weekly reports')
			.addDropdown(dropdown => dropdown
				.addOption('0', 'Sunday')
				.addOption('1', 'Monday')
				.addOption('2', 'Tuesday')
				.addOption('3', 'Wednesday')
				.addOption('4', 'Thursday')
				.addOption('5', 'Friday')
				.addOption('6', 'Saturday')
				.setValue(this.plugin.settings.firstDayOfWeek.toString())
				.onChange(async (value) => {
					this.plugin.settings.firstDayOfWeek = parseInt(value);
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Tags' });

		new Setting(containerEl)
			.setName('Default tag on note')
			.setDesc('Tag to add to notes when time entries are created (e.g., #lapse)')
			.addText(text => text
				.setPlaceholder('#lapse')
				.setValue(this.plugin.settings.defaultTagOnNote)
				.onChange(async (value) => {
					this.plugin.settings.defaultTagOnNote = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Default tag on time entries')
			.setDesc('Tag to automatically add to new time entries (leave empty for none, e.g., #work)')
			.addText(text => text
				.setPlaceholder('#work')
				.setValue(this.plugin.settings.defaultTagOnTimeEntries)
				.onChange(async (value) => {
					this.plugin.settings.defaultTagOnTimeEntries = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Timer Controls' });

		new Setting(containerEl)
			.setName('Show seconds')
			.setDesc('Display seconds in timer')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showSeconds)
				.onChange(async (value) => {
					this.plugin.settings.showSeconds = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Time Adjustment')
			.setDesc('Number of minutes to adjust start time with << and >> buttons')
			.addText(text => text
				.setPlaceholder('5')
				.setValue(this.plugin.settings.timeAdjustMinutes.toString())
				.onChange(async (value) => {
					const numValue = parseInt(value) || 5;
					this.plugin.settings.timeAdjustMinutes = numValue;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Performance' });

		new Setting(containerEl)
			.setName('Excluded folders')
			.setDesc('Folders to exclude from time tracking (one pattern per line). Supports glob patterns like */2020/* or **/Archive/**')
			.addTextArea(text => {
				text
					.setPlaceholder('Templates\n*/2020/*\n**/Archive/**')
					.setValue(this.plugin.settings.excludedFolders.join('\n'))
					.onChange(async (value) => {
						// Split by newline and filter empty lines
						this.plugin.settings.excludedFolders = value
							.split('\n')
							.map(line => line.trim())
							.filter(line => line.length > 0);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 6;
				text.inputEl.cols = 40;
			});

		containerEl.createDiv({ cls: 'setting-item-description' })
			.createEl('div', { text: 'Example patterns:', cls: 'setting-item-description' })
			.createEl('ul', {}, (ul) => {
				ul.createEl('li', { text: 'Templates - Exact folder name' });
				ul.createEl('li', { text: '*/2020/* - 2020 folder one level deep' });
				ul.createEl('li', { text: '**/2020/** - 2020 folder at any depth' });
				ul.createEl('li', { text: '**/Archive - Any folder ending in Archive' });
			});
	}
}

class LapseReportsView extends ItemView {
	plugin: LapsePlugin;
	dateFilter: 'today' | 'thisWeek' | 'thisMonth' | 'lastWeek' | 'lastMonth' | 'custom' = 'today';
	customStartDate: string = '';
	customEndDate: string = '';
	groupBy: 'note' | 'project' | 'date' | 'tag' = 'note';
	secondaryGroupBy: 'none' | 'note' | 'project' | 'tag' | 'date' = 'none';
	expandedGroups: Set<string> = new Set(); // Track which groups are expanded

	constructor(leaf: WorkspaceLeaf, plugin: LapsePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return 'lapse-reports';
	}

	getDisplayText(): string {
		return 'Time Reports';
	}

	getIcon(): string {
		return 'bar-chart-2';
	}

	async onOpen() {
		await this.render();
	}

	async render() {
		const container = this.containerEl.children[1];
		container.empty();

		// Header with inline controls
		const header = container.createDiv({ cls: 'lapse-reports-header' });
		
		// Controls container - all inline
		const controlsContainer = header.createDiv({ cls: 'lapse-reports-controls' });
		
		// Date filter dropdown
		const dateFilterSetting = controlsContainer.createDiv({ cls: 'lapse-reports-groupby' });
		dateFilterSetting.createEl('label', { text: 'Period: ' });
		const dateFilterSelect = dateFilterSetting.createEl('select', { cls: 'lapse-reports-select' });
		dateFilterSelect.createEl('option', { text: 'Today', value: 'today' });
		dateFilterSelect.createEl('option', { text: 'This Week', value: 'thisWeek' });
		dateFilterSelect.createEl('option', { text: 'This Month', value: 'thisMonth' });
		dateFilterSelect.createEl('option', { text: 'Last Week', value: 'lastWeek' });
		dateFilterSelect.createEl('option', { text: 'Last Month', value: 'lastMonth' });
		dateFilterSelect.createEl('option', { text: 'Choose...', value: 'custom' });
		dateFilterSelect.value = this.dateFilter;
		dateFilterSelect.onchange = async () => {
			this.dateFilter = dateFilterSelect.value as 'today' | 'thisWeek' | 'thisMonth' | 'lastWeek' | 'lastMonth' | 'custom';
			await this.render();
		};
		
		// Primary grouping
		const groupBySetting = controlsContainer.createDiv({ cls: 'lapse-reports-groupby' });
		groupBySetting.createEl('label', { text: 'Group by: ' });
		const groupBySelect = groupBySetting.createEl('select', { cls: 'lapse-reports-select' });
		groupBySelect.createEl('option', { text: 'Note', value: 'note' });
		groupBySelect.createEl('option', { text: 'Project', value: 'project' });
		groupBySelect.createEl('option', { text: 'Tag', value: 'tag' });
		groupBySelect.createEl('option', { text: 'Date', value: 'date' });
		groupBySelect.value = this.groupBy;
		groupBySelect.onchange = async () => {
			this.groupBy = groupBySelect.value as 'note' | 'project' | 'date' | 'tag';
			await this.render();
		};

		// Secondary grouping
		const secondaryGroupBySetting = controlsContainer.createDiv({ cls: 'lapse-reports-groupby' });
		secondaryGroupBySetting.createEl('label', { text: 'Then by: ' });
		const secondaryGroupBySelect = secondaryGroupBySetting.createEl('select', { cls: 'lapse-reports-select' });
		secondaryGroupBySelect.createEl('option', { text: 'None', value: 'none' });
		secondaryGroupBySelect.createEl('option', { text: 'Note', value: 'note' });
		secondaryGroupBySelect.createEl('option', { text: 'Project', value: 'project' });
		secondaryGroupBySelect.createEl('option', { text: 'Tag', value: 'tag' });
		secondaryGroupBySelect.createEl('option', { text: 'Date', value: 'date' });
		secondaryGroupBySelect.value = this.secondaryGroupBy;
		secondaryGroupBySelect.onchange = async () => {
			this.secondaryGroupBy = secondaryGroupBySelect.value as 'none' | 'note' | 'project' | 'tag' | 'date';
			await this.render();
		};

		// Custom date range picker (shown only when custom is selected)
		if (this.dateFilter === 'custom') {
			const customDateRow = container.createDiv({ cls: 'lapse-reports-custom-date' });
			
			customDateRow.createEl('label', { text: 'Start: ' });
			const startDateInput = customDateRow.createEl('input', { 
				type: 'date',
				cls: 'lapse-date-input'
			});
			startDateInput.value = this.customStartDate || new Date().toISOString().split('T')[0];
			
			customDateRow.createEl('label', { text: 'End: ' });
			const endDateInput = customDateRow.createEl('input', { 
				type: 'date',
				cls: 'lapse-date-input'
			});
			endDateInput.value = this.customEndDate || new Date().toISOString().split('T')[0];
			
			const applyBtn = customDateRow.createEl('button', { 
				text: 'Apply',
				cls: 'lapse-apply-btn'
			});
			applyBtn.onclick = async () => {
				this.customStartDate = startDateInput.value;
				this.customEndDate = endDateInput.value;
				await this.render();
			};
		}

		// Get data for the selected period
		const data = await this.getReportData();

		// Summary section
		const summary = container.createDiv({ cls: 'lapse-reports-summary' });
		const totalTime = data.reduce((sum, item) => sum + item.totalTime, 0);
		summary.createEl('h3', { text: `Total: ${this.plugin.formatTimeAsHHMMSS(totalTime)}` });

		// Data table
		const tableContainer = container.createDiv({ cls: 'lapse-reports-table-container' });
		const table = tableContainer.createEl('table', { cls: 'lapse-reports-table' });
		
		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		headerRow.createEl('th', { text: '' }); // Expand/collapse column
		headerRow.createEl('th', { text: this.getGroupByLabel() });
		headerRow.createEl('th', { text: 'Project' });
		headerRow.createEl('th', { text: 'Tags' });
		headerRow.createEl('th', { text: 'Time' });
		headerRow.createEl('th', { text: 'Entries' });

		const tbody = table.createEl('tbody');
		
		// Sort by time descending
		const sortedData = [...data].sort((a, b) => b.totalTime - a.totalTime);

		for (const item of sortedData) {
			// Primary group row
			const row = tbody.createEl('tr', { cls: 'lapse-reports-group-row' });
			
			// Expand/collapse icon
			const expandCell = row.createEl('td', { cls: 'lapse-reports-expand-cell' });
			const expandBtn = expandCell.createEl('span', { cls: 'lapse-reports-expand-btn' });
			const groupId = `group-${item.group}`;
			const isExpanded = this.expandedGroups.has(groupId);
			setIcon(expandBtn, isExpanded ? 'chevron-down' : 'chevron-right');
			
			row.createEl('td', { text: item.group, cls: 'lapse-reports-group-name' });
			
			// Aggregate project/tags for group
			const projects = new Set(item.entries.map(e => e.project).filter(p => p));
			const allTags = new Set<string>();
			item.entries.forEach(e => e.entry.tags?.forEach(t => allTags.add(t)));
			
			row.createEl('td', { text: projects.size > 0 ? Array.from(projects).join(', ') : '-' });
			row.createEl('td', { text: allTags.size > 0 ? Array.from(allTags).map(t => `#${t}`).join(', ') : '-' });
			row.createEl('td', { text: this.plugin.formatTimeAsHHMMSS(item.totalTime) });
			row.createEl('td', { text: item.entryCount.toString() });

			// Click to expand/collapse
			row.style.cursor = 'pointer';
			row.onclick = () => {
				if (this.expandedGroups.has(groupId)) {
					this.expandedGroups.delete(groupId);
				} else {
					this.expandedGroups.add(groupId);
				}
				this.render();
			};

			// Show entries or subgroups if expanded
			if (isExpanded) {
				if (item.subGroups && item.subGroups.size > 0) {
					// Show secondary grouping
					for (const [subGroupName, subGroup] of item.subGroups) {
						const subRow = tbody.createEl('tr', { cls: 'lapse-reports-subgroup-row' });
						subRow.createEl('td'); // Empty expand cell
						subRow.createEl('td', { text: `  ${subGroupName}`, cls: 'lapse-reports-subgroup-name' });
						
						const subProjects = new Set(subGroup.entries.map(e => e.project).filter(p => p));
						const subTags = new Set<string>();
						subGroup.entries.forEach(e => e.entry.tags?.forEach(t => subTags.add(t)));
						
						subRow.createEl('td', { text: subProjects.size > 0 ? Array.from(subProjects).join(', ') : '-' });
						subRow.createEl('td', { text: subTags.size > 0 ? Array.from(subTags).map(t => `#${t}`).join(', ') : '-' });
						subRow.createEl('td', { text: this.plugin.formatTimeAsHHMMSS(subGroup.totalTime) });
						subRow.createEl('td', { text: subGroup.entryCount.toString() });
					}
				} else {
					// Show individual entries
					for (const { entry, noteName, project } of item.entries) {
						const entryRow = tbody.createEl('tr', { cls: 'lapse-reports-entry-row' });
						entryRow.createEl('td'); // Empty expand cell
						entryRow.createEl('td', { text: `  ${entry.label}`, cls: 'lapse-reports-entry-label' });
						entryRow.createEl('td', { text: project || '-' });
						entryRow.createEl('td', { text: entry.tags && entry.tags.length > 0 ? entry.tags.map(t => `#${t}`).join(', ') : '-' });
						
						const entryDuration = entry.endTime 
							? entry.duration 
							: entry.duration + (Date.now() - entry.startTime!);
						
						entryRow.createEl('td', { text: this.plugin.formatTimeAsHHMMSS(entryDuration) });
						entryRow.createEl('td', { text: noteName, cls: 'lapse-reports-note-name' });
					}
				}
			}
		}

		// Chart section
		if (data.length > 0) {
			const chartContainer = container.createDiv({ cls: 'lapse-reports-chart-container' });
			await this.renderChart(chartContainer, data, totalTime);
		}
	}

	getGroupByLabel(): string {
		switch (this.groupBy) {
			case 'note': return 'Note';
			case 'project': return 'Project';
			case 'tag': return 'Tag';
			case 'date': return 'Date';
			default: return 'Group';
		}
	}

	getGroupKey(entry: TimeEntry, filePath: string, project: string | null, groupType: 'note' | 'project' | 'date' | 'tag' | 'none'): string {
		if (groupType === 'none') return 'All';
		
		if (groupType === 'note') {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			let noteName = file && file instanceof TFile ? file.basename : filePath;
			// Hide timestamps if setting is enabled
			if (this.plugin.settings.hideTimestampsInViews) {
				noteName = this.plugin.removeTimestampFromFileName(noteName);
			}
			return noteName;
		} else if (groupType === 'project') {
			// Extract just the project name, not the full path
			if (project) {
				// If project contains a path separator, take the last part
				const parts = project.split('/');
				return parts[parts.length - 1];
			}
			return 'No Project';
		} else if (groupType === 'tag') {
			// Group by first tag, or "No Tag"
			if (entry.tags && entry.tags.length > 0) {
				return `#${entry.tags[0]}`;
			}
			return 'No Tag';
		} else { // date
			const date = new Date(entry.startTime!);
			return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
		}
	}

	async getReportData(): Promise<Array<{ 
		group: string; 
		totalTime: number; 
		entryCount: number;
		entries: Array<{ 
			entry: TimeEntry; 
			filePath: string; 
			project: string | null;
			noteName: string;
		}>;
		subGroups?: Map<string, {
			totalTime: number;
			entryCount: number;
			entries: Array<{ 
				entry: TimeEntry; 
				filePath: string; 
				project: string | null;
				noteName: string;
			}>;
		}>;
	}>> {
		// Calculate date range based on date filter
		const now = new Date();
		let startDate: Date;
		let endDate: Date = new Date(now);

		if (this.dateFilter === 'today') {
			startDate = new Date(now);
			startDate.setHours(0, 0, 0, 0);
		} else if (this.dateFilter === 'thisWeek') {
			startDate = new Date(now);
			const dayOfWeek = startDate.getDay();
			const daysFromFirstDay = (dayOfWeek - this.plugin.settings.firstDayOfWeek + 7) % 7;
			startDate.setDate(startDate.getDate() - daysFromFirstDay);
			startDate.setHours(0, 0, 0, 0);
		} else if (this.dateFilter === 'thisMonth') {
			startDate = new Date(now.getFullYear(), now.getMonth(), 1);
			startDate.setHours(0, 0, 0, 0);
		} else if (this.dateFilter === 'lastWeek') {
			const firstDayOfWeek = this.plugin.settings.firstDayOfWeek;
			const today = new Date(now);
			const dayOfWeek = today.getDay();
			const daysFromFirstDay = (dayOfWeek - firstDayOfWeek + 7) % 7;
			// Go to start of this week, then back 7 days
			startDate = new Date(today);
			startDate.setDate(today.getDate() - daysFromFirstDay - 7);
			startDate.setHours(0, 0, 0, 0);
			// End date is 6 days later (end of last week)
			endDate = new Date(startDate);
			endDate.setDate(startDate.getDate() + 6);
			endDate.setHours(23, 59, 59, 999);
		} else if (this.dateFilter === 'lastMonth') {
			const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
			startDate = new Date(lastMonth);
			startDate.setHours(0, 0, 0, 0);
			// Last day of last month
			endDate = new Date(now.getFullYear(), now.getMonth(), 0);
			endDate.setHours(23, 59, 59, 999);
		} else { // custom
			if (this.customStartDate && this.customEndDate) {
				startDate = new Date(this.customStartDate);
				startDate.setHours(0, 0, 0, 0);
				endDate = new Date(this.customEndDate);
				endDate.setHours(23, 59, 59, 999);
			} else {
				// Default to today if no custom dates set
				startDate = new Date(now);
				startDate.setHours(0, 0, 0, 0);
			}
		}

		const startTime = startDate.getTime();
		const endTime = endDate.getTime();

		// Collect all entries in the date range using cache
		const entries: Array<{ filePath: string; entry: TimeEntry; project: string | null; noteName: string }> = [];

		// Check all markdown files
		const markdownFiles = this.app.vault.getMarkdownFiles();
		
		for (const file of markdownFiles) {
			const filePath = file.path;
			
			// Skip excluded folders
			if (this.plugin.isFileExcluded(filePath)) {
				continue;
			}
			
			// Use cached data or load if needed
			const { entries: fileEntries, project } = await this.plugin.getCachedOrLoadEntries(filePath);
			
			for (const entry of fileEntries) {
				if (entry.startTime && entry.startTime >= startTime && entry.startTime <= endTime) {
				// Only include completed entries or active timers
				if (entry.endTime || (entry.startTime && !entry.endTime)) {
					let noteName = file.basename;
					// Hide timestamps if setting is enabled
					if (this.plugin.settings.hideTimestampsInViews) {
						noteName = this.plugin.removeTimestampFromFileName(noteName);
					}
					entries.push({ filePath, entry, project, noteName });
				}
				}
			}
		}

		// Group entries hierarchically
		const grouped = new Map<string, { 
			totalTime: number; 
			entryCount: number;
			entries: Array<{ entry: TimeEntry; filePath: string; project: string | null; noteName: string }>;
			subGroups?: Map<string, {
				totalTime: number;
				entryCount: number;
				entries: Array<{ entry: TimeEntry; filePath: string; project: string | null; noteName: string }>;
			}>;
		}>();

		for (const { filePath, entry, project, noteName } of entries) {
			// Primary grouping
			const primaryKey = this.getGroupKey(entry, filePath, project, this.groupBy);

			if (!grouped.has(primaryKey)) {
				grouped.set(primaryKey, { 
					totalTime: 0, 
					entryCount: 0,
					entries: [],
					subGroups: this.secondaryGroupBy !== 'none' ? new Map() : undefined
				});
			}

			const entryDuration = entry.endTime 
				? entry.duration 
				: entry.duration + (Date.now() - entry.startTime!);

			const primaryGroup = grouped.get(primaryKey)!;
			primaryGroup.totalTime += entryDuration;
			primaryGroup.entryCount++;
			primaryGroup.entries.push({ entry, filePath, project, noteName });

			// Secondary grouping if enabled
			if (this.secondaryGroupBy !== 'none' && primaryGroup.subGroups) {
				const secondaryKey = this.getGroupKey(entry, filePath, project, this.secondaryGroupBy);
				
				if (!primaryGroup.subGroups.has(secondaryKey)) {
					primaryGroup.subGroups.set(secondaryKey, {
						totalTime: 0,
						entryCount: 0,
						entries: []
					});
				}

				const secondaryGroup = primaryGroup.subGroups.get(secondaryKey)!;
				secondaryGroup.totalTime += entryDuration;
				secondaryGroup.entryCount++;
				secondaryGroup.entries.push({ entry, filePath, project, noteName });
			}
		}

		// Convert to array
		return Array.from(grouped.entries()).map(([group, stats]) => ({
			group,
			totalTime: stats.totalTime,
			entryCount: stats.entryCount,
			entries: stats.entries,
			subGroups: stats.subGroups
		}));
	}

	async renderChart(container: HTMLElement, data: Array<{ group: string; totalTime: number }>, totalTime: number) {
		container.empty();
		container.createEl('h4', { text: 'Time Distribution' });

		// Dimensions in viewBox coordinates
		const viewBoxWidth = 1000; // Wide viewBox for proper aspect ratio
		const chartHeight = 250; // Height of bar area
		const labelHeight = 80; // Space for labels below bars
		const totalHeight = chartHeight + labelHeight;
		const padding = 40;
		const chartAreaWidth = viewBoxWidth - (padding * 2);
		
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'lapse-reports-chart');
		svg.setAttribute('width', '100%');
		svg.setAttribute('height', '300'); // Fixed pixel height
		svg.setAttribute('viewBox', `0 0 ${viewBoxWidth} ${totalHeight}`);
		svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
		container.appendChild(svg);

		// Bar chart
		const maxTime = Math.max(...data.map(d => d.totalTime));
		const barCount = data.length;
		const barWidth = chartAreaWidth / barCount; // Each bar gets equal width in viewBox
		const maxBarHeight = chartHeight - padding * 2;
		const colors = [
			'#4A90E2', '#50C878', '#FF6B6B', '#FFD93D', 
			'#9B59B6', '#E67E22', '#1ABC9C', '#E74C3C'
		];

		data.forEach((item, index) => {
			const barHeight = maxTime > 0 ? (item.totalTime / maxTime) * maxBarHeight : 0;
			const x = padding + index * barWidth;
			const y = chartHeight - padding - barHeight;

			// Bar with small gap between bars
			const barGap = barWidth * 0.1; // 10% gap
			const actualBarWidth = barWidth - barGap;
			
			const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
			rect.setAttribute('x', (x + barGap / 2).toString());
			rect.setAttribute('y', y.toString());
			rect.setAttribute('width', actualBarWidth.toString());
			rect.setAttribute('height', barHeight.toString());
			rect.setAttribute('fill', colors[index % colors.length]);
			rect.setAttribute('rx', '4');
			svg.appendChild(rect);

			// Label - rotated if many bars, otherwise horizontal
			const labelY = chartHeight + 10;
			
			// Use foreignObject for better text wrapping
			const foreignObject = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
			foreignObject.setAttribute('x', (x + barGap / 2).toString());
			foreignObject.setAttribute('y', labelY.toString());
			foreignObject.setAttribute('width', actualBarWidth.toString());
			foreignObject.setAttribute('height', labelHeight.toString());
			
			const labelDiv = document.createElement('div');
			labelDiv.setAttribute('class', 'lapse-chart-label');
			labelDiv.style.width = '100%';
			labelDiv.style.height = '100%';
			labelDiv.style.display = 'flex';
			labelDiv.style.alignItems = 'flex-start';
			labelDiv.style.justifyContent = 'center';
			labelDiv.style.fontSize = barCount > 15 ? '9px' : barCount > 10 ? '10px' : '11px';
			labelDiv.style.color = 'var(--text-muted)';
			labelDiv.style.textAlign = 'center';
			labelDiv.style.wordWrap = 'break-word';
			labelDiv.style.overflowWrap = 'break-word';
			labelDiv.style.lineHeight = '1.2';
			labelDiv.style.padding = '0 2px';
			
			// Rotate text if there are many bars
			if (barCount > 10) {
				labelDiv.style.writingMode = 'vertical-rl';
				labelDiv.style.textOrientation = 'mixed';
				labelDiv.style.transform = 'rotate(180deg)';
				labelDiv.style.alignItems = 'center';
			}
			
			labelDiv.textContent = item.group;
			foreignObject.appendChild(labelDiv);
			svg.appendChild(foreignObject);
		});
	}
}
