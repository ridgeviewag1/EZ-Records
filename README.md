# EZ Records — offline herbicide application records

EZ Records is a Progressive Web App (PWA) for logging herbicide applications in the field. It runs in a phone's browser, installs to the home screen like an app, and works with no signal. There is nothing to compile and no app store needed.

## Features
- Record date/time, farm, field, crop, acres, herbicide product, rate and unit, applicator, wind, and notes
- Location for each record: use the phone's GPS, or pick the spot on a satellite map
- **Farms & fields**: save each field's location once, or outline its boundary on the map. The app calculates the acres. New records for that farm and field then fill in the location and acres automatically.
- **Google Maps**: every record and saved field has *Open in Google Maps* and *Directions* buttons
- Search, view, edit, and delete records
- Remembers farms, fields, products and other entries you've typed before, so they're suggested next time
- **Print / save as PDF**: a printable table of all records, or just those matching your search
- **Export spreadsheet (CSV)**: opens in Excel or Google Sheets
- **Backup and restore**: download a backup file, then restore it on the same or a new phone

## Your data
Records are stored **only on the device**, in the browser's offline storage (IndexedDB). Nothing is sent to a server. That also means:
- Clearing the browser's site data, uninstalling the app, or losing the phone erases records that haven't been backed up.
- Use **Download backup** from the ⋮ menu regularly and keep the file somewhere safe (email, Google Drive, OneDrive). The app reminds you when a backup is overdue.
- On iPhone, install the app to the Home Screen. Safari can clear storage for websites that haven't been visited in a while, and installed apps are protected from that.

## Maps
The in-app map uses [Leaflet](https://leafletjs.com) with Esri satellite imagery and OpenStreetMap street maps, so no Google API key or billing account is needed. Leaflet loads from unpkg.com the first time a map opens and is then cached. Map imagery needs a signal, but GPS, saved fields, and everything else work offline. Outlined acres are calculated from the boundary you draw, so they're only as accurate as the outline.

## Files
| File | Purpose |
|---|---|
| `index.html` | Page layout |
| `styles.css` | Look and print layout |
| `app.js` | App logic and offline database |
| `sw.js` | Service worker that makes the app work offline |
| `manifest.webmanifest` | App name, icons, and colors for installing |
| `icon-*.png` | App icons |

## Hosting
The app must be served over **HTTPS** to install and work offline. Any static host works, for example:
- **GitHub Pages**: Settings → Pages → deploy from the `main` branch, `/ (root)` folder. On a free GitHub plan the repository must be public; your records stay private on each phone either way.
- **Netlify** or **Cloudflare Pages**: connect this repository, leave the build command empty, publish directory `/`. These work with private repositories.

## Installing on a phone
- **Android (Chrome):** open the site, then tap ⋮ → *Install app* (or *Add to Home screen*).
- **iPhone (Safari):** open the site, tap Share → *Add to Home Screen*.

## Updating the app
After changing any file, increase `VERSION` in `sw.js` (for example `ez-records-v3`). Phones pick up the new version the next time they open the app online.

## Testing on a computer
From this folder run `python -m http.server 8000`, then open http://localhost:8000.

## App stores later
This app can be wrapped for Google Play (PWABuilder / Trusted Web Activity) or for both stores with Capacitor, reusing this code.

## Disclaimer
EZ Records is not a compliance-certified application. Review product labels and applicable federal and state recordkeeping rules before relying on these records for compliance.

The original Flutter starter is preserved in this repository's commit history.
