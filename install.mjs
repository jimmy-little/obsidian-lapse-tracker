import { mkdir, copyFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const VAULT_PATH = join(homedir(), 'Library/Mobile Documents/iCloud~md~obsidian/Documents/JimmyOS');
const PLUGIN_DIR = join(VAULT_PATH, '.obsidian', 'plugins', 'lapse-tracker');
const PROJECT_DIR = process.cwd();

const filesToCopy = ['main.js', 'manifest.json', 'styles.css'];

async function install() {
	try {
		// Create plugin directory if it doesn't exist
		if (!existsSync(PLUGIN_DIR)) {
			await mkdir(PLUGIN_DIR, { recursive: true });
			console.log(`Created plugin directory: ${PLUGIN_DIR}`);
		}

		// Copy files
		for (const file of filesToCopy) {
			const src = join(PROJECT_DIR, file);
			const dest = join(PLUGIN_DIR, file);
			
			if (existsSync(src)) {
				await copyFile(src, dest);
				console.log(`✓ Copied ${file}`);
			} else {
				console.warn(`⚠ Warning: ${file} not found, skipping...`);
			}
		}

		console.log('\n✅ Plugin installed successfully!');
		console.log('   Reload Obsidian to see the changes.');
	} catch (error) {
		console.error('❌ Error installing plugin:', error);
		process.exit(1);
	}
}

install();

