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
	lapseButtonTemplatesFolder: string; // Folder containing templates for lapse-button inline buttons
	showDurationOnNoteButtons: boolean; // Show duration on note buttons/links
	noteButtonDurationType: 'project' | 'note'; // Type of duration to show (project or note)
	noteButtonTimePeriod: 'today' | 'thisWeek' | 'thisMonth' | 'lastWeek' | 'lastMonth'; // Time period for duration
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
	showStatusBar: true, // Show active timers in status bar by default
	lapseButtonTemplatesFolder: 'Templates/Lapse Buttons', // Default folder for lapse button templates
	showDurationOnNoteButtons: false, // Don't show duration on note buttons by default
	noteButtonDurationType: 'note', // Default to note
	noteButtonTimePeriod: 'today' // Default to today
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
	groupBy?: 'project' | 'date' | 'tag' | 'note';
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

interface TemplateData {
	template: TFile;
	templateName: string;
	project: string | null;
	projectColor: string | null;
}

interface TemplateGroupResult {
	grouped: Map<string, TemplateData[]>;
	sortedProjects: string[];
}

interface NoteEntryGroup {
	file: TFile;
	entries: TimeEntry[];
}

export default class LapsePlugin extends Plugin {
	settings: LapseSettings;
	timeData: Map<string, PageTimeData> = new Map();
	entryCache: EntryCache = {}; // In-memory cache indexed by file path (lazy-loaded)
	cacheSaveTimeout: number | null = null; // Debounce cache saves
	statusBarItem: HTMLElement | null = null; // Status bar element
	statusBarUpdateInterval: number | null = null; // Interval for updating status bar
	pendingSaves: Promise<void>[] = []; // Track pending save operations
	colorMeasurementEl: HTMLElement | null = null; // Hidden element for measuring computed colors

