import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, MarkdownPostProcessorContext, TFile, setIcon } from 'obsidian';

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
	timeAdjustMinutes: 5
}

interface TimeEntry {
	id: string;
	label: string;
	startTime: number | null;
	endTime: number | null;
	duration: number;
	isPaused: boolean;
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
								isPaused: false
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
								isPaused: false
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
					isPaused: false
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
				return file.basename || 'Untitled timer';
			}
			return 'Untitled timer';
		}
		
		return 'Untitled timer';
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

		// Buttons container with "Today" label below
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
		
		// Today label under buttons
		const todayLabel = buttonsContainer.createDiv({ cls: 'lapse-today-label' });

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

		// Collapsible panel for table
		const panel = container.createDiv({ cls: 'lapse-panel' });
		panel.style.display = 'none'; // Start collapsed

		// Table
		const table = panel.createEl('table', { cls: 'lapse-table' });
		
		// Table header
		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		headerRow.createEl('th', { text: 'Entry' });
		headerRow.createEl('th', { text: 'Start' });
		headerRow.createEl('th', { text: 'End' });
		headerRow.createEl('th', { text: 'Duration' });
		headerRow.createEl('th', { text: 'Actions' });

		// Table body
		const tbody = table.createEl('tbody', { cls: 'lapse-table-body' });

		// Render all entries
		this.renderTableRows(tbody, pageData.entries, filePath, labelDisplay, labelInput);

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
				this.renderTableRows(tbody, pageData.entries, filePath, labelDisplay, labelInput);

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
					isPaused: false
				};
				pageData.entries.push(newEntry);

				// Start update interval
				if (!updateInterval) {
					updateInterval = window.setInterval(updateDisplays, 1000);
				}

				// Update frontmatter
				await this.updateFrontmatter(filePath);

				// Update UI - convert input to display when timer starts
				if (labelInput) {
					const labelText = labelInput.value;
					labelInput.remove();
					labelDisplay = inputContainer.createEl('div', {
						text: labelText,
						cls: 'lapse-label-display-running'
					});
					labelInput = null;
				} else if (labelDisplay) {
					// Update existing display - replace with new element with correct class
					const labelText = labelDisplay.textContent || label;
					labelDisplay.remove();
					labelDisplay = inputContainer.createEl('div', {
						text: labelText,
						cls: 'lapse-label-display-running'
					});
				}
				setIcon(playStopBtn, 'square');
				updateDisplays(); // Update displays immediately
				this.renderTableRows(tbody, pageData.entries, filePath, labelDisplay, labelInput);

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
				isPaused: false
			};
			pageData.entries.push(newEntry);
			await this.updateFrontmatter(filePath);
			this.renderTableRows(tbody, pageData.entries, filePath, labelDisplay, labelInput);
		};
	}

	renderTableRows(tbody: HTMLElement, entries: TimeEntry[], filePath: string, labelDisplay?: HTMLElement, labelInput?: HTMLInputElement | null) {
		tbody.empty();

		entries.forEach((entry, index) => {
			const row = tbody.createEl('tr', { cls: 'lapse-table-row' });
			
			// Entry (label) cell
			const labelCell = row.createEl('td', { cls: 'lapse-cell-label' });
			const entryLabelInput = labelCell.createEl('input', {
				type: 'text',
				value: entry.label,
				cls: 'lapse-input'
			});
			entryLabelInput.readOnly = true;

			// Start cell
			const startCell = row.createEl('td', { cls: 'lapse-cell-start' });
			const startInput = startCell.createEl('input', {
				type: 'datetime-local',
				cls: 'lapse-input'
			});
			if (entry.startTime) {
				const date = new Date(entry.startTime);
				startInput.value = this.formatDateTimeLocal(date);
			}
			startInput.readOnly = true;

			// End cell
			const endCell = row.createEl('td', { cls: 'lapse-cell-end' });
			const endInput = endCell.createEl('input', {
				type: 'datetime-local',
				cls: 'lapse-input'
			});
			if (entry.endTime) {
				const date = new Date(entry.endTime);
				endInput.value = this.formatDateTimeLocal(date);
			}
			endInput.readOnly = true;

			// Duration cell
			const durationCell = row.createEl('td', { cls: 'lapse-cell-duration' });
			const durationInput = durationCell.createEl('input', {
				type: 'text',
				value: this.formatTimeAsHHMMSS(entry.duration),
				cls: 'lapse-input'
			});
			durationInput.readOnly = true;

			// Actions cell
			const actionsCell = row.createEl('td', { cls: 'lapse-cell-actions' });
			const editBtn = actionsCell.createEl('button', { cls: 'lapse-btn-edit' });
			const deleteBtn = actionsCell.createEl('button', { cls: 'lapse-btn-delete' });
			
			// Set icons for buttons
			setIcon(editBtn, 'pencil');
			setIcon(deleteBtn, 'trash');

			let isEditing = false;

			editBtn.onclick = async () => {
				if (!isEditing) {
					// Enable editing (duration is always read-only and calculated)
					entryLabelInput.readOnly = false;
					startInput.readOnly = false;
					endInput.readOnly = false;
					// durationInput is always readOnly - don't change it
					setIcon(editBtn, 'check');
					isEditing = true;
				} else {
					// Save changes
					entry.label = entryLabelInput.value;
					
					const oldStartTime = entry.startTime;
					const oldEndTime = entry.endTime;
					
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

					// Calculate duration from start and end times
					if (entry.startTime && entry.endTime) {
						entry.duration = entry.endTime - entry.startTime;
					} else if (entry.startTime && !entry.endTime) {
						// Active timer - preserve existing duration
						// Don't recalculate
					}

					// Update duration display
					durationInput.value = this.formatTimeAsHHMMSS(entry.duration);

					// Disable editing
					entryLabelInput.readOnly = true;
					startInput.readOnly = true;
					endInput.readOnly = true;
					// durationInput is always readOnly
					setIcon(editBtn, 'pencil');
					isEditing = false;

					// Update action bar label if this is the active timer
					const isActiveTimer = entry.startTime !== null && entry.endTime === null;
					if (isActiveTimer && labelDisplay) {
						if (labelInput) {
							labelInput.value = entry.label;
						} else {
							labelDisplay.setText(entry.label);
						}
					}

					// Update frontmatter
					await this.updateFrontmatter(filePath);
					
					// Refresh the table to show updated duration
					const pageData = this.timeData.get(filePath);
					if (pageData) {
						this.renderTableRows(tbody, pageData.entries, filePath, labelDisplay, labelInput);
					}
				}
			};

			deleteBtn.onclick = async () => {
				const pageData = this.timeData.get(filePath);
				if (pageData) {
					pageData.entries = pageData.entries.filter(e => e.id !== entry.id);
					await this.updateFrontmatter(filePath);
					this.renderTableRows(tbody, pageData.entries, filePath, labelDisplay, labelInput);
				}
			};
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
			duration: Math.floor(entry.duration / 1000)
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
