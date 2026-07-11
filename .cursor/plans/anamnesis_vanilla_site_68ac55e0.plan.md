---
name: Anamnesis vanilla site
overview: "Recreate the 6-page Anamnesis marketing site (running at http://localhost:4322/) inside st-static-site using its vanilla component framework: reuse Header, Footer and FormBuilder, create 6 missing components (Hero, Cards, CallToAction, PageHeader, Prose, DataTable), and assemble the pages under public/templates/SitePages/Anamnesis with DARK/LIGHT/AUTO theming and component-level animations only."
todos:
  - id: components
    content: Create 6 new vanilla components (Hero, Cards, CallToAction, PageHeader, Prose, DataTable) as src SCSS/TS with data-component roots, existing theme variables, and component-level animations (reveal/hover/float, reduced-motion aware); add index/light/dark examples.
    status: completed
  - id: buildscripts
    content: Add build:css/js scripts for the 6 new components to package.json and append them to the build:static-components chain.
    status: completed
  - id: assets
    content: Create Anamnesis/assets and add logo-dark.svg (from exImages/brain-logo.svg) plus a logo-light.svg variant for theme-aware logo swap.
    status: completed
  - id: pages
    content: Author the 6 fully-expanded HTML pages (index, about, features, install, learn, contact) under public/templates/SitePages/Anamnesis using Header/Footer/FormBuilder + new components, porting reference content, with body theme-dark and standard theme/main CSS.
    status: completed
  - id: buildverify
    content: Compile styles + new components to public/, then open each page in the dev server and verify DARK/LIGHT theming and component animations.
    status: completed
isProject: false
---

# Anamnesis vanilla site in st-static-site

Recreate the reference Astro site (`http://localhost:4322/`, source in `/Users/sharadkumar/Documents/SharadTechDigital/TEMP/static-site/src`) as vanilla-component pages in [st-static-site](/Users/sharadkumar/Documents/SharadTechDigital/GIT/st-static-site), reusing existing components and building the missing ones.

## 1. Component comparison (gap analysis)

Reference "components" (Astro/React) mapped to st-static-site vanilla components:

- Navbar (logo swap + nav + theme toggle + mobile menu) -> REUSE `Header` (already has dark/light/auto toggle + overlay nav)
- Footer -> REUSE `Footer`
- ContactForm (name/email/company/subject/message, validation, AJAX POST) -> REUSE `FormBuilder` (`data-action`/`data-method`/`data-headers`)
- Theme toggle (dark/light/auto) -> built into `Header` (`header.js`)
- Hero (centered logo + title + subtitle + 2 CTAs, gradient bg, entrance + float) -> MISSING -> create `Hero`
- FeatureGrid / generic `.card` grids (Why Anamnesis, Key Features, Dual Viewer, Supported Types, MCP tools, Use Cases, Contact info) -> MISSING -> create `Cards` (icon-glyph / code-label / bullet-list variants)
- CTA band (Ready to get started, Enable AI Tools, Need help) -> MISSING -> create `CallToAction`
- Interior `.page-header` (title + subtitle, gradient bg) -> MISSING -> create `PageHeader`
- `.prose` long-form (About, Learn how-it-works, Install steps, code blocks) -> MISSING -> create `Prose`
- `<table>` (extractor reference, install settings) -> MISSING -> create `DataTable`
- `Reveal` (scroll-reveal wrapper) -> not a component; implemented as per-component IntersectionObserver reveal

Note: existing `Services` (icon+title+desc) could cover feature grids but requires SVG assets; the reference uses unicode glyph icons, so `Cards` (glyph variant) is a closer match and is used instead.

## 2. New components to create

Follow the repo convention: source in `src/static-components/<Name>/` (SCSS + TS), a build script in [package.json](/Users/sharadkumar/Documents/SharadTechDigital/GIT/st-static-site/package.json), compiled output in `public/static-components/<Name>/`, plus `index.html`/`light.html`/`dark.html` examples. All consume the EXISTING theme palette (gold dark / cyan light) from `public/theme/default/theme-variables-*.css` (e.g. `--main-theme-color`, `--standard-primary-site-text-color`, `--standard-secondary-site-text-color`, `--site-body-bg`, `--lead-banner-gradient-*`) and reuse `main.css` button utilities (`.cta-pill`, `.cta-button`, `.btn-theme-auto`, `.btn-icon-only`). Each sets `data-component` on its root and respects `prefers-reduced-motion`.

