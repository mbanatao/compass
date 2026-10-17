# Pandora Goal Compass

A responsive, browser-based Goal Compass prototype: a personal navigation instrument for priorities, progress, and next actions.

## Features

- Compass-style view showing four goal directions and the difference between current focus and recommended goal.
- Deterministic, weighted priority scoring for Today, This week, and North star horizons.
- Editable goal definitions, success descriptions, next actions, progress, urgency, importance, impact, momentum, evidence confidence, and optional deadlines.
- Temporary, user-directed priority override for the local day.
- Local activity journal and explanation of the scoring model.
- Dark/light themes and responsive mobile layout.
- Local browser persistence through `localStorage`; no credentials, analytics, API keys, or backend connections are required.

## Run locally

Open `index.html` in a modern browser, or serve the repository directory with any static web server.

## Deploy on Vercel

This is a static HTML application. Connect the repository `mbanatao/compass` to Vercel with no build command and the repository root as the output root.

## Important prototype limits

- Starting goal names, scores, and next actions are illustrative. Edit them before relying on recommendations.
- Data stays in the browser/device that created it. There is no account, cloud sync, Supabase, or Pandora Memory integration in this version.
- Activity is user-entered; the app does not automatically observe projects, calendars, or phone sensors.
- The compass bearing is a visual comparison between goal directions. It is not GPS or a measurement of real-world behavior.

## Scoring

Each active goal is scored deterministically from five editable 1–5 factors: importance, urgency, impact, momentum, and evidence confidence. The weights depend on the selected planning horizon. An optional near-term deadline raises effective urgency. Paused and completed goals are excluded from the recommendation. A valid manual priority overrides the calculated winner for the current local day in Today mode, while the calculated score remains visible.
