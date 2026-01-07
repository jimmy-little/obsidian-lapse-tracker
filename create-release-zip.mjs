import { execSync } from "child_process";
import { readFileSync, existsSync, statSync } from "fs";

// Read version from manifest.json
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const version = manifest.version;

// Required files for Obsidian plugin
const requiredFiles = ["main.js", "manifest.json", "styles.css"];

// Check if all required files exist
for (const file of requiredFiles) {
  if (!existsSync(file)) {
    console.error(`❌ Error: ${file} not found. Please run 'npm run build' first.`);
    process.exit(1);
  }
}

// Build the plugin
console.log("📦 Building plugin...");
try {
  execSync("npm run build", { stdio: "inherit" });
} catch (error) {
  console.error("❌ Build failed:", error.message);
  process.exit(1);
}

// Create zip file using system zip command
const zipFileName = `lapse-tracker-${version}.zip`;

// Remove old zip if it exists
try {
  execSync(`rm -f ${zipFileName}`);
} catch (e) {
  // Ignore if file doesn't exist
}

console.log(`\n📦 Creating release zip: ${zipFileName}`);

// Create zip with files at root level (not in a folder)
// Use -j to junk paths and store files at root
try {
  execSync(`zip -j ${zipFileName} ${requiredFiles.join(" ")}`, { stdio: "inherit" });
  
  const stats = statSync(zipFileName);
  console.log(`\n✅ Created release zip: ${zipFileName}`);
  console.log(`   Size: ${(stats.size / 1024).toFixed(2)} KB`);
  console.log(`\n📤 To upload to GitHub:`);
  console.log(`   1. Go to https://github.com/jimmy-little/obsidian-lapse-tracker/releases`);
  console.log(`   2. Click "Edit" on your release`);
  console.log(`   3. Drag and drop ${zipFileName} to attach it`);
  console.log(`   4. Save the release`);
  console.log(`\n   BRAT will then be able to find manifest.json!`);
} catch (error) {
  console.error("❌ Failed to create zip:", error.message);
  process.exit(1);
}