- `Hero` — `<section class="hero" data-component="hero">` with `.hero__bg`, dual `.hero__logo` (light/dark), `.hero__title`, `.hero__subtitle`, `.hero__actions` (cta-pill buttons). `hero.ts`: add `.is-visible` on load for staggered entrance; CSS keyframe float on logo.
- `Cards` — `<section class="cards cards--with-bg" data-component="cards">` with optional `.cards__header` (`.cards__title`/`.cards__subtitle`), `.cards__grid cards__grid--2|--3|--4`, `.cards__item` (`.cards__item-icon` glyph OR `<code>` label, `.cards__item-title`, `.cards__item-desc`, optional `.cards__item-list` `<ul>`). `cards.ts`: IntersectionObserver staggered reveal (per-item `--i` delay); CSS hover lift.
- `CallToAction` — `<section class="call-to-action call-to-action--with-bg" data-component="call-to-action">` with `.call-to-action__title`, `.call-to-action__subtitle`, `.call-to-action__actions`. `call-to-action.ts`: reveal on scroll.
- `PageHeader` — `<section class="page-header" data-component="page-header">` with `.page-header__title` (h1), `.page-header__subtitle`; subtle gradient bg from `--lead-banner-gradient-*`. CSS entrance animation (minimal/no JS).
- `Prose` — `<article class="prose" data-component="prose">` styling nested `h2/h3/p/ul/ol/a/strong/code/pre`; theme-aware code/pre backgrounds. `prose.ts`: reveal child blocks on scroll.
- `DataTable` — `<section class="data-table data-table--with-bg" data-component="data-table">` with `.data-table__scroll` wrapping `<table class="data-table__table">` (thead/tbody); horizontal scroll on mobile, row hover highlight. `data-table.ts`: reveal on scroll.

## 3. Assets & branding

- Create `public/templates/SitePages/Anamnesis/assets/`; copy [exImages/brain-logo.svg](/Users/sharadkumar/Documents/SharadTechDigital/GIT/st-anamnesis-vscode-extension/exImages/brain-logo.svg) as `logo-dark.svg` (cream mark on dark) and add a `logo-light.svg` variant (dark mark for light theme). Used in Header/Hero/Footer dual-logo markup (show/hide by `.theme-dark`/`.theme-light`).

## 4. Pages (under public/templates/SitePages/Anamnesis)

Author as fully-expanded HTML following the [DemoSite pattern](/Users/sharadkumar/Documents/SharadTechDigital/GIT/st-static-site/public/templates/SitePages/DemoSite/index.html) (explicit per-component `<link>`/`<script>`, `<body class="theme-dark">`, standard head: `theme-variables-dark.css`, `theme-variables-light.css`, `main.css`). Nav links: Home/About/Features/Install/Learn/Contact. Content is ported verbatim from the reference pages.

- `index.html` — Header, `Hero`, `Cards` (Why Anamnesis, 3), `Cards` (Key Features, 8 glyph cards), `CallToAction` (Ready to get started), Footer
- `about.html` — Header, `PageHeader`, `Prose` (What is / Problem / Unified Graph / Mission), Footer
- `features.html` — Header, `PageHeader`, `Cards` (Core Capabilities, 8), `Cards` (Dual Viewer, 2), `Cards` (Supported Types, 4 with lists), `CallToAction` (Enable AI Tools), Footer
- `install.html` — Header, `PageHeader`, `Prose` (install steps + code blocks), `DataTable` (settings), `CallToAction` (Need help), Footer
- `learn.html` — Header, `PageHeader`, `Prose` (How it works + Quick start), `DataTable` (Extractor reference), `Cards` (MCP tools, 9 code-label), `Cards` (Use cases, 4), Footer
- `contact.html` — Header, `PageHeader`, `FormBuilder` (contact fields, `data-action` placeholder), `Cards` (Website/GitHub/Publisher, 3), Footer

## 5. Build & verify

- Add `build:hero*`, `build:cards*`, `build:calltoaction*`, `build:pageheader*`, `build:prose*`, `build:datatable*` scripts to `package.json` and append them to the `build:static-components` chain.
- Run `npm run build:styles` and the new component builds to compile SCSS/TS into `public/static-components/<Name>/`.
- Open the pages via the st-static-site dev server at `/public/templates/SitePages/Anamnesis/index.html`; verify all 6 pages in DARK and LIGHT (Header toggle), confirm component-level animations fire and no page-level animations exist.

## Theming note

Per your choice, components use st-static-site's EXISTING default palette (gold accent in dark, cyan accent in light) rather than the reference's gold-in-both, so visuals will match st-static-site branding while structure/content matches the reference.