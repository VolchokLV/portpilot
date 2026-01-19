# Plan: Release PortPilot as Open Source

## Recommendation: Both GitHub + npm Package

**Use BOTH GitHub and npm** - they work together and serve different purposes:

### Why GitHub?
- Source code hosting and version control
- Issue tracking and bug reports
- Pull requests and community contributions
- Documentation (README, wiki, GitHub Pages)
- Community engagement (stars, forks, discussions)
- CI/CD integration (GitHub Actions)
- Release management and changelogs

### Why npm Package?
- Easy installation: `npm install -g portpilot`
- Automatic dependency management
- Version distribution and updates
- Discoverability on npmjs.com
- Integration with Node.js ecosystem
- npm scripts can auto-build before publish

### How They Work Together:
- **GitHub** = Source of truth for code
- **npm** = Distribution mechanism for end users
- package.json links to GitHub repo
- GitHub releases can trigger npm publishing
- Users install via npm, contribute via GitHub

## Current Status: 75% Ready

### Already Complete
- TypeScript build system working
- CLI entry points configured (`portpilot` and `pp`)
- Comprehensive README with examples
- All dependencies properly listed
- ES Modules configured correctly

### Must Fix Before Publishing

#### 1. Create LICENSE File
**Priority: CRITICAL**
- package.json says `"license": "MIT"` but file doesn't exist
- Required by npm and GitHub

#### 2. Update package.json
**Priority: IMPORTANT**

**Add/Update these fields:**
```json
{
  "author": "Your Name <your.email@example.com>",
  "repository": {
    "type": "git",
    "url": "https://github.com/yourusername/portpilot.git"
  },
  "homepage": "https://github.com/yourusername/portpilot#readme",
  "bugs": {
    "url": "https://github.com/yourusername/portpilot/issues"
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "prepublishOnly": "npm run build"
  }
}
```

#### 3. Create .npmignore
**Priority: IMPORTANT**

```
# Source files (don't publish TypeScript source)
src/
tsconfig.json

# Development files
.gitignore
.vscode/
.idea/
*.log
coverage/
.env
.env.local

# Git files
.git/
.github/

# Documentation for development (keep README.md)
CLAUDE.md
CLAUDE_HANDOFF.md
RELEASE_PLAN.md

# Build artifacts we don't need
*.tsbuildinfo
```

#### 4. Test Package Locally
**Priority: CRITICAL**

```bash
npm run build
npm pack
npm install -g ./portpilot-0.1.0.tgz
portpilot --help
npm uninstall -g portpilot
```

## Publishing Steps

### Step 1: Prepare npm Account
```bash
npm login
```

### Step 2: Publish to npm
```bash
npm run build
npm publish
```

### Step 3: Create GitHub Repository
```bash
git init
git remote add origin https://github.com/yourusername/portpilot.git
git add .
git commit -m "Initial release: v0.1.0"
git push -u origin main
```

### Step 4: Create GitHub Release
1. Go to GitHub repo → Releases → Create new release
2. Tag: `v0.1.0`
3. Title: `v0.1.0 - Initial Release`

## Version Strategy

- Start at `0.1.0` (beta quality)
- **MAJOR** (1.x.x): Breaking changes
- **MINOR** (x.1.x): New features, backwards compatible
- **PATCH** (x.x.1): Bug fixes

## Post-Publishing Checklist

- [ ] Verify package appears on npmjs.com
- [ ] Test installation: `npm install -g portpilot@latest`
- [ ] Check package page shows README correctly
- [ ] Add GitHub topics (nodejs, cli, development, proxy)
- [ ] Add badges to README (npm version, downloads, license)
- [ ] Create CHANGELOG.md
