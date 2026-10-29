# IIT Mies Campus Surveillance

A surveillance-style dashboard for **Illinois Tech's Mies Campus** in
Bronzeville, Chicago. It uses only public data and puts five feeds on one
screen: nearby traffic cameras, the campus Public Safety log, Chicago Police
crime reports, live traffic incidents and crash patterns, and weather/siren
alerts with city service activity.

![IIT Mies Campus Surveillance dashboard: camera grid, watch map, and campus safety, crime, traffic and alert panels](docs/screenshot.jpg)

## What's on the dashboard

| Panel | What it shows | Source | How fresh |
| --- | --- | --- | --- |
| **Cameras** | The 6 IDOT expressway cameras closest to campus. Each updates on its own and shows a Live, Delayed or Offline badge. Click a tile to enlarge it. | Illinois DOT | Every 30 s (IDOT re-captures about every 3 min) |
| **Watch map** | Campus outline, a ½-mile ring, camera pins, crime reports, crashes, and live traffic incidents, each layer toggleable. Click any camera dot to preview it or swap it onto the grid. | All of the below | — |
| **Campus safety log** | Incidents from IIT's daily crime/incident log, filtered to the Mies campus: type, building or street, time, notes, disposition | Illinois Tech Department of Public Safety | Posted each weekday morning |
| **Crime near campus** | Police reports within ½ mile over 30 days, broken down by type and hour of day, with the most recent reports. Click a report to jump the map there. | Chicago Police Department via the City of Chicago Data Portal | About 7 days behind (city policy) |
| **Traffic** | Live congestion, crashes, closures and event traffic within 2 mi, plus crash patterns within ½ mile over 90 days: by hour, injuries, hit-and-runs, and worst streets | Illinois DOT roadway incidents; City of Chicago crash reports | Live (every 2 min); crashes about 1 day behind |
| **Alerts & dispatch** | National Weather Service warnings for campus, which are what trigger the city's outdoor sirens. Also 311 service requests near campus, IIT Public Safety phone numbers, and an IIT Alert sign-up link. | National Weather Service; City of Chicago 311 | Live; 311 same-day |

A severe weather warning also shows as a banner across the top of the page.

### About "dispatch"

Chicago has no public live police or fire dispatch feed. Police radio has been
encrypted since 2024, and the city's 911 dispatch system is internal only.
The dashboard is upfront about this. It shows the closest public signals
(live IDOT incidents and same-day 311 work orders) and links to public
fire/EMS scanner audio instead of making anything up.

## Run it locally

Needs only **Python 3.9 or newer**. There's nothing to install and no build step.

```bash
git clone https://github.com/Dipzinski/iit-public-surveillance.git
cd iit-public-surveillance
python3 server.py
```

Then open http://localhost:8000. To use a different port, run `PORT=9000 python3 server.py`.

## Changing what it watches

Everything location-specific is in [`data/site.json`](data/site.json):

- `center`, `campusOutline`: where the site is and the outline drawn on the map
- `watchRadiusMi`: radius for crime, crash and 311 data (0.5 mi)
- `cameraAreaMi`, `trafficAreaMi`: how far out to look for cameras and live incidents (2 mi)
- `defaultCameras`, `slots`: which cameras fill the grid at first, and how many
- `landmarks`, `contacts`: map labels and emergency phone numbers

## How it works

```
Browser (static/)            server.py + feeds.py              Public sources
  js/main.js     clock  ──►  /api/site        data/site.json
  js/cameras.js  grid   ──►  /api/cameras     IDOT camera list (ArcGIS)
                        ──►  /api/snapshot/id IDOT camera image
  js/panels.js   panels ──►  /api/safety-log  IIT Public Safety RSS
                        ──►  /api/crime       Chicago crimes (Socrata API)
                        ──►  /api/traffic     IDOT incidents (ArcGIS) + Chicago crashes
                        ──►  /api/alerts      NWS alerts API + Chicago 311
  js/map.js      map    ──►  Leaflet + Esri basemap
  js/charts.js   bar and hour charts
```

**Backend.** Uses only the Python standard library.
- `feeds.py` pulls each source and trims it to the area around campus, using
  geographic queries where the API supports them. It summarizes the data
  (counts by type and by hour, top streets) and caches each feed for its own
  time. If a source stops responding, it keeps serving the last good copy.
- The IIT Public Safety log is a blog. Its RSS feed is parsed into
  structured incidents (type, location, time, notes, disposition), and
  incidents from other IIT campuses are dropped.
- `server.py` fetches camera images itself, because IDOT's image server
  rejects requests carrying another site's `Referer`. It relays images only
  for known camera IDs, so it can't be used as an open proxy.

**Frontend.** Plain HTML, CSS and ES modules, with no framework and no build step.
- Text from outside feeds is always inserted as text, never as HTML.
- Camera frames are decoded off-screen before they're shown. A late frame
  is dropped if you've already swapped that tile to another camera.
- One shared clock refreshes each panel on its own schedule, and **Pause**
  stops everything at once.
- Charts are plain HTML with hover tooltips and a hidden table for screen
  readers. Map colors come from a palette checked for color-blind safety, and
  status markers always pair color with an icon and a label.

## Data sources

| Data | Source |
| --- | --- |
| Traffic cameras | [Illinois DOT public traffic camera feed](https://services2.arcgis.com/aIrBD8yn1TDTEXoz/ArcGIS/rest/services/TrafficCamerasTM_Public/FeatureServer/0) |
| Live roadway incidents | [Illinois DOT roadway incidents](https://services2.arcgis.com/aIrBD8yn1TDTEXoz/ArcGIS/rest/services/Illinois_Roadway_Incidents/FeatureServer/0) |
| Campus safety log | [Illinois Tech Department of Public Safety daily logs](https://blogs.iit.edu/public_safety/) |
| Crime reports | [City of Chicago: Crimes – 2001 to Present](https://data.cityofchicago.org/Public-Safety/Crimes-2001-to-Present/ijzp-q8t2) |
| Crash reports | [City of Chicago: Traffic Crashes – Crashes](https://data.cityofchicago.org/Transportation/Traffic-Crashes-Crashes/85ca-t3if) |
| 311 requests | [City of Chicago: 311 Service Requests](https://data.cityofchicago.org/Service-Requests/311-Service-Requests/v6vf-nfxy) |
| Weather alerts | [National Weather Service API](https://www.weather.gov/documentation/services-web-api) |
| City limits | [City of Chicago: Boundaries – City](https://data.cityofchicago.org/resource/qqq8-j68g.geojson) |
| Basemap | Esri World Dark Gray Canvas and © OpenStreetMap contributors |

## Roadmap

- [ ] Notifications when a new campus safety log incident or weather warning appears
- [ ] Trend lines: this month vs. the same month last year for crime and crashes
- [ ] Game-day mode for White Sox home games at nearby Rate Field
- [ ] A more precise campus outline from IIT's facilities map

---

Student project built only from public data. Not affiliated with or endorsed
by Illinois Institute of Technology.
