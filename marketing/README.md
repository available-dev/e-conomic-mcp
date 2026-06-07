# Konteo — marketing landing page

A single, self-contained `index.html` (all CSS inline, zero dependencies, no build
step). Rename by search-replacing `Konteo` in `index.html`.

## Preview locally

Just open the file:

```bash
open marketing/index.html        # macOS
xdg-open marketing/index.html    # Linux
```

…or serve it:

```bash
npx serve marketing
```

## Deploy to Vercel (static, no config)

```bash
cd marketing
vercel            # first run links/creates the project
vercel --prod     # promote to production
```

Vercel auto-detects a static site — no framework, no build command. The whole
page is one file, so it also drops onto Cloudflare Pages, Netlify, GitHub Pages,
or any static host unchanged.

## Notes

- CTAs (`Sign up with Google`, `Get started`) point at `#get-started` / `#` for
  now — wire them to the real app/auth once Phase 1 exists.
- Trademark disclaimer in the footer: Konteo is independent and not affiliated
  with Visma e-conomic.