	async onload() {
		const pluginStartTime = Date.now();
		await this.loadSettings();

		console.log(`Lapse: Plugin loading... (${Date.now() - pluginStartTime}ms)`);

		// Listen to metadata cache changes to automatically invalidate stale cache entries
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				// Invalidate cache for this file when its metadata changes
				this.invalidateCacheForFile(file.path);
			})
		);

		// Also invalidate on file deletion/rename
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				this.invalidateCacheForFile(file.path);
				// Also remove from in-memory timeData
				this.timeData.delete(file.path);
			})
		);

		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				this.invalidateCacheForFile(oldPath);
				this.timeData.delete(oldPath);
			})
		);

		// Register the code block processors
		this.registerMarkdownCodeBlockProcessor('lapse', this.processTimerCodeBlock.bind(this));
		this.registerMarkdownCodeBlockProcessor('lapse-report', this.processReportCodeBlock.bind(this));
		this.registerMarkdownCodeBlockProcessor('lapse-active', this.processActiveTimersCodeBlock.bind(this));

		// Register inline code processor for lapse template buttons
		this.registerMarkdownPostProcessor((el, ctx) => {
			// Find all code elements that are not inside code blocks
			const codeElements = el.querySelectorAll('code:not(pre code)');
			codeElements.forEach((codeEl) => {
				if (codeEl instanceof HTMLElement) {
					const text = codeEl.textContent || '';
					if (text.startsWith('lapse:')) {
						const templateName = text.substring('lapse:'.length);
						// Only process if not already processed (check if parent is a button)
						if (!codeEl.parentElement?.classList.contains('lapse-button')) {
							this.processLapseButton(codeEl, templateName, ctx).catch(err => {
								console.error('Error processing lapse button:', err);
							});
						}
					}
				}
			});
		});

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

		// Register the buttons view
		this.registerView(
			'lapse-buttons',
			(leaf) => new LapseButtonsView(leaf, this)
		);

		// Register the entry grid view
		this.registerView(
			'lapse-grid',
			(leaf) => new LapseGridView(leaf, this)
		);

		// Add ribbon icons
		this.addRibbonIcon('clock', 'Lapse: Show Activity', () => {
			this.activateView();
		});

		this.addRibbonIcon('bar-chart-2', 'Lapse: Show Time Reports', () => {
			this.activateReportsView();
		});

		this.addRibbonIcon('play-circle', 'Lapse: Show Quick Start', () => {
			this.activateButtonsView();
		});

		this.addRibbonIcon('table', 'Lapse: Show Entry Grid', () => {
			this.activateGridView();
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

		// Add command to show buttons view
		this.addCommand({
			id: 'show-lapse-buttons',
			name: 'Show quick start',
			callback: () => {
				this.activateButtonsView();
			}
		});

		// Add command to show entry grid view
		this.addCommand({
			id: 'show-lapse-grid',
			name: 'Show entry grid',
			callback: () => {
				this.activateGridView();
			}
		});

		// Add command to insert lapse button
		this.addCommand({
			id: 'insert-lapse-button',
			name: 'Insert template button',
			editorCallback: (editor) => {
				new LapseButtonModal(this.app, this, (templateName) => {
					editor.replaceSelection(`\`lapse:${templateName}\``);
				}).open();
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
			const parseTimestampValue = (value?: string | null): number | null => {
				if (!value) return null;
				return this.parseDatetimeLocal(value);
			};
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
								startTime: parseTimestampValue(currentEntry.start),
								endTime: parseTimestampValue(currentEntry.end),
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
								startTime: parseTimestampValue(currentEntry.start),
								endTime: parseTimestampValue(currentEntry.end),
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
						// Parse tags - can be inline array, comma-separated, or multiline array
						const tagsStr = trimmed.replace(/tags:\s*/, '').trim();
						if (tagsStr.startsWith('[')) {
							// Inline array format: tags: ["tag1", "tag2"]
							try {
								currentEntry.tags = JSON.parse(tagsStr);
							} catch {
								currentEntry.tags = [];
							}
						} else if (tagsStr) {
							// Comma-separated or single tag on same line
							currentEntry.tags = tagsStr.split(',').map(t => t.trim()).filter(t => t);
						} else {
							// Empty on this line, check next lines for multiline YAML array
							// Format:
							// tags:
							//   - tag1
							//   - tag2
							currentEntry.tags = [];
							let j = i + 1;
							while (j < lines.length) {
								const nextLine = lines[j];
								const nextTrimmed = nextLine.trim();
								const nextIndent = nextLine.length - nextLine.trimStart().length;
								
								// Check if this is an array item under tags (should have more indent than 'tags:')
								if (nextTrimmed.startsWith('-') && nextIndent > indent) {
									// Extract the tag value after the dash
									const tagValue = nextTrimmed.substring(1).trim();
									// Remove quotes if present
									const cleanTag = tagValue.replace(/^["'](.*)["']$/, '$1');
									if (cleanTag) {
										currentEntry.tags.push(cleanTag);
									}
									j++;
								} else if (nextTrimmed === '') {
									// Skip empty lines within the array
									j++;
								} else {
									// Hit a non-array line, stop parsing tags
									break;
								}
							}
							// Update i to skip the lines we've already processed
							i = j - 1;
						}
					}
				}
			}

			// Add last entry if exists
			if (currentEntry) {
				entries.push({
					id: `${filePath}-${entries.length}-${Date.now()}`,
					label: currentEntry.label || 'Untitled',
					startTime: parseTimestampValue(currentEntry.start),
					endTime: parseTimestampValue(currentEntry.end),
					duration: (currentEntry.duration || 0) * 1000,
					isPaused: false,
					tags: currentEntry.tags || []
				});
			}

			// Fallback: if no lapseEntries found, check for top-level startTime/endTime
			if (entries.length === 0) {
				const startTimeKey = this.settings.startTimeKey;
				const endTimeKey = this.settings.endTimeKey;
				let topLevelStart: string | null = null;
				let topLevelEnd: string | null = null;
				let topLevelTags: string[] = [];

				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed.startsWith(`${startTimeKey}:`)) {
						topLevelStart = trimmed.replace(`${startTimeKey}:`, '').trim();
					} else if (trimmed.startsWith(`${endTimeKey}:`)) {
						topLevelEnd = trimmed.replace(`${endTimeKey}:`, '').trim();
					} else if (trimmed.startsWith('tags:')) {
						const tagsStr = trimmed.replace('tags:', '').trim();
						if (tagsStr.startsWith('[')) {
							try {
								topLevelTags = JSON.parse(tagsStr);
							} catch {
								topLevelTags = [];
							}
						} else if (tagsStr) {
							topLevelTags = tagsStr.split(',').map(t => t.trim()).filter(t => t);
						}
					}
				}

				// Create synthetic entry from top-level times if we have at least a start time
				if (topLevelStart) {
					const parsedStart = parseTimestampValue(topLevelStart);
					const parsedEnd = parseTimestampValue(topLevelEnd);
					const duration = (parsedStart && parsedEnd) ? Math.max(0, parsedEnd - parsedStart) : 0;
					
					// Use filename as label
					const noteName = file.basename;
					const label = this.settings.removeTimestampFromFileName 
						? this.removeTimestampFromFileName(noteName) 
						: noteName;

					entries.push({
						id: `${filePath}-fallback-${Date.now()}`,
						label: label,
						startTime: parsedStart,
						endTime: parsedEnd,
						duration: duration,
						isPaused: false,
						tags: topLevelTags
					});
				}
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
			const tagName = this.normalizeTagValue(defaultTag);
			if (!tagName) {
				return;
			}

			if (match) {
				// Existing frontmatter - make sure tags block includes the default tag
				const frontmatter = match[1];
				const lines = frontmatter.split('\n');
				const tagsLineIndex = lines.findIndex(line => line.trim().toLowerCase().startsWith('tags:'));

				let existingTags: string[] = [];
				let indent = '';
				let replaceCount = 0;

				if (tagsLineIndex >= 0) {
					const parsed = this.parseTagsBlock(lines, tagsLineIndex);
					existingTags = parsed.tags;
					indent = parsed.indent;
					replaceCount = parsed.endIndex - tagsLineIndex;
				}

				const normalizedExisting = existingTags
					.map(tag => this.normalizeTagValue(tag))
					.filter(tag => tag.length > 0);

				const tagSet = new Set(normalizedExisting);
				const tagAlreadyPresent = tagSet.has(tagName);
				tagSet.add(tagName);

				if (!tagAlreadyPresent || tagsLineIndex < 0) {
					const combinedTags = Array.from(tagSet);
					const newTagsLine = `${indent}tags: [${combinedTags.map(t => `"${t}"`).join(', ')}]`;

					if (tagsLineIndex >= 0) {
						lines.splice(tagsLineIndex, Math.max(replaceCount, 1), newTagsLine);
					} else {
						lines.unshift(newTagsLine);
					}

					const newFrontmatter = lines.join('\n');
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

	private normalizeTagValue(tag: string): string {
		let value = tag.trim();
		if (value.startsWith('#')) {
			value = value.substring(1);
		}
		return value;
	}

	private parseTagsBlock(lines: string[], startIndex: number) {
		const result = {
			tags: [] as string[],
			indent: '',
			endIndex: startIndex + 1
		};

		const line = lines[startIndex];
		const indentMatch = line.match(/^(\s*)/);
		result.indent = indentMatch ? indentMatch[1] : '';

		const trimmed = line.trim();
		const afterColon = trimmed.replace(/^tags:\s*/i, '');

		const cleanTagValue = (value: string) => value.trim().replace(/^["'#]+|["'#]+$/g, '');

		if (afterColon.startsWith('[')) {
			const closeBracket = afterColon.lastIndexOf(']');
			if (closeBracket > 0) {
				const inside = afterColon.substring(afterColon.indexOf('[') + 1, closeBracket);
				result.tags.push(
					...inside
						.split(',')
						.map(v => cleanTagValue(v))
						.filter(v => v.length > 0)
				);
			}
			return result;
		}

		if (afterColon) {
			result.tags.push(
				...afterColon
					.split(',')
					.map(v => cleanTagValue(v))
					.filter(v => v.length > 0)
			);
			return result;
		}

		let idx = startIndex + 1;
		while (idx < lines.length) {
			const nextLine = lines[idx];
			if (!nextLine.trim()) {
				idx++;
				continue;
			}
			const nextIndent = nextLine.length - nextLine.trimStart().length;
			if (nextIndent <= result.indent.length) {
				break;
			}
			const nextTrimmed = nextLine.trim();
			if (nextTrimmed.startsWith('-')) {
				const value = cleanTagValue(nextTrimmed.substring(1));
				if (value) {
					result.tags.push(value);
				}
			}
			idx++;
		}

		result.endIndex = Math.max(idx, startIndex + 1);
		return result;
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

	async processLapseButton(codeEl: HTMLElement, templateName: string, ctx: MarkdownPostProcessorContext) {
		try {
			// Find the template file
			const templatePath = `${this.settings.lapseButtonTemplatesFolder}/${templateName}.md`;
			const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
			
			if (!templateFile || !(templateFile instanceof TFile)) {
				// Template not found - show error
				const errorBtn = document.createElement('button');
				errorBtn.className = 'lapse-button lapse-button-error';
				errorBtn.textContent = `⚠️ Template not found: ${templateName}`;
				errorBtn.title = `Looking for: ${templatePath}`;
				errorBtn.disabled = true;
				codeEl.replaceWith(errorBtn);
				return;
			}

			// Read template to get project info
			let project: string | null = null;
			try {
				const content = await this.app.vault.read(templateFile);
				// Match frontmatter anywhere in the file (not just at start) to handle Templater code
				const frontmatterRegex = /---\n([\s\S]*?)\n---/;
				const match = content.match(frontmatterRegex);
				
				if (match) {
					const frontmatter = match[1];
					const lines = frontmatter.split('\n');
					
					for (const line of lines) {
						if (line.trim().startsWith(this.settings.projectKey + ':')) {
							project = line.split(':').slice(1).join(':').trim(); // Handle colons in project name
							// Remove quotes and wikilink syntax - use simple string replaceAll
							if (project) {
								// Remove wikilinks
								project = project.replace(/\[\[/g, '').replace(/\]\]/g, '');
							// Remove quotes
							project = project.replace(/^["']+|["']+$/g, '');
							project = project.trim();
						}
						break;
						}
					}
				}
			} catch (error) {
				console.error('Error reading template:', error);
			}

			// Get project color if available
			let projectColor: string | null = null;
			if (project) {
				projectColor = await this.getProjectColor(project);
			}

			// Create button
			const button = document.createElement('button');
			button.className = 'lapse-button';
			
			// Build button structure with two lines
			const topLine = document.createElement('div');
			topLine.className = 'lapse-button-name';
			topLine.style.display = 'flex';
			topLine.style.justifyContent = 'flex-start';
			topLine.style.alignItems = 'center';
			topLine.style.gap = '8px';
			topLine.style.minWidth = '0'; // Allow truncation
			
			// Title element (will truncate if needed)
			const titleEl = document.createElement('span');
			titleEl.className = 'lapse-button-title';
			titleEl.textContent = templateName;
			titleEl.style.overflow = 'hidden';
			titleEl.style.textOverflow = 'ellipsis';
			titleEl.style.whiteSpace = 'nowrap';
			titleEl.style.flex = '1';
			titleEl.style.minWidth = '0';
			topLine.appendChild(titleEl);
			
			// Calculate and display duration if enabled
			if (this.settings.showDurationOnNoteButtons) {
				try {
					const duration = await this.getTemplateButtonDuration(templateName, project);
					if (duration > 0) {
				const durationText = this.formatTimeForButton(duration);
				const durationEl = document.createElement('span');
				durationEl.className = 'lapse-button-duration';
				durationEl.textContent = durationText;
				durationEl.style.flexShrink = '0';
				durationEl.style.marginLeft = 'auto';
				topLine.appendChild(durationEl);
					}
				} catch (error) {
					console.error('Error calculating duration:', error);
				}
			}
			button.appendChild(topLine);
			
			if (project) {
				const bottomLine = document.createElement('div');
				bottomLine.className = 'lapse-button-project';
				bottomLine.textContent = project;
				button.appendChild(bottomLine);
			}
			
			// Apply project color to left border and project name pill
			if (projectColor) {
				// Color the left border
				button.style.borderLeftColor = projectColor;
				
				// Style the project name pill with solid color background and contrasting text
				if (project) {
					const bottomLine = button.querySelector('.lapse-button-project') as HTMLElement;
					if (bottomLine) {
						// Set the pill background to the project color
						bottomLine.style.backgroundColor = projectColor;
						
						// Use contrasting text color (white or black depending on brightness)
						const contrastColor = this.getContrastColor(projectColor);
						bottomLine.style.color = contrastColor;
					}
				}
			}
			
			// Handle click - create new note from template
			button.onclick = async () => {
				try {
					// Use Obsidian's templater or just copy the template
					const templateContent = await this.app.vault.read(templateFile);
					
					// Generate a new note name with timestamp
					const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
					const newNoteName = `${templateName} ${timestamp}`;
					
					// Determine where to create the note (same folder as template or root)
					const newNotePath = `${newNoteName}.md`;
					
					// Create the new note
					const newFile = await this.app.vault.create(newNotePath, templateContent);
					
					// Open the new note
					await this.app.workspace.getLeaf(false).openFile(newFile);
				} catch (error) {
					console.error('Error creating note from template:', error);
				}
			};
			
			// Replace the code element with the button
			codeEl.replaceWith(button);
		} catch (error) {
			console.error('Error processing lapse button:', error);
			// Show error button on failure
			const errorBtn = document.createElement('button');
			errorBtn.className = 'lapse-button lapse-button-error';
			errorBtn.textContent = `⚠️ Error: ${templateName}`;
			errorBtn.title = `Error processing button: ${error}`;
			errorBtn.disabled = true;
			codeEl.replaceWith(errorBtn);
		}
	}

	// Helper to get contrasting text color for a background color
	getContrastColor(colorValue: string): string {
		const rgb = this.resolveColorValue(colorValue);
		if (!rgb) {
			return '#ffffff';
		}

		// Calculate luminance using W3C relative luminance formula
		const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;

		// Choose black or white based on luminance
		return luminance > 0.5 ? '#000000' : '#ffffff';
	}

	// Ensure we have a hidden element for resolving CSS colors to RGB
	private ensureColorMeasurementElement(): HTMLElement | null {
		if (this.colorMeasurementEl) {
			return this.colorMeasurementEl;
		}

		if (typeof document === 'undefined') {
			return null;
		}

		const el = document.createElement('div');
		el.style.position = 'fixed';
		el.style.width = '1px';
		el.style.height = '1px';
		el.style.opacity = '0';
		el.style.pointerEvents = 'none';
		el.style.zIndex = '-9999';
		document.body.appendChild(el);
		this.colorMeasurementEl = el;
		return el;
	}

	// Resolve a CSS color string to its RGB components
	private resolveColorValue(colorValue: string): { r: number; g: number; b: number } | null {
		const measurementEl = this.ensureColorMeasurementElement();
		if (!measurementEl) {
			return null;
		}

		if (typeof window === 'undefined') {
			return null;
		}

		measurementEl.style.backgroundColor = colorValue;
		const computedColor = window.getComputedStyle(measurementEl).backgroundColor;
		return this.parseRgbString(computedColor);
	}

	private parseRgbString(rgbString: string): { r: number; g: number; b: number } | null {
		const match = rgbString.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
		if (!match || match.length < 4) {
			return null;
		}

		return {
			r: parseInt(match[1], 10),
			g: parseInt(match[2], 10),
			b: parseInt(match[3], 10),
		};
	}

	// Helper to convert hex color to RGBA with opacity
	hexToRGBA(hexColor: string, opacity: number): string | null {
		// Remove # if present
		const hex = hexColor.replace('#', '');
		
		// Handle both 3-digit and 6-digit hex codes
		let r: number, g: number, b: number;
		
		if (hex.length === 3) {
			r = parseInt(hex[0] + hex[0], 16);
			g = parseInt(hex[1] + hex[1], 16);
			b = parseInt(hex[2] + hex[2], 16);
		} else if (hex.length === 6) {
			r = parseInt(hex.substr(0, 2), 16);
			g = parseInt(hex.substr(2, 2), 16);
			b = parseInt(hex.substr(4, 2), 16);
		} else {
			return null;
		}
		
		return `rgba(${r}, ${g}, ${b}, ${opacity})`;
	}

	async getProjectColor(projectName: string): Promise<string | null> {
		if (!projectName) {
			return null;
		}

		// Try to find the project note by wikilink resolution
		const file = this.app.metadataCache.getFirstLinkpathDest(projectName, '');
		
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
			const lines = frontmatter.split('\n');
			
			// Look for color field (trying common variations)
			const colorKeys = ['color', 'colour', 'lapse-color'];
			
			for (const key of colorKeys) {
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i].trim();
					
					if (line.startsWith(`${key}:`)) {
						let value = line.replace(new RegExp(`^${key}:\\s*`), '').trim();
						
						// Remove quotes if present
						value = value.replace(/^["']+|["']+$/g, '');
						
						// Validate it looks like a color (hex, named color, or CSS variable)
						if (value.match(/^#[0-9A-Fa-f]{3,8}$/) || value.match(/^[a-zA-Z]+$/) || value.match(/^var\(/)) {
							return value;
						}
					}
				}
			}
		} catch (error) {
			console.error('Error reading project color:', error);
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
		// Create container immediately
		const container = el.createDiv({ cls: 'lapse-report-container' });
		
		// Show loading indicator
		const loadingContainer = container.createDiv({ cls: 'lapse-report-loading' });
		const loadingText = loadingContainer.createDiv({ cls: 'lapse-report-loading-text' });
		loadingText.setText('Loading Lapse Report');
		
		const spinnerContainer = loadingContainer.createDiv({ cls: 'lapse-report-loading-spinner' });
		const spinner = spinnerContainer.createEl('span', { cls: 'lapse-spinner-icon' });
		setIcon(spinner, 'loader-2');
		
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
		
		// Clear loading indicator and render actual content
		container.empty();
		
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

	async processActiveTimersCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		// Create container
		const container = el.createDiv({ cls: 'lapse-active-container' });
		
		// Track time displays and intervals for this instance
		const timeDisplays = new Map<string, HTMLElement>();
		const updateIntervals = new Map<string, number>();
		
		// Function to get all active timers
		const getActiveTimers = async (): Promise<Array<{ filePath: string; entry: TimeEntry }>> => {
			const activeTimers: Array<{ filePath: string; entry: TimeEntry }> = [];
			
			// First, always check the current file (important for same-page timers)
			const currentFile = this.app.workspace.getActiveFile();
			if (currentFile) {
				const currentFilePath = currentFile.path;
				// Force load from frontmatter for current file to ensure fresh data
				await this.loadEntriesFromFrontmatter(currentFilePath);
				
				const currentPageData = this.timeData.get(currentFilePath);
				if (currentPageData) {
					currentPageData.entries.forEach(entry => {
						if (entry.startTime && !entry.endTime) {
							activeTimers.push({ filePath: currentFilePath, entry });
						}
					});
				}
			}
			
			// Check other entries already loaded in memory
			this.timeData.forEach((pageData, filePath) => {
				// Skip current file since we already checked it
				if (currentFile && filePath === currentFile.path) {
					return;
				}
				
				pageData.entries.forEach(entry => {
					if (entry.startTime && !entry.endTime) {
						activeTimers.push({ filePath, entry });
					}
				});
			});
			
			// Also check all other markdown files for active timers not yet in memory
			const markdownFiles = this.app.vault.getMarkdownFiles();
			for (const file of markdownFiles) {
				const filePath = file.path;
				
				// Skip excluded folders
				if (this.isFileExcluded(filePath)) {
					continue;
				}
				
				// Skip if already checked (including current file)
				if (this.timeData.has(filePath)) {
					continue;
				}
				
				// Load entries from cache or frontmatter
				const { entries } = await this.getCachedOrLoadEntries(filePath);
				entries.forEach(entry => {
					if (entry.startTime && !entry.endTime) {
						activeTimers.push({ filePath, entry });
					}
				});
			}
			
			// Deduplicate timers by entry ID to avoid rendering duplicates from race conditions
			const uniqueTimers = new Map<string, { filePath: string; entry: TimeEntry }>();
			for (const timer of activeTimers) {
				if (!uniqueTimers.has(timer.entry.id)) {
					uniqueTimers.set(timer.entry.id, timer);
				}
			}

			return Array.from(uniqueTimers.values());
		};
		
		// Function to render active timers (full render)
		const renderActiveTimers = async () => {
			// Clear existing intervals
			updateIntervals.forEach(intervalId => window.clearInterval(intervalId));
			updateIntervals.clear();
			timeDisplays.clear();
			
			container.empty();
			
			// Get all active timers
			const activeTimers = await getActiveTimers();
			
			// If no active timers, show message
			if (activeTimers.length === 0) {
				container.createEl('p', { text: 'No active timers', cls: 'lapse-active-empty' });
				return;
			}
			
			// Render each active timer as a simple row
			for (const { filePath, entry } of activeTimers) {
				const row = container.createDiv({ cls: 'lapse-active-row' });
				
				// Elapsed time
				const elapsed = entry.duration + (entry.isPaused ? 0 : (Date.now() - entry.startTime!));
				const timeText = this.formatTimeAsHHMMSS(elapsed);
				const timeDisplay = row.createDiv({ 
					text: timeText, 
					cls: 'lapse-active-time' 
				});
				timeDisplays.set(entry.id, timeDisplay);
				
				// Label (read-only)
				const labelDisplay = row.createDiv({ 
					text: entry.label, 
					cls: 'lapse-active-label' 
				});
				
				// Action buttons container
				const actionsContainer = row.createDiv({ cls: 'lapse-active-actions' });
				
				// Jump to note button
				const jumpBtn = actionsContainer.createEl('button', {
					cls: 'lapse-active-btn lapse-active-btn-jump',
					attr: { 'aria-label': 'Jump to note' }
				});
				setIcon(jumpBtn, 'arrow-right');
				jumpBtn.onclick = async () => {
					await this.app.workspace.openLinkText(filePath, '', true);
				};
				
				// Stop button
				const stopBtn = actionsContainer.createEl('button', {
					cls: 'lapse-active-btn lapse-active-btn-stop',
					attr: { 'aria-label': 'Stop timer' }
				});
				setIcon(stopBtn, 'square');
				stopBtn.onclick = async (e) => {
					e.stopPropagation();
					
					// Find the entry in timeData and update it
					const pageData = this.timeData.get(filePath);
					if (pageData) {
						const entryInData = pageData.entries.find(e => e.id === entry.id);
						if (entryInData && entryInData.startTime && !entryInData.endTime) {
							// Stop the timer
							const now = Date.now();
							entryInData.endTime = now;
							entryInData.duration += (now - entryInData.startTime);
							
							// Update total time
							pageData.totalTimeTracked = pageData.entries.reduce((sum, e) => sum + e.duration, 0);
							
							// Update frontmatter in the background
							await this.updateFrontmatter(filePath);
							
							// Re-render to update the list
							await renderActiveTimers();
						}
					}
				};
				
				// Update elapsed time every second
				const intervalId = window.setInterval(() => {
					if (entry.startTime && !entry.endTime) {
						const newElapsed = entry.duration + (entry.isPaused ? 0 : (Date.now() - entry.startTime));
						const display = timeDisplays.get(entry.id);
						if (display) {
							display.setText(this.formatTimeAsHHMMSS(newElapsed));
						}
					} else {
						// Timer stopped, clear interval
						window.clearInterval(intervalId);
						updateIntervals.delete(entry.id);
					}
				}, 1000);
				updateIntervals.set(entry.id, intervalId);
			}
		};
		
		// Function to check for new/stopped timers (lightweight check using in-memory data only)
		const checkForTimerChanges = () => {
			// Get current active timers from in-memory timeData only (don't scan files)
			const currentActiveTimers: Array<{ filePath: string; entry: TimeEntry }> = [];
			this.timeData.forEach((pageData, filePath) => {
				pageData.entries.forEach(entry => {
					if (entry.startTime && !entry.endTime) {
						currentActiveTimers.push({ filePath, entry });
					}
				});
			});
			
			const activeEntryIds = new Set(currentActiveTimers.map(({ entry }) => entry.id));
			const displayedEntryIds = new Set(timeDisplays.keys());
			
			// Check if we need a full refresh (new timer or timer stopped)
			const needsFullRefresh = 
				currentActiveTimers.length !== displayedEntryIds.size ||
				![...displayedEntryIds].every(id => activeEntryIds.has(id)) ||
				!currentActiveTimers.every(({ entry }) => displayedEntryIds.has(entry.id));
			
			if (needsFullRefresh) {
				renderActiveTimers();
			}
		};
		
		// Initial render
		await renderActiveTimers();
		
		// Check for timer changes every 5 seconds (lightweight in-memory check only)
		const checkInterval = window.setInterval(() => {
			checkForTimerChanges();
		}, 5000);
		
		// Full refresh every 30 seconds to catch new timers from other sources
		const refreshInterval = window.setInterval(async () => {
			await renderActiveTimers();
		}, 30000);
		
		// Clean up intervals when the element is removed
		ctx.addChild({
			unload: () => {
				window.clearInterval(checkInterval);
				window.clearInterval(refreshInterval);
				updateIntervals.forEach(intervalId => window.clearInterval(intervalId));
			}
		} as any);
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
					if (['project', 'date', 'tag', 'note'].includes(value.toLowerCase())) {
						query.groupBy = value.toLowerCase() as 'project' | 'date' | 'tag' | 'note';
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

	/**
	 * Get the default note name (without timestamp) for a given file path
	 */
	getDefaultNoteName(filePath: string): string {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file && file instanceof TFile) {
			return this.removeTimestampFromFileName(file.basename);
		}
		const fileName = filePath.split('/').pop()?.replace('.md', '') || filePath;
		return this.removeTimestampFromFileName(fileName);
	}

	/**
	 * Get date range for a time period
	 */
	getDateRangeForPeriod(period: 'today' | 'thisWeek' | 'thisMonth' | 'lastWeek' | 'lastMonth'): { startTime: number; endTime: number } {
		const now = new Date();
		let startDate: Date;
		let endDate: Date = new Date(now);
		endDate.setHours(23, 59, 59, 999);

		if (period === 'today') {
			startDate = new Date(now);
			startDate.setHours(0, 0, 0, 0);
		} else if (period === 'thisWeek') {
			startDate = new Date(now);
			const dayOfWeek = startDate.getDay();
			const daysFromFirstDay = (dayOfWeek - this.settings.firstDayOfWeek + 7) % 7;
			startDate.setDate(startDate.getDate() - daysFromFirstDay);
			startDate.setHours(0, 0, 0, 0);
		} else if (period === 'thisMonth') {
			startDate = new Date(now.getFullYear(), now.getMonth(), 1);
			startDate.setHours(0, 0, 0, 0);
		} else if (period === 'lastWeek') {
			const firstDayOfWeek = this.settings.firstDayOfWeek;
			const today = new Date(now);
			const dayOfWeek = today.getDay();
			const daysFromFirstDay = (dayOfWeek - firstDayOfWeek + 7) % 7;
			startDate = new Date(today);
			startDate.setDate(today.getDate() - daysFromFirstDay - 7);
			startDate.setHours(0, 0, 0, 0);
			endDate = new Date(startDate);
			endDate.setDate(startDate.getDate() + 6);
			endDate.setHours(23, 59, 59, 999);
		} else { // lastMonth
			const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
			startDate = new Date(lastMonth);
			startDate.setHours(0, 0, 0, 0);
			endDate = new Date(now.getFullYear(), now.getMonth(), 0);
			endDate.setHours(23, 59, 59, 999);
		}

		return { startTime: startDate.getTime(), endTime: endDate.getTime() };
	}

	/**
	 * Calculate duration for a template button based on settings
	 * Always aggregates across multiple notes based on the duration type
	 */
	async getTemplateButtonDuration(templateName: string, templateProject: string | null): Promise<number> {
		if (!this.settings.showDurationOnNoteButtons) {
			return 0;
		}

		// Get the time period for the calculation
		const { startTime, endTime } = this.getDateRangeForPeriod(this.settings.noteButtonTimePeriod);
		
		let totalDuration = 0;
		const markdownFiles = this.app.vault.getMarkdownFiles();
		
		if (this.settings.noteButtonDurationType === 'project') {
			// Aggregate by project: include all notes with the same project
			if (!templateProject) {
				return 0; // No project, so no aggregate to show
			}
			
			for (const file of markdownFiles) {
				const currentFilePath = file.path;
				
				// Skip excluded folders
				if (this.isFileExcluded(currentFilePath)) {
					continue;
				}
				
				// Get project for this file
				const currentProject = await this.getProjectFromFrontmatter(currentFilePath);
				
				// Only include notes with the same project (and that have lapse frontmatter)
				if (currentProject === templateProject) {
					const { entries } = await this.getCachedOrLoadEntries(currentFilePath);
					// Only count if the file has lapse entries (has frontmatter with lapse data)
					if (entries.length > 0) {
						for (const entry of entries) {
							if (entry.startTime) {
								// Count entries that overlap with the time period
								const entryStart = entry.startTime;
								const entryEnd = entry.endTime || Date.now();
								
								// Entry overlaps if it starts before period ends and ends after period starts
								if (entryStart <= endTime && entryEnd >= startTime) {
									// Calculate the portion of duration within the period
									const periodStart = Math.max(entryStart, startTime);
									const periodEnd = Math.min(entryEnd, endTime);
									
									if (entry.endTime) {
										// Completed entry: use stored duration, but only count the portion within period
										// entry.duration is the actual tracked duration (may include pauses)
										const entryTotalDuration = entryEnd - entryStart;
										if (entryTotalDuration > 0) {
											// Calculate what portion of the entry's time span is within the period
											const periodDuration = periodEnd - periodStart;
											// Scale the stored duration proportionally
											const scaledDuration = entry.duration * (periodDuration / entryTotalDuration);
											totalDuration += scaledDuration;
										}
									} else {
										// Active entry: use actual time within period
										totalDuration += (periodEnd - periodStart);
									}
								}
							}
						}
					}
				}
			}
		} else {
			// Aggregate by note: include all notes that share the same base filename (template name, ignoring timestamp)
			for (const file of markdownFiles) {
				const currentFilePath = file.path;
				
				// Skip excluded folders
				if (this.isFileExcluded(currentFilePath)) {
					continue;
				}
				
				// Get base name (without timestamp) for this file
				const currentBaseName = this.getDefaultNoteName(currentFilePath);
				
				// Include all notes with the same base name as the template (ignoring timestamp)
				if (currentBaseName === templateName) {
					const { entries } = await this.getCachedOrLoadEntries(currentFilePath);
					for (const entry of entries) {
						if (entry.startTime) {
							// Count entries that overlap with the time period
							const entryStart = entry.startTime;
							const entryEnd = entry.endTime || Date.now();
							
							// Entry overlaps if it starts before period ends and ends after period starts
							if (entryStart <= endTime && entryEnd >= startTime) {
								// Calculate the portion of duration within the period
								const periodStart = Math.max(entryStart, startTime);
								const periodEnd = Math.min(entryEnd, endTime);
								
								if (entry.endTime) {
									// Completed entry: use stored duration, but only count the portion within period
									// entry.duration is the actual tracked duration (may include pauses)
									const entryTotalDuration = entryEnd - entryStart;
									if (entryTotalDuration > 0) {
										// Calculate what portion of the entry's time span is within the period
										const periodDuration = periodEnd - periodStart;
										// Scale the stored duration proportionally
										const scaledDuration = entry.duration * (periodDuration / entryTotalDuration);
										totalDuration += scaledDuration;
									}
								} else {
									// Active entry: use actual time within period
									totalDuration += (periodEnd - periodStart);
								}
							}
						}
					}
				}
			}
		}
		
		return totalDuration;
	}

	/**
	 * Calculate duration for a note based on settings
	 * Always aggregates across multiple notes based on the duration type
	 */
	async getNoteButtonDuration(filePath: string): Promise<number> {
		if (!this.settings.showDurationOnNoteButtons) {
			return 0;
		}

		// Get the time period for the calculation
		const { startTime, endTime } = this.getDateRangeForPeriod(this.settings.noteButtonTimePeriod);
		
		let totalDuration = 0;
		const markdownFiles = this.app.vault.getMarkdownFiles();
		
		if (this.settings.noteButtonDurationType === 'project') {
			// Aggregate by project: include all notes with the same project (that have lapse frontmatter)
			const project = await this.getProjectFromFrontmatter(filePath);
			if (!project) {
				return 0; // No project, so no aggregate to show
			}
			
			for (const file of markdownFiles) {
				const currentFilePath = file.path;
				
				// Skip excluded folders
				if (this.isFileExcluded(currentFilePath)) {
					continue;
				}
				
				// Get project for this file
				const currentProject = await this.getProjectFromFrontmatter(currentFilePath);
				
				// Only include notes with the same project (and that have lapse frontmatter)
				if (currentProject === project) {
					const { entries } = await this.getCachedOrLoadEntries(currentFilePath);
					// Only count if the file has lapse entries (has frontmatter with lapse data)
					if (entries.length > 0) {
						for (const entry of entries) {
							if (entry.startTime) {
								// Count entries that overlap with the time period
								const entryStart = entry.startTime;
								const entryEnd = entry.endTime || Date.now();
								
								// Entry overlaps if it starts before period ends and ends after period starts
								if (entryStart <= endTime && entryEnd >= startTime) {
									// Calculate the portion of duration within the period
									const periodStart = Math.max(entryStart, startTime);
									const periodEnd = Math.min(entryEnd, endTime);
									
									if (entry.endTime) {
										// Completed entry: use stored duration, but only count the portion within period
										// entry.duration is the actual tracked duration (may include pauses)
										const entryTotalDuration = entryEnd - entryStart;
										if (entryTotalDuration > 0) {
											// Calculate what portion of the entry's time span is within the period
											const periodDuration = periodEnd - periodStart;
											// Scale the stored duration proportionally
											const scaledDuration = entry.duration * (periodDuration / entryTotalDuration);
											totalDuration += scaledDuration;
										}
									} else {
										// Active entry: use actual time within period
										totalDuration += (periodEnd - periodStart);
									}
								}
							}
						}
					}
				}
			}
		} else {
			// Aggregate by note: include all notes that share the same base filename (without timestamp)
			const baseNoteName = this.getDefaultNoteName(filePath);
			
			for (const file of markdownFiles) {
				const currentFilePath = file.path;
				
				// Skip excluded folders
				if (this.isFileExcluded(currentFilePath)) {
					continue;
				}
				
				// Get base name (without timestamp) for this file
				const currentBaseName = this.getDefaultNoteName(currentFilePath);
				
				// Include all notes with the same base name (ignoring timestamp)
				if (currentBaseName === baseNoteName) {
					const { entries } = await this.getCachedOrLoadEntries(currentFilePath);
					for (const entry of entries) {
						if (entry.startTime) {
							// Count entries that overlap with the time period
							const entryStart = entry.startTime;
							const entryEnd = entry.endTime || Date.now();
							
							// Entry overlaps if it starts before period ends and ends after period starts
							if (entryStart <= endTime && entryEnd >= startTime) {
								// Calculate the portion of duration within the period
								const periodStart = Math.max(entryStart, startTime);
								const periodEnd = Math.min(entryEnd, endTime);
								
								if (entry.endTime) {
									// Completed entry: use stored duration, but only count the portion within period
									// entry.duration is the actual tracked duration (may include pauses)
									const entryTotalDuration = entryEnd - entryStart;
									if (entryTotalDuration > 0) {
										// Calculate what portion of the entry's time span is within the period
										const periodDuration = periodEnd - periodStart;
										// Scale the stored duration proportionally
										const scaledDuration = entry.duration * (periodDuration / entryTotalDuration);
										totalDuration += scaledDuration;
									}
								} else {
									// Active entry: use actual time within period
									totalDuration += (periodEnd - periodStart);
								}
							}
						}
					}
				}
			}
		}
		
		return totalDuration;
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
	}>, groupBy: 'project' | 'date' | 'tag' | 'note'): Map<string, {
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
			} else if (groupBy === 'note') {
				groupKey = item.noteName || 'Unknown Note';
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
		
		const groupBy = query.groupBy || 'project';
		for (const [groupName, group] of sortedGroups) {
			const groupDiv = breakdownDiv.createDiv({ cls: 'lapse-report-breakdown-item' });
			const nameSpan = groupDiv.createEl('span', { text: groupName, cls: 'lapse-report-breakdown-name' });
			// Color the group name if grouping by project
			if (groupBy === 'project') {
				const projectColor = await this.getProjectColor(groupName);
				if (projectColor) {
					nameSpan.style.color = projectColor;
				}
			}
			groupDiv.createEl('span', { text: this.formatTimeAsHHMMSS(group.totalTime), cls: 'lapse-report-breakdown-time' });
		}
		
		// Render chart if specified
		if (query.chart && query.chart !== 'none' && sortedGroups.length > 0) {
			const chartContainer = container.createDiv({ cls: 'lapse-report-chart-container' });
			const chartData = sortedGroups.map(([group, data]) => ({
				group,
				totalTime: data.totalTime
			}));
			await this.renderReportChart(chartContainer, chartData, totalTime, query.chart, query.groupBy);
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
		const groupBy = query.groupBy || 'project';
		
		// When grouping by note, show individual entries with more columns
		if (groupBy === 'note') {
			headerRow.createEl('th', { text: 'Note' });
			headerRow.createEl('th', { text: 'Label' });
			headerRow.createEl('th', { text: 'Time' });
		} else {
			headerRow.createEl('th', { text: this.getGroupByLabel(groupBy) });
			headerRow.createEl('th', { text: 'Entries' });
			headerRow.createEl('th', { text: 'Time' });
		}
		
		const tbody = table.createEl('tbody');
		
		// Sort groups by time descending
		const sortedGroups = Array.from(groupedData.entries()).sort((a, b) => b[1].totalTime - a[1].totalTime);
		
		if (groupBy === 'note') {
			// Show individual entries for each note
			for (const [groupName, group] of sortedGroups) {
				// Sort entries by start time (newest first)
				const sortedEntries = [...group.entries].sort((a, b) => (b.entry.startTime || 0) - (a.entry.startTime || 0));
				
				for (const entryItem of sortedEntries) {
					const row = tbody.createEl('tr');
					row.createEl('td', { text: groupName });
					row.createEl('td', { text: entryItem.entry.label });
					
					const entryDuration = entryItem.entry.endTime 
						? entryItem.entry.duration 
						: entryItem.entry.duration + (Date.now() - (entryItem.entry.startTime || 0));
					row.createEl('td', { text: this.formatTimeAsHHMMSS(entryDuration) });
				}
			}
		} else {
			// Show grouped summary
			for (const [groupName, group] of sortedGroups) {
				const row = tbody.createEl('tr');
				const groupCell = row.createEl('td');
				// Color the group name if grouping by project
				if (groupBy === 'project') {
					const projectColor = await this.getProjectColor(groupName);
					const groupSpan = groupCell.createSpan({ text: groupName });
					if (projectColor) {
						groupSpan.style.color = projectColor;
					}
				} else {
					groupCell.setText(groupName);
				}
				row.createEl('td', { text: group.entryCount.toString() });
				row.createEl('td', { text: this.formatTimeAsHHMMSS(group.totalTime) });
			}
		}
		
		// Render chart if specified
		if (query.chart && query.chart !== 'none' && sortedGroups.length > 0) {
			const chartContainer = container.createDiv({ cls: 'lapse-report-chart-container' });
			const chartData = sortedGroups.map(([group, data]) => ({
				group,
				totalTime: data.totalTime
			}));
			await this.renderReportChart(chartContainer, chartData, totalTime, query.chart, query.groupBy);
		}
	}

	getGroupByLabel(groupBy: string): string {
		switch (groupBy) {
			case 'project': return 'Project';
			case 'date': return 'Date';
			case 'tag': return 'Tag';
			case 'note': return 'Note';
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
			await this.renderReportChart(chartContainer, chartData, totalTime, query.chart, query.groupBy);
		} else {
			// If no chart specified or 'none', show a message
			container.createEl('p', { 
				text: 'Please specify a chart type (chart: pie or chart: bar)', 
				cls: 'lapse-report-error' 
			});
		}
	}

	async renderReportChart(container: HTMLElement, data: Array<{ group: string; totalTime: number }>, totalTime: number, chartType: 'bar' | 'pie', groupBy?: string) {
		if (chartType === 'pie') {
			await this.renderPieChart(container, data, totalTime, groupBy);
		} else {
			await this.renderBarChart(container, data, totalTime, groupBy);
		}
	}

	async renderPieChart(container: HTMLElement, data: Array<{ group: string; totalTime: number }>, totalTime: number, groupBy?: string) {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'lapse-report-pie-chart');
		svg.setAttribute('width', '300');
		svg.setAttribute('height', '300');
		svg.setAttribute('viewBox', '0 0 300 300');
		container.appendChild(svg);

		const defaultColors = [
			'#4A90E2', '#50C878', '#FF6B6B', '#FFD93D', 
			'#9B59B6', '#E67E22', '#1ABC9C', '#E74C3C'
		];

		// Fetch project colors if grouping by project
		const isGroupingByProject = groupBy === 'project';
		const dataWithColors = await Promise.all(data.map(async ({ group, totalTime: time }, index) => {
			let color = defaultColors[index % defaultColors.length];
			if (isGroupingByProject) {
				const projectColor = await this.getProjectColor(group);
				if (projectColor) {
					color = projectColor;
				}
			}
			return { group, totalTime: time, color };
		}));

		const centerX = 150;
		const centerY = 150;
		const radius = 100;
		let currentAngle = -Math.PI / 2; // Start at top

		dataWithColors.forEach(({ group, totalTime: time, color }) => {
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
			path.setAttribute('fill', color);
			path.setAttribute('stroke', 'var(--background-primary)');
			path.setAttribute('stroke-width', '2');
			svg.appendChild(path);

			currentAngle += angle;
		});

		// Add legend
		const legend = container.createDiv({ cls: 'lapse-report-legend' });
		dataWithColors.forEach(({ group, totalTime: time, color }) => {
			const legendItem = legend.createDiv({ cls: 'lapse-report-legend-item' });
			const colorBox = legendItem.createDiv({ cls: 'lapse-report-legend-color' });
			colorBox.style.backgroundColor = color;
			const label = legendItem.createDiv({ cls: 'lapse-report-legend-label' });
			const nameSpan = label.createSpan({ text: group });
			// Color the project name if grouping by project
			if (isGroupingByProject) {
				nameSpan.style.color = color;
			}
			label.createSpan({ text: this.formatTimeAsHHMMSS(time), cls: 'lapse-report-legend-time' });
		});
	}

	async renderBarChart(container: HTMLElement, data: Array<{ group: string; totalTime: number }>, totalTime: number, groupBy?: string) {
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

		const defaultColors = [
			'#4A90E2', '#50C878', '#FF6B6B', '#FFD93D', 
			'#9B59B6', '#E67E22', '#1ABC9C', '#E74C3C'
		];

		// Fetch project colors if grouping by project
		const isGroupingByProject = groupBy === 'project';
		const dataWithColors = await Promise.all(data.map(async (item, index) => {
			let color = defaultColors[index % defaultColors.length];
			if (isGroupingByProject) {
				const projectColor = await this.getProjectColor(item.group);
				if (projectColor) {
					color = projectColor;
				}
			}
			return { ...item, color };
		}));

		const maxTime = Math.max(...dataWithColors.map(d => d.totalTime));
		const barCount = dataWithColors.length;
		const barWidth = chartAreaWidth / barCount;
		const maxBarHeight = chartHeight - padding * 2;

		dataWithColors.forEach((item, index) => {
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
			rect.setAttribute('fill', item.color);
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
			// Color the label with project color if grouping by project
			labelDiv.style.color = isGroupingByProject ? item.color : 'var(--text-muted)';
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

	formatTimeForButton(milliseconds: number): string {
		const totalSeconds = Math.floor(milliseconds / 1000);
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;
		
		// Hide hours if 00, otherwise show HH:MM:SS
		if (hours > 0) {
			return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
		} else {
			return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
		}
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

	formatTimestampForFrontmatter(timestamp: number | null | undefined): string | null {
		if (timestamp === null || timestamp === undefined) {
			return null;
		}
		return this.formatForDatetimeLocal(timestamp);
	}

	formatForDatetimeLocal(timestamp: number | null | undefined): string {
		if (timestamp === null || timestamp === undefined) {
			return '';
		}
		const date = new Date(timestamp);
		const pad = (value: number) => value.toString().padStart(2, '0');
		const year = date.getFullYear();
		const month = pad(date.getMonth() + 1);
		const day = pad(date.getDate());
		const hours = pad(date.getHours());
		const minutes = pad(date.getMinutes());
		const seconds = pad(date.getSeconds());
		return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
	}

	parseDatetimeLocal(value: string): number | null {
		if (!value) {
			return null;
		}
		const normalized = value.trim();
		const match = normalized.match(
			/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/
		);
		if (!match) {
			const fallback = new Date(normalized).getTime();
			return Number.isNaN(fallback) ? null : fallback;
		}
		const year = parseInt(match[1], 10);
		const month = parseInt(match[2], 10) - 1;
		const day = parseInt(match[3], 10);
		const hour = parseInt(match[4], 10);
		const minute = parseInt(match[5], 10);
		const second = match[6] ? parseInt(match[6], 10) : 0;
		return new Date(year, month, day, hour, minute, second).getTime();
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
			start: this.formatTimestampForFrontmatter(entry.startTime),
			end: this.formatTimestampForFrontmatter(entry.endTime),
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
		
		const formattedStartTime = this.formatTimestampForFrontmatter(startTime);
		const formattedEndTime = this.formatTimestampForFrontmatter(endTime);
		if (formattedStartTime) {
			lapseFrontmatter += `${startTimeKey}: ${formattedStartTime}\n`;
		}
		if (formattedEndTime) {
			lapseFrontmatter += `${endTimeKey}: ${formattedEndTime}\n`;
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
				const lineIndent = line.length - line.trimStart().length;

				// Check if entering lapse entries array
				if (trimmed.startsWith(`${entriesKey}:`)) {
					inLapseArray = true;
					return false;
				}

				// Skip lines inside lapse entries array
				if (inLapseArray) {
					if (trimmed === '') {
						return false;
					}
					if (lineIndent > 0) {
						return false;
					}
					inLapseArray = false;
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

	async activateButtonsView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType('lapse-buttons');

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: 'lapse-buttons', active: true });
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async activateGridView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType('lapse-grid');

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: 'lapse-grid', active: true });
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
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		
		// Don't load the large cache on startup - use on-demand loading instead
		// This allows plugin to load instantly
		console.log('Lapse: Settings loaded (cache will load on-demand)');
	}

	async saveSettings() {
		// Only save settings, not the cache
		await this.saveData(this.settings);
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
					// Save cache separately from settings
					const data = await this.loadData();
					await this.saveData({
						...data,
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
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!file || !(file instanceof TFile)) {
			return { entries: [], project: null, totalTime: 0 };
		}

		// Use Obsidian's metadata cache to get file modification time instantly
		const fileCache = this.app.metadataCache.getFileCache(file);
		const currentMtime = file.stat.mtime;
		const cached = this.entryCache[filePath];

		// Check if cache is valid using mtime (instant check, no disk I/O)
		if (cached && cached.lastModified === currentMtime) {
			// Cache hit - return cached data instantly
			return {
				entries: cached.entries,
				project: cached.project,
				totalTime: cached.totalTime
			};
		}

		// Cache miss or stale - load from frontmatter (only when needed)
		await this.loadEntriesFromFrontmatter(filePath);
		const pageData = this.timeData.get(filePath);
		const project = await this.getProjectFromFrontmatter(filePath);
		
		const entries = pageData ? pageData.entries : [];
		const totalTime = pageData ? pageData.totalTimeTracked : 0;

		// Update in-memory cache
		this.entryCache[filePath] = {
			lastModified: currentMtime,
			entries: entries,
			project: project,
			totalTime: totalTime
		};

		// Debounced save to disk (non-blocking)
		this.saveCache();

		return { entries, project, totalTime };
	}

	async getTrackedNotesWithEntries(): Promise<NoteEntryGroup[]> {
		const results: NoteEntryGroup[] = [];
		const markdownFiles = this.app.vault.getMarkdownFiles();

		for (const file of markdownFiles) {
			const filePath = file.path;
			if (this.isFileExcluded(filePath)) {
				continue;
			}

			const { entries } = await this.getCachedOrLoadEntries(filePath);
			if (entries.length > 0) {
				results.push({ file, entries });
			}
		}

		results.sort((a, b) => a.file.path.localeCompare(b.file.path));
		return results;
	}

	async getTemplateDataList(): Promise<TemplateData[]> {
		const templateFolder = this.settings.lapseButtonTemplatesFolder;
		if (!templateFolder) {
			return [];
		}

		const normalizedFolder = templateFolder.endsWith('/') ? templateFolder : `${templateFolder}/`;
		const files = this.app.vault.getMarkdownFiles();
		const templates = files.filter(file => file.path.startsWith(normalizedFolder));

		const templateDataList: TemplateData[] = [];

		for (const template of templates) {
			let project: string | null = null;
			let projectColor: string | null = null;

			try {
				const content = await this.app.vault.read(template);
				const frontmatterRegex = /---\n([\s\S]*?)\n---/;
				const match = content.match(frontmatterRegex);

				if (match) {
					const frontmatter = match[1];
					const lines = frontmatter.split('\n');

					for (const line of lines) {
						if (line.trim().startsWith(`${this.settings.projectKey}:`)) {
							project = line.split(':').slice(1).join(':').trim();
							if (project) {
								project = project.replace(/\[\[/g, '').replace(/\]\]/g, '');
								project = project.replace(/^["']+|["']+$/g, '');
								project = project.trim();
							}
							break;
						}
					}
				}

				if (project) {
					projectColor = await this.getProjectColor(project);
				}
			} catch (error) {
				console.error('Error reading template for Quick Start:', error);
			}

			templateDataList.push({
				template,
				templateName: template.basename,
				project,
				projectColor
			});
		}

		templateDataList.sort((a, b) => a.templateName.localeCompare(b.templateName));
		return templateDataList;
	}

	groupTemplateData(templateDataList: TemplateData[]): TemplateGroupResult {
		const grouped = new Map<string, TemplateData[]>();

		for (const data of templateDataList) {
			const projectKey = data.project || 'No Project';
			if (!grouped.has(projectKey)) {
				grouped.set(projectKey, []);
			}
			grouped.get(projectKey)!.push(data);
		}

		const sortedProjects = Array.from(grouped.keys()).sort((a, b) => {
			if (a === 'No Project') return 1;
			if (b === 'No Project') return -1;
			return a.localeCompare(b);
		});

		return { grouped, sortedProjects };
	}
}

async function appendQuickStartButton(container: HTMLElement, plugin: LapsePlugin, data: TemplateData, onNoteCreated?: () => void) {
	const button = container.createEl('button', { cls: 'lapse-button' }) as HTMLElement;
	button.setAttribute('type', 'button');
	
	// Build button structure with two lines
	const topLine = button.createDiv({ cls: 'lapse-button-name' }) as HTMLElement;
	topLine.style.display = 'flex';
	topLine.style.justifyContent = 'flex-start';
	topLine.style.alignItems = 'center';
	topLine.style.gap = '8px';
	topLine.style.minWidth = '0';
	
	const titleEl = topLine.createSpan({ cls: 'lapse-button-title' });
	titleEl.textContent = data.templateName;
	titleEl.style.overflow = 'hidden';
	titleEl.style.textOverflow = 'ellipsis';
	titleEl.style.whiteSpace = 'nowrap';
	titleEl.style.flex = '1';
	titleEl.style.minWidth = '0';
	titleEl.style.textAlign = 'left';
	
	if (plugin.settings.showDurationOnNoteButtons) {
		try {
			const duration = await plugin.getTemplateButtonDuration(data.templateName, data.project);
			if (duration > 0) {
				const durationText = plugin.formatTimeForButton(duration);
				const durationEl = topLine.createSpan({ cls: 'lapse-button-duration' });
				durationEl.textContent = durationText;
				durationEl.style.flexShrink = '0';
				durationEl.style.marginLeft = 'auto';
			}
		} catch (error) {
			console.error('Error calculating duration for Quick Start button:', error);
		}
	}

	if (data.project) {
		const projectEl = button.createDiv({ cls: 'lapse-button-project' });
		projectEl.textContent = data.project;
		
		if (data.projectColor) {
			button.style.borderLeftColor = data.projectColor;
			projectEl.style.backgroundColor = data.projectColor;
			projectEl.style.color = plugin.getContrastColor(data.projectColor);
		}
	}

	button.onclick = async () => {
		try {
			const templateContent = await plugin.app.vault.read(data.template);
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
			const newNoteName = `${data.templateName} ${timestamp}`;
			const newNotePath = `${newNoteName}.md`;

			const newFile = await plugin.app.vault.create(newNotePath, templateContent);
			await plugin.app.workspace.getLeaf(false).openFile(newFile);
			if (onNoteCreated) {
				onNoteCreated();
			}
		} catch (error) {
			console.error('Error creating note from template:', error);
		}
	};
}

async function renderTemplateGroups(container: HTMLElement, plugin: LapsePlugin, groupResult: TemplateGroupResult, onNoteCreated?: () => void) {
	for (const projectKey of groupResult.sortedProjects) {
		const projectTemplates = groupResult.grouped.get(projectKey)!;
		const projectSection = container.createDiv({ cls: 'lapse-buttons-project-section' });
		const projectHeader = projectSection.createDiv({ cls: 'lapse-buttons-project-header' });
	const title = projectHeader.createEl('h3', { text: projectKey, cls: 'lapse-buttons-project-title' }) as HTMLElement;
		
		if (projectKey !== 'No Project') {
			const projectColor = projectTemplates[0].projectColor;
			if (projectColor) {
				projectHeader.style.borderLeftColor = projectColor;
				title.style.color = projectColor;
			}
		}
		
		const buttonsGrid = projectSection.createDiv({ cls: 'lapse-buttons-grid' });
		for (const data of projectTemplates) {
			await appendQuickStartButton(buttonsGrid, plugin, data, onNoteCreated);
		}
	}
}

class LapseSidebarView extends ItemView {
	plugin: LapsePlugin;
	refreshInterval: number | null = null;
	timeDisplays: Map<string, HTMLElement> = new Map(); // Map of entry ID to time display element
	showTodayEntries: boolean = true; // Toggle for showing/hiding individual entries
	refreshCounter: number = 0; // Counter for periodic full refreshes
	showEntriesList: boolean = true; // Toggle for showing/hiding the entries list section
	showChart: boolean = true; // Toggle for showing/hiding the chart section

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
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		this.timeDisplays.clear();
		
		// Header with title and toggle buttons
		const header = container.createDiv({ cls: 'lapse-sidebar-header' });
		header.createEl('h4', { text: 'Activity' });
		
		const headerButtons = header.createDiv({ cls: 'lapse-sidebar-header-buttons' });
		
		// List toggle button
		const listBtn = headerButtons.createEl('button', { 
			cls: `lapse-sidebar-toggle-view-btn clickable-icon ${this.showEntriesList ? 'active' : ''}`,
			attr: { 'aria-label': 'Toggle entries list' }
		});
		setIcon(listBtn, 'list');
		listBtn.onclick = () => {
			this.showEntriesList = !this.showEntriesList;
			this.render();
		};
		
		// Chart toggle button
		const chartBtn = headerButtons.createEl('button', { 
			cls: `lapse-sidebar-toggle-view-btn clickable-icon ${this.showChart ? 'active' : ''}`,
			attr: { 'aria-label': 'Toggle chart' }
		});
		setIcon(chartBtn, 'pie-chart');
		chartBtn.onclick = () => {
			this.showChart = !this.showChart;
			this.render();
		};
		
		// Refresh button
		const refreshBtn = headerButtons.createEl('button', { 
			cls: 'lapse-sidebar-refresh-btn clickable-icon',
			attr: { 'aria-label': 'Refresh' }
		});
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.onclick = async () => {
			// Force reload of all entries in view
			this.plugin.timeData.clear();
			await this.render();
		};

		const addBtn = headerButtons.createEl('button', {
			cls: 'lapse-sidebar-add-btn clickable-icon',
			attr: { 'aria-label': 'Start a new timer' }
		});
		setIcon(addBtn, 'plus');
		addBtn.onclick = () => {
			new LapseQuickStartModal(this.app, this.plugin).open();
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
				
				// Timer row with timer and stop button
				const timerRow = card.createDiv({ cls: 'lapse-activity-timer-row' });
				
				// Timer display - big on the left
				const elapsed = entry.duration + (entry.isPaused ? 0 : (Date.now() - entry.startTime!));
				const timeText = this.plugin.formatTimeAsHHMMSS(elapsed);
				const timerDisplay = timerRow.createDiv({ 
					text: timeText, 
					cls: 'lapse-activity-timer' 
				});
				this.timeDisplays.set(entry.id, timerDisplay);
				
				// Stop button on the right
				const stopBtn = timerRow.createEl('button', {
					cls: 'lapse-activity-stop-btn',
					attr: { 'aria-label': 'Stop timer' }
				});
				setIcon(stopBtn, 'square');
				stopBtn.onclick = async (e) => {
					e.stopPropagation();
					
					// Find the entry in timeData and update it
					const pageData = this.plugin.timeData.get(filePath);
					if (pageData) {
						const entryInData = pageData.entries.find(e => e.id === entry.id);
						if (entryInData && entryInData.startTime && !entryInData.endTime) {
							// Stop the timer
							const now = Date.now();
							entryInData.endTime = now;
							entryInData.duration += (now - entryInData.startTime);
							
							// Update total time
							pageData.totalTimeTracked = pageData.entries.reduce((sum, e) => sum + e.duration, 0);
							
							// Update frontmatter in the background
							await this.plugin.updateFrontmatter(filePath);
							
							// Re-render to update the list
							await this.render();
						}
					}
				};
				
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
					const projectColor = await this.plugin.getProjectColor(project);
					const projectEl = detailsContainer.createDiv({ text: project, cls: 'lapse-activity-project' });
					if (projectColor) {
						projectEl.style.color = projectColor;
					}
				}
				
				// Entry label
				detailsContainer.createDiv({ text: entry.label, cls: 'lapse-activity-label' });
			}
		}

		// Get today's entries and group by note (only if entries list is visible)
		if (this.showEntriesList) {
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
		}

		// Add pie chart section at the bottom (only if chart is visible)
		if (this.showChart) {
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const todayStart = today.getTime();
			await this.renderPieChart(container as HTMLElement, todayStart);
		}

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
		
		// Every 30 seconds (30 calls at 1 second interval), do a full refresh to catch metadata changes
		if (this.refreshCounter >= 30) {
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
		
		// Check if we need a full refresh (new timer started or timer stopped)
		const needsFullRefresh = 
			currentActiveTimers.length !== displayedEntryIds.size || 
			![...displayedEntryIds].every(id => activeEntryIds.has(id)) ||
			!currentActiveTimers.every(({ entry }) => displayedEntryIds.has(entry.id));
		
		if (needsFullRefresh) {
			// New timer started or timer stopped - do full refresh
			await this.render();
			return;
		}
		
		// Only update the time displays for existing timers (no full refresh)
		for (const [entryId, timeDisplay] of this.timeDisplays.entries()) {
			// Find the entry in timeData
			let foundEntry: TimeEntry | null = null;
			
			for (const [filePath, pageData] of this.plugin.timeData) {
				for (const entry of pageData.entries) {
					if (entry.id === entryId && entry.startTime && !entry.endTime) {
						foundEntry = entry;
						break;
					}
				}
				if (foundEntry) break;
			}
			
			if (foundEntry && foundEntry.startTime) {
				const elapsed = foundEntry.duration + (foundEntry.isPaused ? 0 : (Date.now() - foundEntry.startTime));
				const timeText = this.plugin.formatTimeAsHHMMSS(elapsed);
				timeDisplay.setText(timeText);
			} else {
				// Entry no longer active, remove from map and trigger full refresh
				this.timeDisplays.delete(entryId);
				await this.render();
				return;
			}
		}
		
		// Also update the pie chart if visible (only if chart is shown)
		if (this.showChart && this.refreshCounter % 5 === 0) {
			// Update pie chart every 5 seconds without full refresh
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const todayStart = today.getTime();
			const chartContainer = this.containerEl.querySelector('.lapse-pie-chart-container');
			if (chartContainer) {
				// Only update if chart exists - don't re-render everything
				// Chart updates are handled internally by the chart library if needed
			}
		}
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

		// Generate colors for projects (use project colors if available)
		const defaultColors = [
			'#4A90E2', '#50C878', '#FF6B6B', '#FFD93D', 
			'#9B59B6', '#E67E22', '#1ABC9C', '#E74C3C',
			'#3498DB', '#2ECC71', '#F39C12', '#16A085'
		];

		// Convert map to array and sort by time (descending)
		const projectData = await Promise.all(
			Array.from(projectTimes.entries())
				.sort((a, b) => b[1] - a[1])
				.map(async ([name, time], index) => {
					const projectColor = await this.plugin.getProjectColor(name);
					return {
						name,
						time,
						color: projectColor || defaultColors[index % defaultColors.length]
					};
				})
		);

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
			nameSpan.style.color = color; // Color the project name
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

class LapseQuickStartModal extends Modal {
	plugin: LapsePlugin;

	constructor(app: App, plugin: LapsePlugin) {
		super(app);
		this.plugin = plugin;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('lapse-quick-start-modal');
		contentEl.createEl('h2', { text: 'Quick Start' });

		try {
			const templateDataList = await this.plugin.getTemplateDataList();
			if (templateDataList.length === 0) {
				contentEl.createEl('p', {
					text: `No templates found in ${this.plugin.settings.lapseButtonTemplatesFolder}`,
					cls: 'mod-warning'
				});
				return;
			}

			const groupResult = this.plugin.groupTemplateData(templateDataList);
			await renderTemplateGroups(contentEl, this.plugin, groupResult, () => this.close());
		} catch (error) {
			console.error('Error rendering Quick Start modal:', error);
			contentEl.createEl('p', { text: 'Unable to load templates', cls: 'mod-warning' });
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

class LapseGridView extends ItemView {
	plugin: LapsePlugin;

	constructor(leaf: WorkspaceLeaf, plugin: LapsePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return 'lapse-grid';
	}

	getDisplayText(): string {
		return 'Entry Grid';
	}

	getIcon(): string {
		return 'table';
	}

	async onOpen() {
		await this.render();
	}

	async render() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('lapse-grid-view');

		const header = container.createDiv({ cls: 'lapse-grid-header' });
		header.createEl('h2', { text: 'Entry Grid' });

		const headerButtons = header.createDiv({ cls: 'lapse-grid-header-buttons' });
		const refreshBtn = headerButtons.createEl('button', {
			cls: 'lapse-grid-refresh-btn clickable-icon',
			attr: { 'aria-label': 'Refresh grid' }
		});
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.onclick = async () => {
			await this.render();
		};

		const groups = await this.plugin.getTrackedNotesWithEntries();
		if (groups.length === 0) {
			container.createEl('p', {
				text: 'No tracked Lapse entries found.',
				cls: 'lapse-grid-empty'
			});
			return;
		}

		for (const { file, entries } of groups) {
			const noteSection = container.createDiv({ cls: 'lapse-grid-note-section' });
			const noteHeader = noteSection.createDiv({ cls: 'lapse-grid-note-header' });
			const title = noteHeader.createEl('a', {
				text: file.basename,
				href: file.path,
				cls: 'internal-link'
			});
			title.onclick = (event) => {
				event.preventDefault();
				this.app.workspace.openLinkText(file.path, '', false);
			};
			noteHeader.createSpan({
				text: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`,
				cls: 'lapse-grid-note-count'
			});

			const table = noteSection.createDiv({ cls: 'lapse-grid-table' });
			const headerRow = table.createDiv({ cls: 'lapse-grid-entry-row lapse-grid-entry-header' });
			['Label', 'Start', 'End', 'Tags'].forEach(text => {
				headerRow.createDiv({ text, cls: 'lapse-grid-entry-cell lapse-grid-entry-cell-header' });
			});

			const sortedEntries = [...entries].sort((a, b) => {
				const aStart = a.startTime ?? 0;
				const bStart = b.startTime ?? 0;
				return bStart - aStart;
			});
			let rowIndex = 0;
			for (const entry of sortedEntries) {
				const row = table.createDiv({ cls: 'lapse-grid-entry-row' });
				row.addClass(rowIndex % 2 === 0 ? 'lapse-grid-row-even' : 'lapse-grid-row-odd');
				rowIndex++;
				const labelCell = row.createDiv({ cls: 'lapse-grid-entry-cell' });
				const labelInput = labelCell.createEl('input', {
					type: 'text',
					value: entry.label,
					cls: 'lapse-grid-input'
				}) as HTMLInputElement;

				const startCell = row.createDiv({ cls: 'lapse-grid-entry-cell' });
				const startInput = startCell.createEl('input', {
					type: 'datetime-local',
					value: this.plugin.formatForDatetimeLocal(entry.startTime),
					cls: 'lapse-grid-input',
					attr: { step: '1' }
				}) as HTMLInputElement;

				const endCell = row.createDiv({ cls: 'lapse-grid-entry-cell' });
				const endInput = endCell.createEl('input', {
					type: 'datetime-local',
					value: this.plugin.formatForDatetimeLocal(entry.endTime),
					cls: 'lapse-grid-input',
					attr: { step: '1' }
				}) as HTMLInputElement;

				const tagsCell = row.createDiv({ cls: 'lapse-grid-entry-cell' });
				const tagsInput = tagsCell.createEl('input', {
					type: 'text',
					value: (entry.tags || []).join(', '),
					cls: 'lapse-grid-input',
					attr: { placeholder: 'tag1, tag2' }
				}) as HTMLInputElement;

				let isSaving = false;
				const commitChanges = async () => {
					if (isSaving) return;
					isSaving = true;
					try {
						entry.label = labelInput.value;
						entry.startTime = this.plugin.parseDatetimeLocal(startInput.value);
						entry.endTime = this.plugin.parseDatetimeLocal(endInput.value);

						if (entry.startTime !== null && entry.endTime !== null) {
							entry.duration = Math.max(0, entry.endTime - entry.startTime);
						}

						const parsedTags = tagsInput.value
							.split(',')
							.map(tag => tag.trim().replace(/^#/, ''))
							.filter(tag => tag.length > 0);
						entry.tags = parsedTags;

						await this.plugin.updateFrontmatter(file.path);
						const pageData = this.plugin.timeData.get(file.path);
						if (pageData) {
							pageData.totalTimeTracked = pageData.entries.reduce((sum, e) => sum + e.duration, 0);
						}
						this.plugin.invalidateCacheForFile(file.path);
					} finally {
						isSaving = false;
					}
				};

				const bindCommit = (input: HTMLInputElement, eventName: 'blur' | 'change') => {
					input.addEventListener(eventName, () => {
						void commitChanges();
					});
					input.addEventListener('keydown', (event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							input.blur();
						}
					});
				};

				bindCommit(labelInput, 'blur');
				bindCommit(tagsInput, 'blur');
				bindCommit(startInput, 'change');
				bindCommit(endInput, 'change');
			}
		}
	}
}

class LapseButtonsView extends ItemView {
	plugin: LapsePlugin;

	constructor(leaf: WorkspaceLeaf, plugin: LapsePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return 'lapse-buttons';
	}

	getDisplayText(): string {
		return 'Quick Start';
	}

	getIcon(): string {
		return 'play-circle';
	}

	async onOpen() {
		await this.render();
	}

	async onClose() {
		// Cleanup if needed
	}

	async render() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('lapse-buttons-view');

		// Header
		const header = container.createDiv({ cls: 'lapse-buttons-header' });
		header.createEl('h2', { text: 'Quick Start' });
		
		// Header buttons container
		const headerButtons = header.createDiv({ cls: 'lapse-buttons-header-buttons' });
		
		// Refresh button
		const refreshBtn = headerButtons.createEl('button', { 
			cls: 'lapse-buttons-refresh-btn clickable-icon',
			attr: { 'aria-label': 'Refresh' }
		});
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.onclick = async () => {
			// Re-render to rebuild buttons (e.g., after adding a new template)
			await this.render();
		};

		// Get pre-built template data
		const templateFolder = this.plugin.settings.lapseButtonTemplatesFolder;
		const templateDataList = await this.plugin.getTemplateDataList();

		if (templateDataList.length === 0) {
			container.createEl('p', { 
				text: `No templates found in ${templateFolder}. Configure your template folder in Lapse settings.`,
				cls: 'lapse-buttons-empty'
			});
			return;
		}

		const groupResult = this.plugin.groupTemplateData(templateDataList);
		await renderTemplateGroups(container, this.plugin, groupResult);
	}
}

class LapseButtonModal extends Modal {
	plugin: LapsePlugin;
	onChoose: (templateName: string) => void;

	constructor(app: App, plugin: LapsePlugin, onChoose: (templateName: string) => void) {
		super(app);
		this.plugin = plugin;
		this.onChoose = onChoose;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		
		contentEl.createEl('h2', { text: 'Select template' });

		// Get all template files from the configured folder
		const templateFolder = this.plugin.settings.lapseButtonTemplatesFolder;
		const files = this.app.vault.getMarkdownFiles();
		const templates = files.filter(file => file.path.startsWith(templateFolder + '/'));

		if (templates.length === 0) {
			contentEl.createEl('p', { 
				text: `No templates found in ${templateFolder}`,
				cls: 'mod-warning'
			});
			return;
		}

		// Create a list of template buttons
		const templateList = contentEl.createDiv({ cls: 'lapse-template-list' });
		
		templates.forEach(template => {
			// Extract template name (remove folder path and .md extension)
			const templateName = template.basename;
			
			const button = templateList.createEl('button', {
				text: templateName,
				cls: 'lapse-template-option'
			});
			
			button.onclick = () => {
				this.onChoose(templateName);
				this.close();
			};
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
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
			.setName('Show duration on note buttons')
			.setDesc('Display task duration on inline lapse buttons (e.g., `lapse:Dishes`)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showDurationOnNoteButtons)
				.onChange(async (value) => {
					this.plugin.settings.showDurationOnNoteButtons = value;
					await this.plugin.saveSettings();
					// Refresh sidebar to update note buttons
					this.app.workspace.getLeavesOfType('lapse-sidebar').forEach(leaf => {
						if (leaf.view instanceof LapseSidebarView) {
							leaf.view.refresh();
						}
					});
				}));

		if (this.plugin.settings.showDurationOnNoteButtons) {
			new Setting(containerEl)
				.setName('Duration type')
				.setDesc('Project: aggregate time from all notes with the same project. Note: aggregate time from all notes with the same base filename (ignoring timestamp).')
				.addDropdown(dropdown => dropdown
					.addOption('project', 'Project')
					.addOption('note', 'Note')
					.setValue(this.plugin.settings.noteButtonDurationType)
					.onChange(async (value) => {
						this.plugin.settings.noteButtonDurationType = value as 'project' | 'note';
						await this.plugin.saveSettings();
						// Refresh sidebar to update note buttons
						this.app.workspace.getLeavesOfType('lapse-sidebar').forEach(leaf => {
							if (leaf.view instanceof LapseSidebarView) {
								leaf.view.refresh();
							}
						});
					}));

			new Setting(containerEl)
				.setName('Time period')
				.setDesc('Select the time period for duration calculation')
				.addDropdown(dropdown => dropdown
					.addOption('today', 'Today')
					.addOption('thisWeek', 'This Week')
					.addOption('thisMonth', 'This Month')
					.addOption('lastWeek', 'Last Week')
					.addOption('lastMonth', 'Last Month')
					.setValue(this.plugin.settings.noteButtonTimePeriod)
					.onChange(async (value) => {
						this.plugin.settings.noteButtonTimePeriod = value as 'today' | 'thisWeek' | 'thisMonth' | 'lastWeek' | 'lastMonth';
						await this.plugin.saveSettings();
						// Refresh sidebar to update note buttons
						this.app.workspace.getLeavesOfType('lapse-sidebar').forEach(leaf => {
							if (leaf.view instanceof LapseSidebarView) {
								leaf.view.refresh();
							}
						});
					}));
		}

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

		containerEl.createEl('h3', { text: 'Lapse Button Templates' });

		new Setting(containerEl)
			.setName('Templates folder')
			.setDesc('Folder path containing templates for lapse-button inline buttons (e.g., Templates/Lapse Buttons). Templates should be in your vault\'s template folder.')
			.addText(text => text
				.setPlaceholder('Templates/Lapse Buttons')
				.setValue(this.plugin.settings.lapseButtonTemplatesFolder)
				.onChange(async (value) => {
					this.plugin.settings.lapseButtonTemplatesFolder = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createDiv({ cls: 'setting-item-description' })
			.createEl('p', { 
				text: 'Create buttons in notes using inline code: `lapse:TemplateName`. The button will create a new note from the template and open it.' 
			});

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

		// Add GitHub issue link at the bottom
		containerEl.createEl('hr', { cls: 'lapse-settings-divider' });
		
		const githubLinkContainer = containerEl.createDiv({ cls: 'lapse-settings-footer' });
		const githubLink = githubLinkContainer.createEl('a', {
			text: 'Report an issue on GitHub',
			href: 'https://github.com/jimmy-little/obsidian-lapse-tracker/issues/new',
			cls: 'lapse-github-link'
		});
		githubLink.setAttr('target', '_blank');
		githubLink.setAttr('rel', 'noopener noreferrer');
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
			
			const projectCell = row.createEl('td');
			if (projects.size > 0) {
				const projectArray = Array.from(projects).filter((p): p is string => p !== null);
				for (let i = 0; i < projectArray.length; i++) {
					const projectName = projectArray[i];
					const projectColor = await this.plugin.getProjectColor(projectName);
					const projectSpan = projectCell.createSpan({ text: projectName });
					if (projectColor) {
						projectSpan.style.color = projectColor;
					}
					if (i < projectArray.length - 1) {
						projectCell.createSpan({ text: ', ' });
					}
				}
			} else {
				projectCell.setText('-');
			}
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
						
						const subProjectCell = subRow.createEl('td');
						if (subProjects.size > 0) {
							const subProjectArray = Array.from(subProjects).filter((p): p is string => p !== null);
							for (let i = 0; i < subProjectArray.length; i++) {
								const projectName = subProjectArray[i];
								const projectColor = await this.plugin.getProjectColor(projectName);
								const projectSpan = subProjectCell.createSpan({ text: projectName });
								if (projectColor) {
									projectSpan.style.color = projectColor;
								}
								if (i < subProjectArray.length - 1) {
									subProjectCell.createSpan({ text: ', ' });
								}
							}
						} else {
							subProjectCell.setText('-');
						}
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
						const entryProjectCell = entryRow.createEl('td');
						if (project) {
							const projectColor = await this.plugin.getProjectColor(project);
							const projectSpan = entryProjectCell.createSpan({ text: project });
							if (projectColor) {
								projectSpan.style.color = projectColor;
							}
						} else {
							entryProjectCell.setText('-');
						}
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
		const defaultColors = [
			'#4A90E2', '#50C878', '#FF6B6B', '#FFD93D', 
			'#9B59B6', '#E67E22', '#1ABC9C', '#E74C3C'
		];

		// Fetch project colors if grouping by project
		const isGroupingByProject = this.groupBy === 'project';
		const dataWithColors = await Promise.all(data.map(async (item, index) => {
			let color = defaultColors[index % defaultColors.length];
			if (isGroupingByProject) {
				const projectColor = await this.plugin.getProjectColor(item.group);
				if (projectColor) {
					color = projectColor;
				}
			}
			return { ...item, color };
		}));

		dataWithColors.forEach((item, index) => {
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
			rect.setAttribute('fill', item.color);
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
			// Color the label with project color if grouping by project
			labelDiv.style.color = isGroupingByProject ? item.color : 'var(--text-muted)';
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
