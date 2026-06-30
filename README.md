# BookHub

A programmatic SEO multi-tool platform for book readers, built with Jekyll
and deployed on GitHub Pages. Design direction: **Precision White**
(Vercel-inspired, minimal, conversion-optimized).

## Structure

```
bookhub/
├── _config.yml
├── _layouts/
│   ├── default.html
│   └── book.html
├── _includes/
│   ├── header.html
│   └── footer.html
├── _books/                # one file per book → programmatic SEO pages
│   └── atomic-habits.md
├── assets/
│   ├── css/style.css      # Direction B design system
│   └── js/main.js
├── tools/
│   ├── summary.html
│   ├── recommender.html
│   ├── questions.html
│   ├── compare.html
│   ├── reading-list.html
│   ├── timer.html
│   └── search.html
├── index.html
├── Gemfile
└── .github/workflows/deploy.yml
```

## Local setup

```bash
bundle install
bundle exec jekyll serve
```

## Deploy to GitHub Pages

1. Push to a GitHub repo named e.g. `bookhub`
2. Settings → Pages → Source: **GitHub Actions**
3. Every push to `main` auto-builds and deploys

## After deploy — update `_config.yml`

- `url` → your real GitHub Pages / custom domain URL
- `api_url` → your Render backend URL
- `amazon_tag` → your Amazon Associates tracking ID

## Design tokens (from DESIGN.md)

| Token | Value |
|---|---|
| Background | `#ffffff` |
| Foreground | `#171717` |
| Accent | `#ff5b4f` |
| Surface | `#e3ecf6` |
| Muted text | `#4d4d4d` |
| Border | `#eaeaea` |
| Link blue | `#0072f5` |
| Font | Inter |
| Radius | 8px |

## Add a new book (programmatic SEO)

Create `_books/your-book-slug.md`:

```yaml
---
layout: book
title: "Book Title"
author: "Author Name"
genre: "Genre"
year: 2020
pages: 300
amazon_isbn: "XXXXXXXXXX"
description: "Short description."
---
```

## Backend

Tools call a separate FastAPI backend on Render (Gemini API).
Set `api_url` in `_config.yml` once deployed.
