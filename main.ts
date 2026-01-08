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
	defaultTagOnNote: string;
	defaultTagOnTimeEntries: string;
	timeAdjustMinutes: number;
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
	defaultTagOnNote: '#lapse',
	defaultTagOnTimeEntries: '',
	timeAdjustMinutes: 5
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

interface PageTimeData {
	entries: TimeEntry[];
	totalTimeTracked: number;
}

export default class LapsePlugin extends Plugin {
	settings: LapseSettings;
	timeData: Map<string, PageTimeData> = new Map();

	async onload() {
		await this.loadSettings();

		console.log('Loading Lapse plugin');

		// Register the code block processor
		this.registerMarkdownCodeBlockProcessor('lapse', this.processTimerCodeBlock.bind(this));

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

		// Add ribbon icon to show active timers
		this.addRibbonIcon('clock', 'Lapse: Show Active Timers', () => {
			this.activateView();
		});

		// Add command to insert timer
		this.addCommand({
			id: 'insert-lapse-timer',
			name: 'Insert time tracker',
			editorCallback: (editor) => {
				editor.replaceSelection('```lapse\n\n```');
			}
		});

		// Add command to show active timers sidebar
		this.addCommand({
			id: 'show-lapse-sidebar',
			name: 'Show active timers',
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
					const tagsMatch = frontmatter.match(/tags?:\s*\[?([^\]]+)\]?/);
					if (tagsMatch) {
						const existingTags = tagsMatch[1].split(',').map(t => t.trim().replace(/['"#]/g, ''));
						if (existingTags.includes(tagName)) {
							return; // Tag already exists
						}
					}
					// Add tag to existing tags
					const newContent = content.replace(
						/(tags?:\s*\[?)([^\]]+)(\]?)/,
						(match, prefix, tags, suffix) => {
							const tagList = tags.split(',').map((t: string) => t.trim()).filter((t: string) => t);
							tagList.push(tagName);
							return `${prefix}${tagList.map((t: string) => `"${t}"`).join(', ')}${suffix}`;
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
		
		// Action bar
		const actionBar = container.createDiv({ cls: 'lapse-action-bar' });
		
		// Timer controls container
		const timerContainer = actionBar.createDiv({ cls: 'lapse-timer-container' });
		
		// Timer display
		const timerDisplay = timerContainer.createDiv({ cls: 'lapse-timer-display' });
		timerDisplay.setText('--:--');
		
		// Adjust buttons container (under the timer)
		const adjustButtonsContainer = timerContainer.createDiv({ cls: 'lapse-adjust-buttons' });
		
		// << button (adjust start time backward)
		const adjustBackBtn = adjustButtonsContainer.createEl('button', { cls: 'lapse-btn-adjust' });
		setIcon(adjustBackBtn, 'chevron-left');
		adjustBackBtn.disabled = !activeTimer;
		
		// >> button (adjust start time forward)
		const adjustForwardBtn = adjustButtonsContainer.createEl('button', { cls: 'lapse-btn-adjust' });
		setIcon(adjustForwardBtn, 'chevron-right');
		adjustForwardBtn.disabled = !activeTimer;
		
		// Input container
		const inputContainer = actionBar.createDiv({ cls: 'lapse-input-container' });
		
		// Label display/input - use span when timer is running, input when editable
		let labelDisplay: HTMLElement;
		let labelInput: HTMLInputElement | null = null;
		
		if (activeTimer) {
			// Show as plain text when timer is running - match counter style
			labelDisplay = inputContainer.createEl('div', {
				text: activeTimer.label,
				cls: 'lapse-label-display-running'
			});
		} else {
			// Show as input when editable
			labelInput = inputContainer.createEl('input', {
				type: 'text',
				placeholder: 'Timer label...',
				cls: 'lapse-label-input'
			}) as HTMLInputElement;
			labelDisplay = labelInput;
		}

		// Summary line under input
		const summaryLine = inputContainer.createDiv({ cls: 'lapse-summary' });
		const summaryLeft = summaryLine.createDiv({ cls: 'lapse-summary-left' });
		const summaryRight = summaryLine.createDiv({ cls: 'lapse-summary-right' });
		const todayLabel = summaryRight.createDiv({ cls: 'lapse-today-label' });

		// Buttons container
		const buttonsContainer = actionBar.createDiv({ cls: 'lapse-buttons-container' });
		
		// Play/Stop button
		const playStopBtn = buttonsContainer.createEl('button', { cls: 'lapse-btn-play-stop' });
		if (activeTimer) {
			setIcon(playStopBtn, 'square');
		} else {
			setIcon(playStopBtn, 'play');
		}

		// Chevron button to toggle panel
		const chevronBtn = buttonsContainer.createEl('button', { cls: 'lapse-btn-chevron' });
		setIcon(chevronBtn, 'chevron-down');

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
				timerDisplay.setText(this.formatTimeAsHHMMSS(elapsed));
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
					labelInput = inputContainer.createEl('input', {
						type: 'text',
						placeholder: 'Timer label...',
						cls: 'lapse-label-input'
					}) as HTMLInputElement;
					labelDisplay = labelInput;
				}
				setIcon(playStopBtn, 'play');
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
					labelDisplay = inputContainer.createEl('div', {
						text: label, // Use the resolved label value
						cls: 'lapse-label-display-running'
					});
					labelInput = null;
				} else if (labelDisplay) {
					// Update existing display - replace with new element with correct class
					labelDisplay.remove();
					labelDisplay = inputContainer.createEl('div', {
						text: label, // Use the resolved label value
						cls: 'lapse-label-display-running'
					});
				} else {
					// Create display if it doesn't exist
					labelDisplay = inputContainer.createEl('div', {
						text: label,
						cls: 'lapse-label-display-running'
					});
				}
				setIcon(playStopBtn, 'square');
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

	async updateFrontmatter(filePath: string) {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!file || !(file instanceof TFile)) return;

		const pageData = this.timeData.get(filePath);
		if (!pageData) return;

		const content = await this.app.vault.read(file);
		const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
		const match = content.match(frontmatterRegex);

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

		let newContent: string;

		if (match) {
			// Parse existing frontmatter and update/overwrite our fields
			const existingFrontmatter = match[1];
			const lines = existingFrontmatter.split('\n');

			// Remove existing lapse-related fields using configured keys
			const startTimeKey = this.settings.startTimeKey;
			const endTimeKey = this.settings.endTimeKey;
			const entriesKey = this.settings.entriesKey;
			const totalTimeKey = this.settings.totalTimeKey;
			
			// Track if we're inside the entries array block
			let insideEntries = false;
			const filteredLines: string[] = [];
			
			for (const line of lines) {
				const trimmed = line.trim();
				
				// Check if we're entering entries block
				if (trimmed.startsWith(`${entriesKey}:`)) {
					insideEntries = true;
					continue; // Skip this line
				}
				
				// If we're inside entries, skip array items and their properties
				if (insideEntries) {
					// Check if this line is still part of the array (indented)
					if (line.match(/^\s+/)) {
						continue; // Skip indented lines (array items)
					}
					// If we hit a non-indented line, we've exited the array
					insideEntries = false;
				}
				
				// Skip our top-level fields using configured keys
				if (trimmed.startsWith(`${startTimeKey}:`) ||
				    trimmed.startsWith(`${endTimeKey}:`) ||
				    trimmed.startsWith(`${totalTimeKey}:`)) {
					continue;
				}
				
				// Keep all other lines
				filteredLines.push(line);
			}

			// Add our fields using configured keys
			if (startTime !== null) {
				filteredLines.push(`${startTimeKey}: ${new Date(startTime).toISOString()}`);
			}
			if (endTime !== null) {
				filteredLines.push(`${endTimeKey}: ${new Date(endTime).toISOString()}`);
			}
			
			// Add entries as YAML array using configured key
			if (entries.length > 0) {
				filteredLines.push(`${entriesKey}:`);
				entries.forEach(entry => {
					filteredLines.push(`  - label: "${entry.label.replace(/"/g, '\\"')}"`);
					if (entry.start) {
						filteredLines.push(`    start: ${entry.start}`);
					}
					if (entry.end) {
						filteredLines.push(`    end: ${entry.end}`);
					}
					filteredLines.push(`    duration: ${entry.duration}`);
					if (entry.tags && entry.tags.length > 0) {
						filteredLines.push(`    tags: [${entry.tags.map((t: string) => `"${t}"`).join(', ')}]`);
					}
				});
			} else {
				filteredLines.push(`${entriesKey}: []`);
			}
			
			filteredLines.push(`${totalTimeKey}: "${totalTimeFormatted}"`);

			newContent = content.replace(frontmatterRegex, `---\n${filteredLines.join('\n')}\n---`);
		} else {
			// Create new frontmatter using configured keys
			const startTimeKey = this.settings.startTimeKey;
			const endTimeKey = this.settings.endTimeKey;
			const entriesKey = this.settings.entriesKey;
			const totalTimeKey = this.settings.totalTimeKey;
			
			const frontmatterLines: string[] = [];
			
			if (startTime !== null) {
				frontmatterLines.push(`${startTimeKey}: ${new Date(startTime).toISOString()}`);
			}
			if (endTime !== null) {
				frontmatterLines.push(`${endTimeKey}: ${new Date(endTime).toISOString()}`);
			}
			
			if (entries.length > 0) {
				frontmatterLines.push(`${entriesKey}:`);
				entries.forEach(entry => {
					frontmatterLines.push(`  - label: "${entry.label.replace(/"/g, '\\"')}"`);
					if (entry.start) {
						frontmatterLines.push(`    start: ${entry.start}`);
					}
					if (entry.end) {
						frontmatterLines.push(`    end: ${entry.end}`);
					}
					frontmatterLines.push(`    duration: ${entry.duration}`);
					if (entry.tags && entry.tags.length > 0) {
						frontmatterLines.push(`    tags: [${entry.tags.map(t => `"${t}"`).join(', ')}]`);
					}
				});
			} else {
				frontmatterLines.push(`${entriesKey}: []`);
			}
			
			frontmatterLines.push(`${totalTimeKey}: "${totalTimeFormatted}"`);
			
			const frontmatter = `---\n${frontmatterLines.join('\n')}\n---\n\n`;
			newContent = frontmatter + content;
		}

		await this.app.vault.modify(file, newContent);
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

	onunload() {
		console.log('Unloading Lapse plugin');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class LapseSidebarView extends ItemView {
	plugin: LapsePlugin;
	refreshInterval: number | null = null;
	timeDisplays: Map<string, HTMLElement> = new Map(); // Map of entry ID to time display element

	constructor(leaf: WorkspaceLeaf, plugin: LapsePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return 'lapse-sidebar';
	}

	getDisplayText(): string {
		return 'Active Timers';
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
		
		container.createEl('h4', { text: 'Active Timers' });

		const activeTimers = await this.plugin.getActiveTimers();

		if (activeTimers.length === 0) {
			container.createEl('p', { text: 'No active timers', cls: 'lapse-sidebar-empty' });
		} else {
			const list = container.createEl('ul', { cls: 'lapse-sidebar-list' });

			for (const { filePath, entry } of activeTimers) {
				const item = list.createEl('li', { cls: 'lapse-sidebar-item' });
				
				// Top line container
				const topLine = item.createDiv({ cls: 'lapse-sidebar-top-line' });
				
				// Get file name without extension
				const file = this.app.vault.getAbstractFileByPath(filePath);
				const fileName = file && file instanceof TFile ? file.basename : filePath.split('/').pop()?.replace('.md', '') || filePath;
				
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
				
				// Time tracked on the right - store reference for updates
				const elapsed = entry.duration + (entry.isPaused ? 0 : (Date.now() - entry.startTime!));
				const timeText = this.plugin.formatTimeAsHHMMSS(elapsed);
				const timeDisplay = topLine.createSpan({ text: timeText, cls: 'lapse-sidebar-time' });
				this.timeDisplays.set(entry.id, timeDisplay);
				
				// Get project from frontmatter
				const project = await this.plugin.getProjectFromFrontmatter(filePath);
				
				// Second line: project (if available) and label
				const secondLine = item.createDiv({ cls: 'lapse-sidebar-second-line' });
				if (project) {
					secondLine.createSpan({ text: project, cls: 'lapse-sidebar-project' });
				}
				secondLine.createSpan({ text: entry.label, cls: 'lapse-sidebar-label' });
			}
		}

		// Get today's entries and group by note
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const todayStart = today.getTime();
		
		const todayEntries: Array<{ filePath: string; entry: TimeEntry; startTime: number }> = [];
		
		this.plugin.timeData.forEach((pageData, filePath) => {
			pageData.entries.forEach(entry => {
				if (entry.startTime && entry.startTime >= todayStart && entry.endTime) {
					todayEntries.push({ filePath, entry, startTime: entry.startTime });
				}
			});
		});
		
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
			container.createEl('h4', { text: "Today's Entries", cls: 'lapse-sidebar-section-title' });
			const todayList = container.createEl('ul', { cls: 'lapse-sidebar-list' });
			
			for (const { filePath, entries, totalTime } of noteGroups) {
				const item = todayList.createEl('li', { cls: 'lapse-sidebar-note-group' });
				
				// Top line container - note name and total time
				const topLine = item.createDiv({ cls: 'lapse-sidebar-top-line' });
				
				// Get file name without extension
				const file = this.app.vault.getAbstractFileByPath(filePath);
				const fileName = file && file instanceof TFile ? file.basename : filePath.split('/').pop()?.replace('.md', '') || filePath;
				
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
				
				// List individual entries below
				const entriesList = item.createDiv({ cls: 'lapse-sidebar-entries-list' });
				entries.forEach(({ entry }) => {
					const entryLine = entriesList.createDiv({ cls: 'lapse-sidebar-entry-line' });
					const entryTime = this.plugin.formatTimeAsHHMMSS(entry.duration);
					entryLine.createSpan({ text: entry.label, cls: 'lapse-sidebar-entry-label' });
					entryLine.createSpan({ text: entryTime, cls: 'lapse-sidebar-entry-time' });
				});
			}
		}

		// Add pie chart section at the bottom
		await this.renderPieChart(container as HTMLElement, todayStart);

		// Set up refresh interval - always run to detect new timers
		// Clear any existing interval first
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
		}
		
		// Always set up interval to check for new/stopped timers and update displays
		this.refreshInterval = window.setInterval(() => {
			this.updateTimers().catch(err => console.error('Error updating timers:', err));
		}, 2000);
	}

	async updateTimers() {
		// First, check for new active timers that aren't in the display yet
		const currentActiveTimers = await this.plugin.getActiveTimers();
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
		
		// If no more active timers, re-render to show "No active timers"
		// (But keep the interval running to detect new timers)
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

		// Also check frontmatter for any files with entries that aren't in memory
		const markdownFiles = this.app.vault.getMarkdownFiles();
		
		for (const file of markdownFiles) {
			const filePath = file.path;
			
			// Skip if already checked in memory
			if (this.plugin.timeData.has(filePath)) {
				continue;
			}
			
			// Load entries from frontmatter
			await this.plugin.loadEntriesFromFrontmatter(filePath);
			
			// Check for today's entries
			const pageData = this.plugin.timeData.get(filePath);
			if (pageData) {
				for (const entry of pageData.entries) {
					if (entry.startTime && entry.startTime >= todayStart && entry.endTime) {
						if (entry.duration > 0) {
							totalTimeToday += entry.duration;
							
							// Get project for this entry
							const project = await this.plugin.getProjectFromFrontmatter(filePath);
							const projectName = project || 'No Project';
							
							const currentTime = projectTimes.get(projectName) || 0;
							projectTimes.set(projectName, currentTime + entry.duration);
						}
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
		containerEl.createEl('h2', { text: 'Lapse Settings' });

		new Setting(containerEl)
			.setName('Show seconds')
			.setDesc('Display seconds in timer')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showSeconds)
				.onChange(async (value) => {
					this.plugin.settings.showSeconds = value;
					await this.plugin.saveSettings();
				}));

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
			.setName('Time Adjust Minutes')
			.setDesc('Number of minutes to adjust start time when using << or >> buttons')
			.addText(text => text
				.setPlaceholder('5')
				.setValue(this.plugin.settings.timeAdjustMinutes.toString())
				.onChange(async (value) => {
					const numValue = parseInt(value) || 5;
					this.plugin.settings.timeAdjustMinutes = numValue;
					await this.plugin.saveSettings();
				}));
	}
}

class LapseReportsView extends ItemView {
	plugin: LapsePlugin;
	period: 'daily' | 'weekly' | 'monthly' = 'daily';
	groupBy: 'note' | 'project' | 'date' = 'note';

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

		// Header with period tabs
		const header = container.createDiv({ cls: 'lapse-reports-header' });
		
		// Period tabs
		const tabsContainer = header.createDiv({ cls: 'lapse-reports-tabs' });
		const dailyTab = tabsContainer.createEl('button', { text: 'Daily', cls: 'lapse-reports-tab' });
		const weeklyTab = tabsContainer.createEl('button', { text: 'Weekly', cls: 'lapse-reports-tab' });
		const monthlyTab = tabsContainer.createEl('button', { text: 'Monthly', cls: 'lapse-reports-tab' });

		// Update active tab
		const updateTabs = () => {
			[dailyTab, weeklyTab, monthlyTab].forEach(tab => tab.removeClass('is-active'));
			if (this.period === 'daily') dailyTab.addClass('is-active');
			if (this.period === 'weekly') weeklyTab.addClass('is-active');
			if (this.period === 'monthly') monthlyTab.addClass('is-active');
		};

		dailyTab.onclick = async () => {
			this.period = 'daily';
			updateTabs();
			await this.render();
		};

		weeklyTab.onclick = async () => {
			this.period = 'weekly';
			updateTabs();
			await this.render();
		};

		monthlyTab.onclick = async () => {
			this.period = 'monthly';
			updateTabs();
			await this.render();
		};

		updateTabs();

		// Grouping dropdown
		const controlsContainer = header.createDiv({ cls: 'lapse-reports-controls' });
		const groupBySetting = controlsContainer.createDiv({ cls: 'lapse-reports-groupby' });
		groupBySetting.createEl('label', { text: 'Group by: ' });
		const groupBySelect = groupBySetting.createEl('select', { cls: 'lapse-reports-select' });
		groupBySelect.createEl('option', { text: 'Note', value: 'note' });
		groupBySelect.createEl('option', { text: 'Project', value: 'project' });
		groupBySelect.createEl('option', { text: 'Date', value: 'date' });
		groupBySelect.value = this.groupBy;
		groupBySelect.onchange = async () => {
			this.groupBy = groupBySelect.value as 'note' | 'project' | 'date';
			await this.render();
		};

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
		headerRow.createEl('th', { text: this.getGroupByLabel() });
		headerRow.createEl('th', { text: 'Time' });
		headerRow.createEl('th', { text: 'Entries' });

		const tbody = table.createEl('tbody');
		
		// Sort by time descending
		const sortedData = [...data].sort((a, b) => b.totalTime - a.totalTime);

		for (const item of sortedData) {
			const row = tbody.createEl('tr');
			row.createEl('td', { text: item.group });
			row.createEl('td', { text: this.plugin.formatTimeAsHHMMSS(item.totalTime) });
			row.createEl('td', { text: item.entryCount.toString() });
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
			case 'date': return 'Date';
			default: return 'Group';
		}
	}

	async getReportData(): Promise<Array<{ group: string; totalTime: number; entryCount: number }>> {
		// Calculate date range based on period
		const now = new Date();
		let startDate: Date;
		let endDate: Date = new Date(now);

		if (this.period === 'daily') {
			startDate = new Date(now);
			startDate.setHours(0, 0, 0, 0);
		} else if (this.period === 'weekly') {
			startDate = new Date(now);
			const dayOfWeek = startDate.getDay();
			startDate.setDate(startDate.getDate() - dayOfWeek);
			startDate.setHours(0, 0, 0, 0);
		} else { // monthly
			startDate = new Date(now.getFullYear(), now.getMonth(), 1);
			startDate.setHours(0, 0, 0, 0);
		}

		const startTime = startDate.getTime();
		const endTime = endDate.getTime();

		// Collect all entries in the date range
		const entries: Array<{ filePath: string; entry: TimeEntry; project: string | null }> = [];

		// Check all markdown files
		const markdownFiles = this.app.vault.getMarkdownFiles();
		
		for (const file of markdownFiles) {
			const filePath = file.path;
			
			// Load entries from frontmatter if not in memory
			if (!this.plugin.timeData.has(filePath)) {
				await this.plugin.loadEntriesFromFrontmatter(filePath);
			}

			const pageData = this.plugin.timeData.get(filePath);
			if (pageData) {
				const project = await this.plugin.getProjectFromFrontmatter(filePath);
				
				for (const entry of pageData.entries) {
					if (entry.startTime && entry.startTime >= startTime && entry.startTime <= endTime) {
						// Only include completed entries or active timers
						if (entry.endTime || (entry.startTime && !entry.endTime)) {
							entries.push({ filePath, entry, project });
						}
					}
				}
			}
		}

		// Group entries
		const grouped = new Map<string, { totalTime: number; entryCount: number }>();

		for (const { filePath, entry, project } of entries) {
			let groupKey: string;

			if (this.groupBy === 'note') {
				const file = this.app.vault.getAbstractFileByPath(filePath);
				groupKey = file && file instanceof TFile ? file.basename : filePath;
			} else if (this.groupBy === 'project') {
				groupKey = project || 'No Project';
			} else { // date
				const date = new Date(entry.startTime!);
				if (this.period === 'daily') {
					groupKey = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
				} else if (this.period === 'weekly') {
					const weekStart = new Date(date);
					weekStart.setDate(date.getDate() - date.getDay());
					groupKey = `Week of ${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
				} else {
					groupKey = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
				}
			}

			const entryDuration = entry.endTime 
				? entry.duration 
				: entry.duration + (Date.now() - entry.startTime!);

			if (!grouped.has(groupKey)) {
				grouped.set(groupKey, { totalTime: 0, entryCount: 0 });
			}

			const group = grouped.get(groupKey)!;
			group.totalTime += entryDuration;
			group.entryCount += 1;
		}

		// Convert to array
		return Array.from(grouped.entries()).map(([group, data]) => ({
			group,
			...data
		}));
	}

	async renderChart(container: HTMLElement, data: Array<{ group: string; totalTime: number }>, totalTime: number) {
		container.empty();
		container.createEl('h4', { text: 'Time Distribution' });

		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'lapse-reports-chart');
		svg.setAttribute('width', '400');
		svg.setAttribute('height', '300');
		svg.setAttribute('viewBox', '0 0 400 300');
		container.appendChild(svg);

		// Bar chart
		const maxTime = Math.max(...data.map(d => d.totalTime));
		const barWidth = 350 / data.length;
		const maxBarHeight = 250;
		const colors = [
			'#4A90E2', '#50C878', '#FF6B6B', '#FFD93D', 
			'#9B59B6', '#E67E22', '#1ABC9C', '#E74C3C'
		];

		data.forEach((item, index) => {
			const barHeight = (item.totalTime / maxTime) * maxBarHeight;
			const x = 25 + index * barWidth;
			const y = 275 - barHeight;

			const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
			rect.setAttribute('x', x.toString());
			rect.setAttribute('y', y.toString());
			rect.setAttribute('width', (barWidth - 2).toString());
			rect.setAttribute('height', barHeight.toString());
			rect.setAttribute('fill', colors[index % colors.length]);
			rect.setAttribute('rx', '2');
			svg.appendChild(rect);

			// Label
			const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
			text.setAttribute('x', (x + barWidth / 2).toString());
			text.setAttribute('y', '290');
			text.setAttribute('text-anchor', 'middle');
			text.setAttribute('font-size', '10');
			text.setAttribute('fill', 'var(--text-muted)');
			text.textContent = item.group.length > 10 ? item.group.substring(0, 10) + '...' : item.group;
			svg.appendChild(text);
		});
	}
}
