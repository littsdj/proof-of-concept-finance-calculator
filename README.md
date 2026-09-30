# proof-of-concept-finance-calculator
This is a proof of concept calculator that shows how easy it is to get some AI slop to create a front-end that can do some stuff and deploy.

## Horizon — retirement projection

A static, front-end-only retirement calculator. Enter your age, income, savings rate, account balances (Roth / traditional / taxable), big expenses, and a few assumptions; it projects every year to the end of your plan and draws:

- a scroll-scrubbed net-worth chart (scroll to move through time)
- contributions vs. market growth, with the crossover age
- income vs. amount saved
- account tax mix at retirement
- retirement drawdown, milestones, and a full year-by-year table

Everything runs in the browser. No build step, no backend.

**For entertainment only.** This app should not be used as investment or retirement advice.

### Run it

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

### Deploy

Any static host works: GitHub Pages, Netlify, Vercel, Cloudflare Pages. Point it at the repo root.

### Files

- `index.html`: markup
- `styles.css`: design tokens, light/dark themes, layout, scroll reveals
- `app.js`: the simulation model, D3 charts, and scroll choreography
