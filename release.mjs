#!/usr/bin/env node

/**
 * Release Script for Obsidian Lapse Tracker
 * 
 * This script automates the release process:
 * 1. Bumps the patch version (e.g., 0.1.7 -> 0.1.8)
 * 2. Updates manifest.json, versions.json, and package.json
 * 3. Builds the project
 * 4. Commits the version bump
 * 5. Creates a git tag
 * 6. Pushes to GitHub
 * 7. Creates a GitHub release with assets
 * 
 * Usage:
 *   node release.mjs              # Auto bump patch version
 *   node release.mjs 0.2.0        # Set specific version
 *   node release.mjs --minor      # Bump minor version
 *   node release.mjs --major      # Bump major version
 * 
 * Requirements:
 *   - GitHub CLI (gh) must be installed and authenticated
 *   - Git must be configured with push access
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import * as readline from "readline";

// Parse command line arguments
const args = process.argv.slice(2);
let bumpType = "patch"; // default
let specificVersion = null;

if (args.length > 0) {
  if (args[0] === "--minor") {
    bumpType = "minor";
  } else if (args[0] === "--major") {
    bumpType = "major";
  } else if (args[0] === "--patch") {
    bumpType = "patch";
  } else if (args[0].match(/^\d+\.\d+\.\d+$/)) {
    specificVersion = args[0];
  } else if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
Usage: node release.mjs [options]

Options:
  (no args)     Bump patch version (e.g., 0.1.7 -> 0.1.8)
  --patch       Bump patch version (same as no args)
  --minor       Bump minor version (e.g., 0.1.7 -> 0.2.0)
  --major       Bump major version (e.g., 0.1.7 -> 1.0.0)
  X.Y.Z         Set specific version (e.g., 0.2.0)
  --help, -h    Show this help message

Examples:
  node release.mjs              # 0.1.7 -> 0.1.8
  node release.mjs --minor      # 0.1.7 -> 0.2.0
  node release.mjs 1.0.0        # Set to 1.0.0
`);
    process.exit(0);
  }
}

// Helper to run commands
function run(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: options.silent ? "pipe" : "inherit", ...options });
  } catch (error) {
    if (!options.ignoreError) {
      console.error(`❌ Command failed: ${cmd}`);
      console.error(error.message);
      process.exit(1);
    }
    return null;
  }
}

// Helper to run commands and capture output
function runCapture(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: "pipe" }).trim();
  } catch (error) {
    return null;
  }
}

// Prompt for confirmation
async function confirm(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  return new Promise((resolve) => {
    rl.question(question + " (y/N): ", (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

// Bump version helper
function bumpVersion(version, type) {
  const parts = version.split(".").map(Number);
  
  switch (type) {
    case "major":
      return `${parts[0] + 1}.0.0`;
    case "minor":
      return `${parts[0]}.${parts[1] + 1}.0`;
    case "patch":
    default:
      return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
}

async function main() {
  console.log("🚀 Obsidian Lapse Tracker Release Script\n");
  
  // Check prerequisites
  console.log("📋 Checking prerequisites...");
  
  // Check for gh CLI
  const ghVersion = runCapture("gh --version");
  if (!ghVersion) {
    console.error("❌ GitHub CLI (gh) is not installed.");
    console.error("   Install it from: https://cli.github.com/");
    process.exit(1);
  }
  console.log("   ✓ GitHub CLI found");
  
  // Check gh auth status
  const authStatus = runCapture("gh auth status 2>&1");
  if (!authStatus || authStatus.includes("not logged")) {
    console.error("❌ GitHub CLI is not authenticated.");
    console.error("   Run: gh auth login");
    process.exit(1);
  }
  console.log("   ✓ GitHub CLI authenticated");
  
  // Check for uncommitted changes
  const gitStatus = runCapture("git status --porcelain");
  if (gitStatus && gitStatus.length > 0) {
    console.warn("\n⚠️  Warning: You have uncommitted changes:");
    console.log(gitStatus);
    const proceed = await confirm("\nProceed anyway?");
    if (!proceed) {
      console.log("Aborted.");
      process.exit(0);
    }
  }
  
  // Read current version from manifest.json
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  const currentVersion = manifest.version;
  console.log(`\n📌 Current version: ${currentVersion}`);
  
  // Calculate new version
  const newVersion = specificVersion || bumpVersion(currentVersion, bumpType);
  console.log(`📌 New version: ${newVersion}`);
  
  // Confirm
  const confirmed = await confirm(`\nRelease version ${newVersion}?`);
  if (!confirmed) {
    console.log("Aborted.");
    process.exit(0);
  }
  
  console.log("\n" + "=".repeat(50));
  
  // Step 1: Update versions
  console.log("\n📝 Step 1: Updating version files...");
  
  // Update manifest.json
  manifest.version = newVersion;
  writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");
  console.log("   ✓ Updated manifest.json");
  
  // Update versions.json
  const versions = JSON.parse(readFileSync("versions.json", "utf8"));
  versions[newVersion] = manifest.minAppVersion;
  writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");
  console.log("   ✓ Updated versions.json");
  
  // Update package.json
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  packageJson.version = newVersion;
  writeFileSync("package.json", JSON.stringify(packageJson, null, "  ") + "\n");
  console.log("   ✓ Updated package.json");
  
  // Step 2: Build
  console.log("\n🔨 Step 2: Building project...");
  run("npm run build");
  console.log("   ✓ Build complete");
  
  // Verify build artifacts exist
  const requiredFiles = ["main.js", "manifest.json", "styles.css"];
  for (const file of requiredFiles) {
    if (!existsSync(file)) {
      console.error(`❌ Required file missing: ${file}`);
      process.exit(1);
    }
  }
  console.log("   ✓ All release files present");
  
  // Step 3: Git commit
  console.log("\n📦 Step 3: Committing changes...");
  run("git add manifest.json versions.json package.json");
  run(`git commit -m "Release ${newVersion}"`);
  console.log("   ✓ Changes committed");
  
  // Step 4: Create tag
  console.log("\n🏷️  Step 4: Creating git tag...");
  run(`git tag -a ${newVersion} -m "Release ${newVersion}"`);
  console.log(`   ✓ Tag ${newVersion} created`);
  
  // Step 5: Push to GitHub
  console.log("\n⬆️  Step 5: Pushing to GitHub...");
  run("git push");
  run("git push --tags");
  console.log("   ✓ Pushed to GitHub");
  
  // Step 6: Create GitHub release
  console.log("\n🎉 Step 6: Creating GitHub release...");
  
  // Generate release notes
  const releaseNotes = `## Lapse Tracker v${newVersion}

### Changes
- Bug fixes and improvements

### Installation
1. Download the release files below
2. Copy \`main.js\`, \`manifest.json\`, and \`styles.css\` to your vault's \`.obsidian/plugins/lapse-tracker/\` folder
3. Reload Obsidian and enable the plugin

### BRAT Installation
You can also install via BRAT using this repository URL.
`;
  
  // Write temp release notes file
  writeFileSync(".release-notes.md", releaseNotes);
  
  // Create release with gh CLI
  try {
    run(`gh release create ${newVersion} main.js manifest.json styles.css --title "v${newVersion}" --notes-file .release-notes.md`);
    console.log("   ✓ GitHub release created");
  } finally {
    // Clean up temp file
    try {
      run("rm -f .release-notes.md", { silent: true, ignoreError: true });
    } catch (e) {
      // Ignore
    }
  }
  
  console.log("\n" + "=".repeat(50));
  console.log(`\n✅ Release ${newVersion} complete!`);
  
  // Get repo URL from git remote
  const remoteUrl = runCapture("git remote get-url origin") || "";
  const repoMatch = remoteUrl.match(/github\.com[:/](.+?)(\.git)?$/);
  const repoPath = repoMatch ? repoMatch[1].replace(/\.git$/, "") : "your-repo";
  console.log(`\n🔗 View release: https://github.com/${repoPath}/releases/tag/${newVersion}`);
}

main().catch((err) => {
  console.error("❌ Release failed:", err);
  process.exit(1);
});

