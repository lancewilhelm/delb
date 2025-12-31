# Known Issues

This document tracks known bugs, quirks, and workarounds in the project.

---

## Tailwind Arbitrary Values Not Generating Due to Path Collision

### Summary
Tailwind CSS v4 arbitrary value utilities fail to generate when there is a directory name collision between the project root storage directory and an `app/pages/` route directory.

### Symptoms
- Arbitrary Tailwind utilities (e.g., `grid-cols-[110px_1fr]`, `w-[200px]`) fail to generate in the final CSS
- Standard Tailwind utilities (e.g., `grid-cols-2`, `w-20`, `bg-red-500`) work correctly in the same file
- The issue appears to be path-specific, affecting only certain route files
- HMR (Hot Module Replacement) may not properly trigger rebuilds for the affected files

### Root Cause
**Path collision between root-level storage directory and route directory.**

When a directory exists at the project root (e.g., `books/`) AND a route directory exists with the same name (e.g., `app/pages/books/`), Vite's file watcher and/or Tailwind v4's content scanner becomes confused about which path to track, causing:
- Incomplete or failed content scanning for arbitrary values
- HMR cache corruption or invalidation failures
- File watcher glitches that prevent proper rebuilds

### Timeline / How We Discovered This
1. **Initial state**: Books stored in `data/books/` - everything worked fine
2. **Change made**: Moved book storage from `data/books/` to root-level `books/` directory (to prepare for Docker)
3. **Bug appeared**: Immediately after the move, `app/pages/books/[id].vue` stopped generating arbitrary Tailwind utilities
4. **Debugging**: Spent significant time checking syntax, cache, HMR, Tailwind config - all correct
5. **Accidental discovery**: Renamed route from `app/pages/books/` to `app/pages/book/` → bug instantly resolved
6. **Confirmation**: The path collision between `books/` (storage) and `app/pages/books/` (routes) was the cause

### Reproduction Steps

To reproduce this bug in a Nuxt 4 + Tailwind v4 + Vite project:

1. Create a directory at project root: `mkdir books`
2. Create a route directory: `mkdir -p app/pages/books`
3. Create a route file: `app/pages/books/[id].vue` with arbitrary Tailwind utilities:
   ```vue
   <template>
     <div class="grid grid-cols-[200px_1fr] gap-4">
       <div>Fixed column</div>
       <div>Flexible column</div>
     </div>
   </template>
   ```
4. Run dev server and navigate to the route
5. Inspect the element in DevTools - the `grid-cols-[200px_1fr]` class will not be in the generated CSS
6. Standard utilities like `grid`, `gap-4` will work correctly

**To confirm the fix:**
- Rename `app/pages/books/` to `app/pages/book/`
- The arbitrary utilities will now generate correctly

### Environment Details
- **Nuxt**: 4.x
- **Tailwind CSS**: v4.x (via `@tailwindcss/vite` plugin)
- **Vite**: Latest (bundled with Nuxt 4)
- **Node**: 18+
- **Package Manager**: pnpm

### Workarounds

**Option 1: Avoid path collisions** (recommended)
- Use different names for storage directories and route directories
- Examples:
  - Storage: `library/` or `book-storage/` instead of `books/`
  - Routes: `app/pages/book/` instead of `app/pages/books/`
- This is the most reliable solution

**Option 2: Use alternative CSS patterns**
- Replace `grid grid-cols-[110px_1fr]` with `flex` + fixed width utilities
- Example: `flex gap-2` with `w-28 shrink-0` on the label and `flex-1` on the content
- Avoids arbitrary values entirely while achieving the same visual result

**Option 3: Add explicit Tailwind config**
- Create a `tailwind.config.ts` with explicit `content` paths and a `safelist` for the needed arbitrary values
- Forces generation but is more manual and defeats the purpose of arbitrary values

### Where to Report

This bug likely exists in one of these projects:

1. **Vite** (https://github.com/vitejs/vite)
   - File watcher and HMR implementation
   - May have issues with similar path patterns

2. **@tailwindcss/vite** (https://github.com/tailwindlabs/tailwindcss/tree/next/packages/%40tailwindcss-vite)
   - Tailwind v4's Vite plugin
   - Content scanner and arbitrary value extraction

3. **Nuxt** (https://github.com/nuxt/nuxt)
   - May be related to how Nuxt integrates Vite and handles route resolution

**Recommended approach**: File an issue with `@tailwindcss/vite` first, as the content scanning is most directly related. Include:
- This reproduction case
- The timeline showing it started after creating the root-level `books/` directory
- Environment details listed above

### Status
**Resolved in this project** - Storage directory renamed to `library/` and routes use `app/pages/book/` to avoid any path collisions.

### Last Updated
January 2025 (when the root cause was identified)

---

## Future Issues

Additional known issues will be documented here as they are discovered.