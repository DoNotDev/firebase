# @donotdev/firebase

Firebase utilities for DoNotDev

## Installation

### One-Time Setup (Per Project/Monorepo)

**Step 1: Create Personal Access Token**

Create a GitHub Personal Access Token with `read:packages` scope (create once, reuse forever across unlimited projects):
1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token with `read:packages` scope
3. Copy the token (save it securely - you'll use this same token for all your projects)

**Step 2: Configure .npmrc**

Create `.npmrc` in your project root (copy this file to each new project/monorepo, reuse the same PAT):

```bash
@donotdev:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_YourPersonalAccessToken
```

Replace `ghp_YourPersonalAccessToken` with your actual token. You can copy this `.npmrc` file to any new project/monorepo.

### Install Package

**If using `dndev init`:** Your `package.json` with the correct dependencies will be scaffolded, so you just need to run `bun install`.

**If adding to an existing project:**

```bash
bun add @donotdev/firebase
# or
npm install @donotdev/firebase
```

**Note:** Once PAT and `.npmrc` are set up, you can install any `@donotdev/*` package without repeating these steps.

**Note:** This is a private package. You need to be a member of the DoNotDev community to access it.

## Documentation

Visit [donotdev.com](https://donotdev.com) for full showcase.
Visit [docs.donotdev.com](https://docs.donotdev.com) for full documentation.

## Issues & Feedback

This repository is for **issues and feedback only**. 

- [Report a bug](https://github.com/donotdev/firebase/issues/new?template=bug_report.md)
- [Request a feature](https://github.com/donotdev/firebase/issues/new?template=feature_request.md)

**Source code is private.** All development happens in the private monorepo. Issues reported here will be addressed by the maintainers.

## License

Commercial © DoNotDev

---

**This is an issue-only repository.** Source code is maintained in a private monorepo.

